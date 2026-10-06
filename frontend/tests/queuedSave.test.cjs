const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadSource } = require("./loadSource.cjs");
const { createQueuedSave } = loadSource("src/utils/queuedSave.ts");

function scheduler() {
  const callbacks = new Map();
  let nextHandle = 0;
  return {
    schedule(callback) {
      const handle = ++nextHandle;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel(handle) { callbacks.delete(handle); },
    advance() {
      const due = [...callbacks.values()];
      callbacks.clear();
      due.forEach((callback) => callback());
    },
    get count() { return callbacks.size; },
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("closing immediately flushes the final debounced draft and waits for persistence", async () => {
  const clock = scheduler();
  const write = deferred();
  const saved = [];
  const queue = createQueuedSave({
    ...clock,
    save: (draft) => { saved.push(draft); return write.promise; },
  });
  queue.enqueue({ model: "first" });
  queue.enqueue({ model: "final" });
  assert.equal(clock.count, 1);
  let closed = false;
  const close = queue.flush().then(() => { closed = true; });
  await Promise.resolve();
  assert.deepEqual(saved, [{ model: "final" }]);
  assert.equal(clock.count, 0);
  assert.equal(closed, false);
  write.resolve({ model: "final" });
  await close;
  assert.equal(closed, true);
  assert.equal(queue.pending, false);
  assert.equal(queue.saving, false);
});

test("edits during a save are serialized and earlier responses cannot clear a newer Key", async () => {
  const clock = scheduler();
  const writes = [deferred(), deferred()];
  const requests = [];
  const acknowledgements = [];
  let draft = { apiKey: "older-key", model: "one" };
  const queue = createQueuedSave({
    ...clock,
    save: (value) => {
      requests.push(value);
      return writes[requests.length - 1].promise;
    },
    onSaved: (settings, isCurrent) => {
      acknowledgements.push(isCurrent);
      if (isCurrent) draft = { ...settings, apiKey: "" };
    },
  });
  queue.enqueue(draft);
  const complete = queue.flush();
  await Promise.resolve();
  draft = { apiKey: "newer-key", model: "two" };
  queue.enqueue(draft);
  clock.advance();
  assert.equal(requests.length, 1, "the second write must wait for the first");
  writes[0].resolve({ model: "one" });
  await new Promise(setImmediate);
  assert.equal(draft.apiKey, "newer-key");
  assert.deepEqual(acknowledgements, [false]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], { apiKey: "newer-key", model: "two" });
  writes[1].resolve({ model: "two" });
  await complete;
  assert.deepEqual(acknowledgements, [false, true]);
  assert.equal(draft.apiKey, "");
});

test("failed saves keep the dialog draft pending and allow an explicit retry", async () => {
  const clock = scheduler();
  const states = [];
  let failing = true;
  const queue = createQueuedSave({
    ...clock,
    save: async (value) => {
      if (failing) throw new Error("disk unavailable");
      return value;
    },
    onState: (state) => states.push(state),
  });
  queue.enqueue({ model: "keep-me" });
  await assert.rejects(queue.flush(), /disk unavailable/);
  assert.equal(queue.pending, true);
  assert.equal(queue.saving, false);
  assert.match(String(states.at(-1).error), /disk unavailable/);
  failing = false;
  await queue.flush();
  assert.equal(queue.pending, false);
  assert.equal(states.at(-1).error, null);
});

test("automatic saves keep debouncing newer input while an earlier write finishes", async () => {
  const clock = scheduler();
  const write = deferred();
  const requests = [];
  const queue = createQueuedSave({
    ...clock,
    save: (value) => {
      requests.push(value);
      return requests.length === 1 ? write.promise : Promise.resolve(value);
    },
  });
  queue.enqueue("first");
  clock.advance();
  await Promise.resolve();
  queue.enqueue("still typing");
  queue.enqueue("final");
  write.resolve("first");
  await new Promise(setImmediate);
  assert.deepEqual(requests, ["first"], "the queued debounce must not be bypassed by completion");
  assert.equal(queue.pending, true);
  clock.advance();
  await new Promise(setImmediate);
  assert.deepEqual(requests, ["first", "final"]);
  assert.equal(queue.pending, false);
});

test("reset discards queued drafts and waits for active writes before restoring defaults", async () => {
  const clock = scheduler();
  const write = deferred();
  const operations = [];
  const acknowledged = [];
  const queue = createQueuedSave({
    ...clock,
    save: async (value) => {
      operations.push(`save:${value}`);
      await write.promise;
      return value;
    },
    onSaved: (_, current) => acknowledged.push(current),
  });
  queue.enqueue("in-flight");
  const save = queue.flush();
  await Promise.resolve();
  queue.enqueue("discard-me");
  queue.discard();
  const reset = queue.settle().then(() => operations.push("reset"));
  assert.deepEqual(operations, ["save:in-flight"]);
  write.resolve();
  await Promise.all([save, reset]);
  clock.advance();
  assert.deepEqual(operations, ["save:in-flight", "reset"]);
  assert.deepEqual(acknowledged, [false]);
  assert.equal(queue.pending, false);
});
