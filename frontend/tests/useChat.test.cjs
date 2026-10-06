const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadSource } = require("./loadSource.cjs");
const { createHookHarness, deferred } = require("./hookHarness.cjs");

const tick = () => new Promise(setImmediate);
const list = (messages = []) => ({ messages, stats: { message_count: messages.length, total_tokens: 42 } });
const message = (id, sessionId, content, role = "assistant") => ({
  id, session_id: sessionId, pane: "main", role, content, created_at: "2026-10-07T00:00:00Z",
});

function setup(options = {}) {
  const host = createHookHarness();
  const runs = [];
  let afterSend = 0;
  const api = {
    listMessages: options.listMessages ?? (async () => list()),
    stopChat: options.stopChat ?? (async (id) => ({ request_id: id, status: "stopped", saved: true })),
    chatStatus: options.chatStatus ?? (async (id) => ({ request_id: id, status: "stopped", saved: true })),
    deleteMessage: async () => {},
  };
  const streamChat = (body, handlers) => {
    const stream = deferred();
    const run = { body, handlers, stream };
    runs.push(run);
    if (!options.manualOpen) handlers.onOpen?.();
    handlers.signal.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      stream.reject(error);
    });
    return stream.promise;
  };
  const { useChat } = loadSource("src/hooks/useChat.ts", { react: host.react, "../api/client": { api, streamChat } });
  const props = { sessionId: "session-a", pane: "main", onAfterSend: () => { afterSend++; }, ...options.props };
  host.mount(useChat, props);
  return { host, runs, api, props, get afterSend() { return afterSend; } };
}

async function complete(run, result = {}) {
  await run.handlers.onSaved({ request_id: run.body.request_id, saved: true, status: "saved", ...result });
  await run.handlers.onDone();
  run.stream.resolve();
}

test("switching sessions aborts the old stream and ignores every old callback and resync", async () => {
  const staleRead = deferred();
  let aReads = 0;
  const env = setup({ listMessages: (id) => {
    if (id === "session-a" && ++aReads > 1) return staleRead.promise;
    return Promise.resolve(list([message(`${id}-answer`, id, id)]));
  } });
  await tick();
  const sending = env.host.current.send("question-a");
  const old = env.runs[0];
  old.handlers.onDelta("old output");
  await old.handlers.onSaved({ request_id: old.body.request_id, saved: true, status: "saved" });
  const syncing = old.handlers.onDone();
  env.host.render({ ...env.props, sessionId: "session-b" });
  await tick();
  assert.equal(old.handlers.signal.aborted, true);
  old.handlers.onDelta("late output");
  old.handlers.onError("late error");
  staleRead.resolve(list([message("stale", "session-a", "stale") ]));
  await Promise.all([syncing, sending]);
  assert.deepEqual(env.host.current.messages.map((item) => item.session_id), ["session-b"]);
  assert.equal(env.host.current.error, null);
  assert.equal(env.host.current.streaming, false);
  assert.equal(env.afterSend, 0);
});

test("same-tick duplicate sends and sends while stopping or syncing are locked", async () => {
  const stopping = deferred();
  const syncing = deferred();
  let reads = 0;
  const env = setup({
    listMessages: () => ++reads === 1 ? Promise.resolve(list()) : syncing.promise,
    stopChat: () => stopping.promise,
  });
  await tick();
  const first = env.host.current.send("first");
  await env.host.current.send("duplicate");
  assert.equal(env.runs.length, 1);
  env.runs[0].handlers.onDelta("partial");
  const stop = env.host.current.stop();
  await env.host.current.send("during stop");
  assert.equal(env.host.current.stopping, true);
  assert.equal(env.host.current.streaming, true);
  stopping.resolve({ request_id: env.runs[0].body.request_id, saved: true, status: "stopped" });
  await tick();
  await env.host.current.send("during sync");
  assert.equal(env.runs.length, 1);
  assert.equal(env.host.current.streaming, true);
  syncing.resolve(list([message("saved-partial", "session-a", "partial")]));
  await Promise.all([first, stop]);
  assert.equal(env.host.current.streaming, false);
  assert.equal(env.host.current.stopping, false);
  assert.equal(reads, 2, "one canonical fetch after confirmed persistence");
  const next = env.host.current.send("after stop");
  assert.equal(env.runs.length, 2);
  await complete(env.runs[1]);
  await next;
});

test("cached entry-point callbacks cannot act on a different session after switching", async () => {
  const reads = [];
  let deleted = 0;
  const env = setup({ listMessages: async (id) => { reads.push(id); return list(); } });
  env.api.deleteMessage = async () => { deleted++; };
  await tick();
  const old = env.host.current;
  env.host.render({ ...env.props, sessionId: "session-b" });
  await tick();
  const count = reads.length;
  await old.send("stale sender");
  await old.refresh();
  await old.deleteMessage("old-message");
  assert.equal(env.runs.length, 0);
  assert.equal(deleted, 0);
  assert.equal(reads.length, count);
  const send = env.host.current.send("current sender");
  assert.equal(env.runs[0].body.session_id, "session-b");
  await old.stop();
  assert.equal(env.runs[0].handlers.signal.aborted, false);
  await complete(env.runs[0]);
  await send;
});

test("Stop waits for request registration before signaling and never unlocks a running worker", async () => {
  let stops = 0;
  const poll = deferred();
  const env = setup({
    manualOpen: true,
    stopChat: async (id) => { stops++; return { request_id: id, status: "running", saved: false }; },
    chatStatus: () => poll.promise,
  });
  await tick();
  const first = env.host.current.send("first");
  const stop = env.host.current.stop();
  await tick();
  assert.equal(stops, 0);
  env.runs[0].handlers.onOpen();
  await tick();
  assert.equal(stops, 1);
  await env.host.current.send("blocked");
  assert.equal(env.runs.length, 1);
  assert.equal(env.host.current.streaming, true);
  poll.resolve({ request_id: env.runs[0].body.request_id, status: "stopped", saved: true });
  await Promise.all([first, stop]);
  assert.equal(env.host.current.streaming, false);
});

test("a save failure restores the original tail and keeps generated text through later refreshes", async () => {
  const canonical = [message("question", "session-a", "original prompt", "user"), message("old-answer", "session-a", "original answer")];
  const env = setup({ listMessages: async () => list(canonical) });
  await tick();
  const send = env.host.current.regenerate("old-answer");
  env.runs[0].handlers.onDelta("unsaved answer");
  env.runs[0].handlers.onError("save failed");
  await complete(env.runs[0], { saved: false, status: "failed", error: "save failed" });
  await send;
  assert.deepEqual(env.host.current.messages.map((item) => item.content), ["original prompt", "original answer", "unsaved answer"]);
  assert.equal(env.host.current.messages.at(-1).local_status, "unsaved");
  assert.equal(env.host.current.error, "save failed");
  assert.equal(env.host.current.lastRun.saved, false);
  await env.host.current.refresh();
  assert.equal(env.host.current.messages.at(-1).content, "unsaved answer");
});

test("transport loss keeps the send lock while retrying an unavailable worker status", async () => {
  const finalState = deferred();
  let polls = 0;
  const env = setup({
    stopChat: async (id) => ({ request_id: id, status: "running", saved: false }),
    chatStatus: async () => {
      if (++polls === 1) throw new TypeError("temporary network failure");
      return finalState.promise;
    },
  });
  await tick();
  const sending = env.host.current.send("prompt");
  const run = env.runs[0];
  run.handlers.onDelta("retained output");
  run.stream.reject(new Error("stream disconnected"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(polls, 1);
  assert.equal(env.host.current.streaming, true);
  assert.equal(env.host.current.stopping, true);
  await env.host.current.send("must wait");
  assert.equal(env.runs.length, 1);
  finalState.resolve({ request_id: run.body.request_id, status: "failed", saved: false });
  await sending;
  assert.equal(env.host.current.streaming, false);
  assert.equal(env.host.current.messages.at(-1).content, "retained output");
  assert.equal(env.host.current.messages.at(-1).local_status, "unsaved");
});

test("stopped replacement saved in a separate branch remains visible beside the original", async () => {
  const canonical = [message("original", "session-a", "original")];
  const env = setup({ listMessages: async () => list(canonical) });
  await tick();
  const send = env.host.current.regenerate("original");
  env.runs[0].handlers.onDelta("partial replacement");
  await complete(env.runs[0], { saved: true, status: "stopped", session_id: "branch-session", branch_id: "branch-session" });
  await send;
  assert.equal(env.host.current.messages.at(-1).local_status, "branched");
  assert.equal(env.host.current.messages.at(-1).content, "partial replacement");
  assert.equal(env.host.current.lastRun.branch_id, "branch-session");
});

test("context budget rejection before output retains the submitted question through refresh", async () => {
  const env = setup();
  await tick();
  const sending = env.host.current.send("question too long for the budget");
  const run = env.runs[0];
  run.handlers.onError("上下文预算不足");
  await complete(run, { saved: false, status: "failed", error: "上下文预算不足", input_tokens_estimate: 50 });
  await sending;
  assert.equal(env.host.current.messages.length, 1);
  assert.equal(env.host.current.messages[0].role, "user");
  assert.equal(env.host.current.messages[0].content, "question too long for the budget");
  assert.equal(env.host.current.messages[0].local_status, "unsaved");
  assert.equal(env.host.current.lastRun.input_tokens_estimate, 50);
  await env.host.current.refresh();
  assert.equal(env.host.current.messages[0].content, "question too long for the budget");
});

test("HTTP rejection without a registered worker retains the unsaved prompt", async () => {
  const missing = Object.assign(new Error("404 request not found"), { status: 404 });
  const env = setup({ manualOpen: true, stopChat: async () => { throw missing; } });
  await tick();
  const sending = env.host.current.send("prompt rejected by HTTP");
  env.runs[0].stream.reject(Object.assign(new Error("409 pane already generating"), { status: 409 }));
  await sending;
  assert.equal(env.host.current.streaming, false);
  assert.deepEqual(env.host.current.messages.map(({ role, content, local_status }) => ({ role, content, local_status })), [
    { role: "user", content: "prompt rejected by HTTP", local_status: "unsaved" },
  ]);
  assert.match(env.host.current.error, /409/);
});

test("stopped edit saved to a branch retains its new question and partial answer", async () => {
  const canonical = [message("old-user", "session-a", "old question", "user"), message("old-answer", "session-a", "old answer")];
  const env = setup({ listMessages: async () => list(canonical) });
  await tick();
  const sending = env.host.current.editAndResend("old-user", "edited question");
  const run = env.runs[0];
  run.handlers.onDelta("partial edited answer");
  await complete(run, { saved: true, status: "stopped", session_id: "partial-branch", branch_id: "partial-branch" });
  await sending;
  assert.deepEqual(env.host.current.messages.map((item) => item.content), ["old question", "old answer", "edited question", "partial edited answer"]);
  assert.deepEqual(env.host.current.messages.slice(-2).map((item) => item.local_status), ["branched", "branched"]);
});

test("unmount aborts its request without state updates from stale callbacks", async () => {
  const env = setup();
  await tick();
  const send = env.host.current.send("prompt");
  const run = env.runs[0];
  env.host.unmount();
  assert.equal(run.handlers.signal.aborted, true);
  assert.doesNotThrow(() => run.handlers.onDelta("late"));
  assert.doesNotThrow(() => run.handlers.onError("late"));
  await run.handlers.onDone();
  await send;
  assert.equal(env.afterSend, 0);
});

test("initial stale history cannot overwrite a new stream and context options reach the request", async () => {
  const initial = deferred();
  const context = { excluded_message_ids: ["excluded"], recent_turns: 3, summary: "summary", max_context_tokens: 1024 };
  let reads = 0;
  const env = setup({ listMessages: () => ++reads === 1 ? initial.promise : Promise.resolve(list()), props: { contextOptions: context } });
  const send = env.host.current.send("prompt");
  env.runs[0].handlers.onDelta("current output");
  initial.resolve(list([message("stale", "session-a", "stale") ]));
  await tick();
  assert.equal(env.host.current.messages.at(-1).content, "current output");
  assert.deepEqual(env.runs[0].body.context_options, context);
  assert.match(env.runs[0].body.request_id, /^[0-9a-f-]{36}$/);
  await complete(env.runs[0]);
  await send;
});
