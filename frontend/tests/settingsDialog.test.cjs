const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadSource } = require("./loadSource.cjs");
const { createHookHarness, deferred } = require("./hookHarness.cjs");

function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...elements(tree.props?.children)];
}

test("SettingsDialog retains a newly typed Key after an older save and flushes it on Close", async () => {
  const host = createHookHarness();
  const writes = [deferred(), deferred()];
  const requests = [];
  const callbacks = new Map();
  let handle = 0;
  let closes = 0;
  const settings = {
    api_base_url: "https://example.invalid/v1", api_key_set: false,
    model_main: "main", model_aux: "aux",
    system_prompt_main: "main prompt", system_prompt_aux: "aux prompt",
    max_output_tokens_main: null, max_output_tokens_aux: null, revision: 1,
  };
  const originalDocument = global.document;
  global.document = {
    addEventListener() {}, removeEventListener() {}, querySelector() { return null; },
  };
  const { createQueuedSave } = loadSource("src/utils/queuedSave.ts");
  const { SettingsDialog } = loadSource("src/components/SettingsDialog.tsx", {
    react: host.react,
    "@docs/images/logo.png": "logo.png",
    "./ConfirmDialog": { useConfirm: () => async () => true },
    "../api/client": { api: {
      getSettings: async () => settings,
      updateSettings: (value) => {
        requests.push(value);
        return writes[requests.length - 1].promise;
      },
    } },
    "../utils/queuedSave": { createQueuedSave: (options) => createQueuedSave({
      ...options,
      schedule: (callback) => { callbacks.set(++handle, callback); return handle; },
      cancel: (id) => callbacks.delete(id),
    }) },
  });
  const props = {
    open: true, onClose: () => { closes++; },
    theme: "system", sendShortcut: "enter", autoCopyToAux: false,
    autoCopyClearAux: false, layoutLocked: false,
    onChangeTheme() {}, onChangeSendShortcut() {}, onChangeAutoCopyToAux() {},
    onChangeAutoCopyClearAux() {}, onChangeLayoutLocked() {},
  };
  function find(predicate) {
    const item = elements(host.current).find(predicate);
    assert.ok(item, "expected SettingsDialog element");
    return item;
  }
  const keyInput = () => find((item) => item.type === "input" && item.props.type === "password");
  try {
    host.mount(SettingsDialog, props);
    await new Promise(setImmediate);
    find((item) => item.props?.role === "tab" &&
      item.props.children.at(-1) === "模型 / API").props.onClick();
    keyInput().props.onChange({ target: { value: "older-key" } });
    const due = [...callbacks.values()];
    callbacks.clear();
    due.forEach((callback) => callback());
    await Promise.resolve();
    assert.equal(requests[0].api_key, "older-key");
    keyInput().props.onChange({ target: { value: "newer-key" } });
    writes[0].resolve({ ...settings, api_key_set: true, revision: 2 });
    await new Promise(setImmediate);
    assert.equal(keyInput().props.value, "newer-key", "older responses must preserve the live Key draft");
    assert.equal(requests.length, 1);
    find((item) => item.props?.["aria-label"] === "关闭").props.onClick();
    await Promise.resolve();
    assert.equal(requests[1].api_key, "newer-key");
    assert.equal(closes, 0, "Close must await the final save");
    writes[1].resolve({ ...settings, api_key_set: true, revision: 3 });
    await new Promise(setImmediate);
    assert.equal(closes, 1);
    assert.equal(callbacks.size, 0);
  } finally {
    host.unmount();
    global.document = originalDocument;
  }
});
