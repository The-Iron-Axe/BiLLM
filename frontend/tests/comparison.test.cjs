const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadSource } = require("./loadSource.cjs");
const { createHookHarness, deferred } = require("./hookHarness.cjs");

function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== "object") return [];
  return [tree, ...elements(tree.props?.children)];
}

function locatedElements(tree, location = "root") {
  if (Array.isArray(tree)) return tree.flatMap((child, index) =>
    locatedElements(child, `${location}/${child?.key ?? index}`));
  if (!tree || typeof tree !== "object") return [];
  return [{ element: tree, location }, ...locatedElements(tree.props?.children, `${location}/children`)];
}

function environment() {
  const original = {
    document: global.document, window: global.window,
    localStorage: global.localStorage, requestAnimationFrame: global.requestAnimationFrame,
  };
  const values = new Map();
  global.localStorage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
  global.document = { title: "", addEventListener() {}, removeEventListener() {} };
  global.window = {
    addEventListener() {}, removeEventListener() {},
    setInterval() { return 1; }, clearInterval() {}, getSelection() { return null; },
  };
  global.requestAnimationFrame = () => 1;
  return () => Object.assign(global, original);
}

function appFixture(initialSessions = []) {
  const restore = environment();
  const host = createHookHarness();
  const stored = initialSessions.map((session) => ({ ...session, messages: [...(session.messages ?? [])] }));
  const creates = [];
  const requests = [];
  const mounted = new Map();
  function FakeChatPane() { return null; }
  function FakeSidebar() { return null; }
  const api = {
    getSettings: async () => ({ api_key_set: true, model_main: "model-a", model_aux: "model-b", revision: 1 }),
    listSessions: async () => stored.map(({ messages, ...session }) => session),
    createSession: async (title) => {
      const session = { id: `comparison-${creates.length + 1}`, title, created_at: "now", updated_at: "now", messages: [] };
      creates.push(session);
      stored.unshift(session);
      return { ...session, messages: undefined };
    },
  };
  const { default: App } = loadSource("src/App.tsx", {
    react: host.react,
    "./api/client": { api }, "../api/client": { api },
    "./components/ChatPane": { ChatPane: FakeChatPane },
    "./components/Sidebar": { Sidebar: FakeSidebar },
    "./components/SettingsDialog": { SettingsDialog() { return null; } },
    "./components/SelectionCopyButton": { SelectionCopyButton() { return null; } },
    "./hooks/useTheme": { useTheme: () => ({ theme: "dark", setTheme() {} }) },
  });

  // Child component lifecycle is simulated, while all App/useSessions effects are real source.
  function render() {
    for (let attempt = 0; attempt < 10; attempt++) {
      const tree = host.current;
      const paneElements = locatedElements(tree).filter(({ element }) => element.type === FakeChatPane);
      // React keys only preserve state within the same parent, so include the parent location.
      const nextKeys = new Set(paneElements.map(({ element, location }) => `${location}:${element.key}`));
      let changed = false;
      for (const [key, child] of mounted) {
        if (!nextKeys.has(key)) {
          child.props.onReady(child.props.pane, child.props.sessionId, null);
          child.props.onBusyChange(child.props.pane, false);
          mounted.delete(key);
          changed = true;
        }
      }
      for (const { element, location } of paneElements) {
        const identity = `${location}:${element.key}`;
        let child = mounted.get(identity);
        if (child) {
          child.props = element.props;
          continue;
        }
        child = { props: element.props };
        child.send = (content) => {
          const write = deferred();
          const session = stored.find((item) => item.id === child.props.sessionId);
          const request = {
            sessionId: child.props.sessionId, pane: child.props.pane, content,
            historyAtSend: session?.messages.filter((message) => message.pane === child.props.pane) ?? [],
            status: "streaming", write,
          };
          requests.push(request);
          child.props.onBusyChange(child.props.pane, true);
          return write.promise.then(
            () => { request.status = "saved"; child.props.onBusyChange(child.props.pane, false); child.props.onAfterSend(); },
            (error) => { request.status = "failed"; request.error = String(error); child.props.onBusyChange(child.props.pane, false); throw error; },
          );
        };
        mounted.set(identity, child);
        child.props.onReady(child.props.pane, child.props.sessionId, child.send);
        child.props.onBusyChange(child.props.pane, false);
        changed = true;
      }
      if (!changed) return tree;
    }
    throw new Error("Pane registration failed to settle");
  }

  function find(predicate) {
    const element = elements(render()).find(predicate);
    assert.ok(element, "expected comparison UI element");
    return element;
  }
  async function tick() { await new Promise(setImmediate); return render(); }
  const pane = (name) => find((item) => item.type === FakeChatPane && item.props.pane === name);
  const paneContainer = (name) => find((item) => item.type === "div" &&
    item.props?.children?.type === FakeChatPane && item.props.children.props.pane === name);
  const sidebar = () => find((item) => item.type === FakeSidebar);
  async function compare(content) {
    find((item) => item.type === "button" && item.props.children === "同题对比").props.onClick();
    find((item) => item.type === "textarea" && item.props.placeholder === "输入用于对比的问题")
      .props.onChange({ target: { value: content } });
    find((item) => item.type === "form" && item.props.role === "dialog")
      .props.onSubmit({ preventDefault() {} });
    await tick();
  }

  host.mount(App);
  return {
    host, api, creates, requests, mounted, render, tick, pane, paneContainer, sidebar, find, compare,
    close() {
      for (const child of mounted.values()) {
        child.props.onReady(child.props.pane, child.props.sessionId, null);
        child.props.onBusyChange(child.props.pane, false);
      }
      host.unmount();
      restore();
    },
  };
}

test("comparison creates an empty session and sends the same prompt to both panes in parallel", async () => {
  const fixture = appFixture([{ id: "old", title: "old", messages: [
    { pane: "main", role: "user", content: "unrelated old history" },
    { pane: "aux", role: "assistant", content: "unrelated aux history" },
  ] }]);
  try {
    await fixture.tick();
    fixture.pane("aux").props.onClose();
    assert.equal(fixture.paneContainer("aux").props.style.display, "none");
    await fixture.compare("  Which explanation is stronger?\nGive reasons.  ");
    assert.equal(fixture.creates.length, 1);
    assert.deepEqual(fixture.creates[0].messages, []);
    assert.equal(fixture.requests.length, 2, "both requests should start before either finishes");
    assert.deepEqual(fixture.requests.map((request) => request.pane).sort(), ["aux", "main"]);
    for (const request of fixture.requests) {
      assert.equal(request.sessionId, fixture.creates[0].id);
      assert.equal(request.content, "Which explanation is stronger?\nGive reasons.");
      assert.deepEqual(request.historyAtSend, []);
    }
    assert.equal(fixture.sidebar().props.currentId, fixture.creates[0].id);
    assert.equal(fixture.pane("aux").props.sessionId, fixture.creates[0].id, "comparison must restore the hidden pane");
    assert.equal(fixture.paneContainer("aux").props.style.display, "flex");
    fixture.requests.forEach((request) => request.write.resolve());
    await fixture.tick();
  } finally { fixture.close(); }
});

test("comparison works without an existing session and one pane failing does not cancel the other", async () => {
  const fixture = appFixture();
  try {
    await fixture.tick();
    assert.equal(fixture.pane("main").props.sessionId, null);
    await fixture.compare("Compare both answers");
    assert.equal(fixture.requests.length, 2);
    const main = fixture.requests.find((request) => request.pane === "main");
    const aux = fixture.requests.find((request) => request.pane === "aux");
    main.write.reject(new Error("main model unavailable"));
    await fixture.tick();
    assert.equal(main.status, "failed");
    assert.equal(aux.status, "streaming");
    assert.match(main.error, /main model unavailable/);
    aux.write.resolve();
    await fixture.tick();
    assert.equal(aux.status, "saved");
    assert.equal(fixture.requests.length, 2);
    assert.equal(fixture.find((item) => item.type === "button" && item.props.children === "同题对比").props.disabled, false);
  } finally { fixture.close(); }
});

test("rerenders and repeated ready callbacks never submit the comparison twice", async () => {
  const fixture = appFixture();
  try {
    await fixture.tick();
    await fixture.compare("Send this exactly once");
    for (let attempt = 0; attempt < 5; attempt++) {
      for (const child of fixture.mounted.values()) {
        child.props.onReady(child.props.pane, child.props.sessionId, child.send);
      }
      fixture.render();
    }
    assert.equal(fixture.creates.length, 1);
    assert.equal(fixture.requests.length, 2);
    fixture.requests.forEach((request) => request.write.resolve());
    await fixture.tick();
    fixture.render();
    assert.equal(fixture.requests.length, 2);
  } finally { fixture.close(); }
});

test("revealing a hidden pane preserves the running pane's registration and request", async () => {
  const fixture = appFixture([{ id: "session", title: "session" }]);
  try {
    await fixture.tick();
    fixture.pane("aux").props.onClose();
    fixture.render();
    const main = [...fixture.mounted.values()].find((child) => child.props.pane === "main");
    const send = main.send;
    const result = send("Keep generating while the other pane opens");
    fixture.render();
    fixture.pane("main").props.onShowOther();
    fixture.render();
    const after = [...fixture.mounted.values()].find((child) => child.props.pane === "main");
    assert.equal(after.send, send, "changing the layout must not remount the running pane");
    assert.equal(fixture.requests[0].status, "streaming");
    assert.equal(fixture.paneContainer("aux").props.style.display, "flex");
    fixture.requests[0].write.resolve();
    await result;
    await fixture.tick();
  } finally { fixture.close(); }
});

test("session drafts remain independent when comparison opens another session", async () => {
  const fixture = appFixture([{ id: "first", title: "first" }, { id: "second", title: "second" }]);
  try {
    await fixture.tick();
    fixture.pane("main").props.onInputChange("first main draft");
    fixture.pane("aux").props.onInputChange("first aux draft");
    fixture.sidebar().props.onSelect("second");
    assert.equal(fixture.pane("main").props.inputValue, "");
    assert.equal(fixture.pane("aux").props.inputValue, "");
    fixture.pane("main").props.onInputChange("second main draft");
    fixture.pane("aux").props.onInputChange("second aux draft");
    await fixture.compare("Independent comparison");
    assert.equal(fixture.pane("main").props.inputValue, "");
    assert.equal(fixture.pane("aux").props.inputValue, "");
    fixture.requests.forEach((request) => request.write.resolve());
    await fixture.tick();
    fixture.sidebar().props.onSelect("first");
    assert.equal(fixture.pane("main").props.inputValue, "first main draft");
    assert.equal(fixture.pane("aux").props.inputValue, "first aux draft");
    fixture.sidebar().props.onSelect("second");
    assert.equal(fixture.pane("main").props.inputValue, "second main draft");
    assert.equal(fixture.pane("aux").props.inputValue, "second aux draft");
    fixture.sidebar().props.onSelect(fixture.creates[0].id);
    assert.equal(fixture.pane("main").props.inputValue, "");
    assert.equal(fixture.pane("aux").props.inputValue, "");
  } finally { fixture.close(); }
});

test("ChatPane exposes its real send handler and reports busy state with lifecycle cleanup", async () => {
  const restore = environment();
  const host = createHookHarness();
  const registrations = [];
  const busyChanges = [];
  const contents = [];
  const send = async (content) => { contents.push(content); };
  const snapshot = {
    messages: [], stats: null, streaming: false, stopping: false, error: null, lastRun: null,
    send, regenerate() {}, editAndResend() {}, deleteMessage() {}, stop: async () => undefined,
  };
  const { ChatPane } = loadSource("src/components/ChatPane.tsx", {
    react: host.react,
    "../hooks/useChat": { useChat: () => snapshot },
    "./MessageBubble": { MessageBubble() { return null; } },
    "./ContextPanel": { ContextPanel() { return null; } },
  });
  try {
    host.mount(ChatPane, {
      sessionId: "comparison-session", pane: "main", fallbackTitle: "main", modelLabel: "model",
      onReady: (...registration) => registrations.push(registration),
      onBusyChange: (...change) => busyChanges.push(change),
    });
    assert.equal(registrations.length, 1);
    assert.deepEqual(registrations[0].slice(0, 2), ["main", "comparison-session"]);
    assert.equal(registrations[0][2], send);
    await registrations[0][2]("shared comparison prompt");
    assert.deepEqual(contents, ["shared comparison prompt"]);
    assert.deepEqual(busyChanges.at(-1), ["main", false]);
    snapshot.streaming = true;
    host.render();
    assert.deepEqual(busyChanges.at(-1), ["main", true]);
    host.render();
    assert.equal(registrations.length, 1, "ordinary rerenders must not replace the registered send handler");
    host.unmount();
    assert.deepEqual(registrations.at(-1), ["main", "comparison-session", null]);
    assert.deepEqual(busyChanges.at(-1), ["main", false]);
  } finally { restore(); }
});

test("a late session refresh cannot remove a comparison session created after that refresh started", async () => {
  const host = createHookHarness();
  const late = deferred();
  const oldSession = { id: "old-session", title: "old" };
  const newSession = { id: "comparison-session", title: "comparison" };
  let lists = 0;
  const api = {
    listSessions: () => ++lists === 1 ? Promise.resolve([oldSession]) : late.promise,
    createSession: async (title) => { assert.equal(title, "comparison"); return newSession; },
  };
  const { useSessions } = loadSource("src/hooks/useSessions.ts", {
    react: host.react, "../api/client": { api },
  });
  try {
    host.mount(useSessions);
    await new Promise(setImmediate);
    assert.equal(host.current.currentId, oldSession.id);
    const refresh = host.current.refresh();
    await host.current.create("comparison");
    assert.equal(host.current.currentId, newSession.id);
    assert.deepEqual(host.current.sessions.map((session) => session.id), [newSession.id, oldSession.id]);
    late.resolve([oldSession]);
    await refresh;
    assert.equal(host.current.currentId, newSession.id);
    assert.deepEqual(host.current.sessions.map((session) => session.id), [newSession.id, oldSession.id]);
  } finally { host.unmount(); }
});
