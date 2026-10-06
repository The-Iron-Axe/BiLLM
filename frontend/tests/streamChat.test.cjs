const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadSource } = require("./loadSource.cjs");
const { deferred } = require("./hookHarness.cjs");
const { streamChat, api } = loadSource("src/api/client.ts");

const request = { request_id: "request-one", session_id: "session-one", pane: "main", content: "hello" };

function response(chunks) {
  let index = 0;
  const bytes = new TextEncoder();
  const body = new ReadableStream({
    pull(controller) {
      if (index === chunks.length) return controller.close();
      const chunk = chunks[index++];
      controller.enqueue(typeof chunk === "string" ? bytes.encode(chunk) : chunk);
    },
  });
  return { ok: true, body };
}

test("SSE parses split CRLF and split UTF-8, and awaits the final resync callback", async () => {
  const bytes = new TextEncoder().encode('data: {"content":"中文"}\r\n\r\ndata: {"saved":true,"request_id":"request-one"}\r\n\r\ndata: [DONE]\r\n\r\n');
  const res = response([...bytes].map((byte) => new Uint8Array([byte])));
  global.fetch = async () => res;
  let text = "";
  let saved;
  let completed = false;
  let doneCalled = false;
  const sync = deferred();
  const run = streamChat(request, {
    onDelta: (delta) => { text += delta; },
    onError: assert.fail,
    onSaved: (terminal) => { saved = terminal; },
    onDone: async () => { doneCalled = true; await sync.promise; completed = true; },
  });
  await new Promise(setImmediate);
  assert.equal(text, "中文");
  assert.equal(saved.saved, true);
  assert.equal(doneCalled, true);
  assert.equal(completed, false);
  sync.resolve();
  await run;
  assert.equal(completed, true);
  assert.equal(res.body.locked, false);
});

test("unexpected EOF preserves deltas without reporting success and releases the reader", async () => {
  const res = response(['data: {"content":"partial"}\n\n']);
  global.fetch = async () => res;
  let text = "";
  let completed = false;
  await assert.rejects(streamChat(request, {
    onDelta: (delta) => { text += delta; }, onError: assert.fail,
    onDone: () => { completed = true; },
  }), /中断/);
  assert.equal(text, "partial");
  assert.equal(completed, false);
  assert.equal(res.body.locked, false);
});

test("DONE without a persistence result is rejected", async () => {
  global.fetch = async () => response(["data: [DONE]\n\n"]);
  let completed = false;
  await assert.rejects(streamChat(request, {
    onDelta: assert.fail, onError: assert.fail, onDone: () => { completed = true; },
  }), /未确认保存/);
  assert.equal(completed, false);
});

test("failure results are delivered before DONE and a mismatched request is rejected", async () => {
  const events = [];
  global.fetch = async () => response(['data: {"saved":false,"request_id":"request-one","error":"disk unavailable"}\n\ndata: [DONE]\n\n']);
  await streamChat(request, {
    onDelta: assert.fail,
    onError: (error) => events.push(error),
    onSaved: (terminal) => events.push(terminal.saved),
    onDone: () => events.push("done"),
  });
  assert.deepEqual(events, [false, "disk unavailable", "done"]);
  const res = response(['data: {"saved":true,"request_id":"other-request"}\n\ndata: [DONE]\n\n']);
  global.fetch = async () => res;
  await assert.rejects(streamChat(request, {
    onDelta: assert.fail, onError: assert.fail, onDone: assert.fail,
  }), /标识不匹配/);
  assert.equal(res.body.locked, false);
});

test("HTTP failures and malformed events never call completion", async () => {
  global.fetch = async () => ({ ok: false, status: 409, statusText: "Conflict", text: async () => "already generating" });
  await assert.rejects(streamChat(request, {
    onDelta: assert.fail, onError: assert.fail, onDone: assert.fail,
  }), /409/);
  global.fetch = async () => response(["data: not-json\n\n"]);
  await assert.rejects(streamChat(request, {
    onDelta: assert.fail, onError: assert.fail, onDone: assert.fail,
  }), /无法解析/);
});

test("settings output-limit reset sends explicit null rather than omitting it", async () => {
  let sent;
  global.fetch = async (_, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => sent };
  };
  await api.updateSettings({ max_output_tokens_main: null, max_output_tokens_aux: 1000 });
  assert.deepEqual(sent, { max_output_tokens_main: null, max_output_tokens_aux: 1000 });
});
