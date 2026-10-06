const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadSource } = require("./loadSource.cjs");
const { createHookHarness, deferred } = require("./hookHarness.cjs");

function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...elements(tree.props?.children)];
}

test("context preferences isolate session and pane and reject corrupt stored limits", () => {
  const original = global.localStorage;
  const values = new Map();
  global.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  try {
    const { loadContextOptions, saveContextOptions, defaultContextOptions } = loadSource("src/utils/contextPreferences.ts");
    const options = { ...defaultContextOptions(), summary: "first main", max_context_tokens: 4096 };
    assert.equal(saveContextOptions("first", "main", options), true);
    assert.deepEqual(loadContextOptions("first", "main"), options);
    assert.deepEqual(loadContextOptions("first", "aux"), defaultContextOptions());
    assert.deepEqual(loadContextOptions("second", "main"), defaultContextOptions());
    values.set("billm.context.v1.first.main", JSON.stringify({ max_context_tokens: -1, recent_turns: 0, excluded_message_ids: ["valid", 123] }));
    assert.deepEqual(loadContextOptions("first", "main"), { ...defaultContextOptions(), excluded_message_ids: ["valid"] });
    values.set("billm.context.v1.first.main", "{bad json");
    assert.deepEqual(loadContextOptions("first", "main"), defaultContextOptions());
    global.localStorage.setItem = () => { throw new Error("quota exceeded"); };
    assert.equal(saveContextOptions("first", "main", options), false);
  } finally { global.localStorage = original; }
});

test("context budget can be typed digit by digit and invalid drafts never update the applied budget", () => {
  const host = createHookHarness();
  const applied = [];
  const { ContextNumber } = loadSource("src/components/ContextPanel.tsx", { react: host.react });
  const props = { value: null, min: 128, max: 2_000_000, placeholder: "unlimited", onChange: (value) => applied.push(value) };
  host.mount(ContextNumber, props);
  const input = () => elements(host.current).find((item) => item.type === "input");
  input().props.onChange({ target: { value: "4" } });
  assert.equal(input().props.value, "4");
  assert.equal(input().props["aria-invalid"], true);
  input().props.onChange({ target: { value: "40" } });
  input().props.onChange({ target: { value: "409" } });
  input().props.onChange({ target: { value: "4096" } });
  assert.deepEqual(applied, [409, 4096]);
  host.render({ ...props, value: 4096 });
  input().props.onChange({ target: { value: "-1" } });
  input().props.onBlur();
  assert.equal(input().props.value, "4096");
  input().props.onChange({ target: { value: "" } });
  assert.equal(applied.at(-1), null);
  host.unmount();
});

test("summary merges newer context options, prevents duplicate calls, and aborts on unmount", async () => {
  const original = global.window;
  global.window = { setTimeout: () => 1, clearTimeout() {} };
  const host = createHookHarness();
  const first = deferred();
  const second = deferred();
  const requests = [];
  const changes = [];
  const busy = [];
  const { ContextPanel } = loadSource("src/components/ContextPanel.tsx", {
    react: host.react,
    "../api/client": { api: {
      summarizeContext: (sessionId, pane, options, signal) => {
        requests.push({ sessionId, pane, options, signal });
        return requests.length === 1 ? first.promise : second.promise;
      },
    } },
  });
  const options = { excluded_message_ids: [], summary: "", recent_turns: null, max_context_tokens: null };
  const props = { sessionId: "session", pane: "main", options, onChange: (value) => changes.push(value),
    onSummaryBusy: (value) => busy.push(value), draft: "", busy: false, messageCount: 2 };
  const generate = () => elements(host.current).find((item) => item.type === "button" &&
    String(item.props.children).includes("生成摘要"));
  try {
    host.mount(ContextPanel, props);
    const start = generate().props.onClick;
    const completion = start();
    await start();
    assert.equal(requests.length, 1);
    host.render({ ...props, options: { ...options, excluded_message_ids: ["recently-excluded"] } });
    first.resolve({ summary: "summary result" });
    await completion;
    assert.deepEqual(changes[0].excluded_message_ids, ["recently-excluded"]);
    assert.equal(changes[0].summary, "summary result");
    const next = generate().props.onClick();
    host.unmount();
    assert.equal(requests[1].signal.aborted, true);
    second.reject(new Error("aborted"));
    await next;
    assert.equal(changes.length, 1, "unmounted panels must not persist a stale summary");
    assert.equal(busy.at(-1), false);
  } finally { global.window = original; }
});
