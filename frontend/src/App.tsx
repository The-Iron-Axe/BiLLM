import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api/client";
import { ChatPane } from "./components/ChatPane";
import { SelectionCopyButton } from "./components/SelectionCopyButton";
import { SettingsDialog } from "./components/SettingsDialog";
import { Sidebar } from "./components/Sidebar";
import { useSessions } from "./hooks/useSessions";
import { useTheme } from "./hooks/useTheme";
import {
  DEFAULT_SEND_SHORTCUT,
  loadSendShortcut,
  type SendShortcut,
} from "./prefs";
import type { AppSettings, Pane, SearchResult } from "./types";

type Visible = "both" | "main" | "aux";

const PANE_META: Record<Pane, string> = {
  main: "主助手",
  aux: "辅助助手",
};

const LS_KEY = "billm.layout.v1";
const PREFS_KEY = "billm.prefs.v1";

interface Layout {
  visible: Visible;
  swapped: boolean;
  ratio: number;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  locked: boolean;
}

const DEFAULT_LAYOUT: Layout = {
  visible: "both",
  swapped: false,
  ratio: 0.5,
  sidebarCollapsed: false,
  sidebarWidth: 260,
  locked: false,
};

function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Layout>;
      return {
        visible: parsed.visible ?? DEFAULT_LAYOUT.visible,
        swapped: parsed.swapped ?? DEFAULT_LAYOUT.swapped,
        ratio:
          typeof parsed.ratio === "number"
            ? Math.min(0.85, Math.max(0.15, parsed.ratio))
            : DEFAULT_LAYOUT.ratio,
        sidebarCollapsed:
          parsed.sidebarCollapsed ?? DEFAULT_LAYOUT.sidebarCollapsed,
        sidebarWidth:
          typeof parsed.sidebarWidth === "number"
            ? Math.min(480, Math.max(200, parsed.sidebarWidth))
            : DEFAULT_LAYOUT.sidebarWidth,
        locked: !!parsed.locked,
      };
    }
  } catch {
    // ignore
  }
  return DEFAULT_LAYOUT;
}

interface Prefs {
  autoCopyToAux: boolean;
  autoCopyClearAux: boolean;
  sendShortcut: SendShortcut;
}

const DEFAULT_PREFS: Prefs = {
  autoCopyToAux: false,
  autoCopyClearAux: true,
  sendShortcut: DEFAULT_SEND_SHORTCUT,
};

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Prefs>;
      return {
        autoCopyToAux: !!p.autoCopyToAux,
        autoCopyClearAux:
          typeof p.autoCopyClearAux === "boolean"
            ? p.autoCopyClearAux
            : DEFAULT_PREFS.autoCopyClearAux,
        sendShortcut: loadSendShortcut(p.sendShortcut),
      };
    }
  } catch {
    // ignore
  }
  return DEFAULT_PREFS;
}

interface SelectionInfo {
  text: string;
  top: number;
  left: number;
  flipped: boolean;
}

export default function App() {
  const { sessions, currentId, setCurrentId, create, remove, rename, clearAll, refresh } =
    useSessions();
  const { theme, setTheme } = useTheme();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const initial = loadLayout();
  const [visible, setVisible] = useState<Visible>(initial.visible);
  const [swapped, setSwapped] = useState(initial.swapped);
  const [ratio, setRatio] = useState(initial.ratio);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    initial.sidebarCollapsed,
  );
  const [sidebarWidth, setSidebarWidth] = useState(initial.sidebarWidth);
  const [layoutLocked, setLayoutLocked] = useState(initial.locked);
  const [dragging, setDragging] = useState(false);
  const [sidebarDragging, setSidebarDragging] = useState(false);

  const initialPrefs = loadPrefs();
  const [autoCopyToAux, setAutoCopyToAux] = useState(initialPrefs.autoCopyToAux);
  const [autoCopyClearAux, setAutoCopyClearAux] = useState(
    initialPrefs.autoCopyClearAux,
  );
  const [sendShortcut, setSendShortcut] = useState(initialPrefs.sendShortcut);

  const [drafts, setDrafts] = useState<Record<string, { main: string; aux: string }>>({});
  const draftKey = currentId ?? "none";
  const mainInput = drafts[draftKey]?.main ?? "";
  const auxInput = drafts[draftKey]?.aux ?? "";
  const setPaneInput = useCallback((pane: Pane, value: React.SetStateAction<string>) => {
    setDrafts((previous) => {
      const pair = previous[draftKey] ?? { main: "", aux: "" };
      return { ...previous, [draftKey]: { ...pair,
        [pane]: typeof value === "function" ? value(pair[pane]) : value,
      } };
    });
  }, [draftKey]);
  const setMainInput = useCallback((value: React.SetStateAction<string>) => setPaneInput("main", value), [setPaneInput]);
  const setAuxInput = useCallback((value: React.SetStateAction<string>) => setPaneInput("aux", value), [setPaneInput]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [comparePrompt, setComparePrompt] = useState("");
  const [compareStarting, setCompareStarting] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [pendingComparison, setPendingComparison] = useState<{ sessionId: string; prompt: string } | null>(null);
  const [paneBusy, setPaneBusy] = useState({ main: false, aux: false });
  const [readyVersion, setReadyVersion] = useState(0);
  const readyPanes = useRef<Partial<Record<Pane, { sessionId: string | null; send: (content: string) => Promise<void> }>>>({});
  const onPaneReady = useCallback((pane: Pane, sessionId: string | null, send: ((content: string) => Promise<void>) | null) => {
    if (send) readyPanes.current[pane] = { sessionId, send };
    else delete readyPanes.current[pane];
    setReadyVersion((version) => version + 1);
  }, []);
  const onPaneBusy = useCallback((pane: Pane, busy: boolean) => {
    setPaneBusy((previous) => previous[pane] === busy ? previous : { ...previous, [pane]: busy });
  }, []);
  const anyPaneBusy = paneBusy.main || paneBusy.aux;
  useEffect(() => {
    if (!pendingComparison) return;
    if (currentId !== pendingComparison.sessionId) {
      setPendingComparison(null);
      return;
    }
    const { main, aux } = readyPanes.current;
    if (main?.sessionId !== currentId || aux?.sessionId !== currentId) return;
    setPendingComparison(null);
    // Each pane has its own request, stop control and error state.
    void Promise.allSettled([main.send(pendingComparison.prompt), aux.send(pendingComparison.prompt)]);
  }, [pendingComparison, currentId, readyVersion]);
  const [selectionInfo, setSelectionInfo] = useState<SelectionInfo | null>(null);
  const [messageFocus, setMessageFocus] = useState<{
    sessionId: string;
    messageId: string;
    pane: Pane;
    token: number;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const mainConversationElRef = useRef<HTMLDivElement | null>(null);
  const mainTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const auxTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        visible,
        swapped,
        ratio,
        sidebarCollapsed,
        sidebarWidth,
        locked: layoutLocked,
      }),
    );
  }, [visible, swapped, ratio, sidebarCollapsed, sidebarWidth, layoutLocked]);

  useEffect(() => {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ autoCopyToAux, autoCopyClearAux, sendShortcut }),
    );
  }, [autoCopyToAux, autoCopyClearAux, sendShortcut]);

  const loadSettings = useCallback(() => {
    api
      .getSettings()
      .then(setSettings)
      .catch(() => setSettings(null));
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    const id = window.setInterval(() => {
      api
        .getSettings()
        .then((next) => {
          setSettings((prev) =>
            !prev || prev.revision !== next.revision ? next : prev,
          );
        })
        .catch(() => {});
    }, 2000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const session = sessions.find((s) => s.id === currentId);
    document.title = session?.title
      ? `${session.title} · BiLLM`
      : "BiLLM";
  }, [sessions, currentId]);

  useEffect(() => {
    if (settings && !settings.api_key_set) setSettingsOpen(true);
  }, [settings]);

  const handleCreate = () => {
    create().catch((e) => alert(`创建会话失败: ${e}`));
  };

  const handleDelete = (id: string) => {
    remove(id).catch((e) => alert(`删除失败: ${e}`));
  };

  const handleRename = (id: string, title: string) => {
    rename(id, title).catch((e) => alert(`重命名失败: ${e}`));
  };

  const afterSend = useCallback(() => {
    refresh().catch(() => {});
  }, [refresh]);

  const startComparison = async () => {
    const prompt = comparePrompt.trim();
    if (!prompt || compareStarting || anyPaneBusy) return;
    setCompareStarting(true);
    setCompareError(null);
    try {
      const session = await create(`同题对比 · ${prompt.replace(/\n/g, " ").slice(0, 24)}`);
      setVisible("both");
      setCurrentId(session.id);
      setPendingComparison({ sessionId: session.id, prompt });
      setCompareOpen(false);
      setComparePrompt("");
    } catch (e) {
      setCompareError(String(e));
    } finally {
      setCompareStarting(false);
    }
  };

  const pushToAux = useCallback(
    (text: string) => {
      const t = text.replace(/\u200B/g, "").trim();
      if (!t) return;
      setVisible((v) => (v === "main" ? "both" : v));
      setAuxInput((prev) => {
        if (autoCopyClearAux) return t;
        return prev.trim() ? `${prev}\n\n${t}` : t;
      });
      requestAnimationFrame(() => {
        const el = auxTextareaRef.current;
        if (el) {
          el.focus();
          el.scrollTop = el.scrollHeight;
        }
      });
    },
    [autoCopyClearAux, setAuxInput],
  );

  const transferToOtherPane = useCallback(
    (source: Pane, content: string) => {
      const target: Pane = source === "main" ? "aux" : "main";
      const quote = content
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      if (!quote) return;
      setVisible((current) => (current === "both" ? current : "both"));
      const next = `引用自${source === "main" ? "主助手" : "辅助助手"}：\n\n${quote}`;
      const setTargetInput = target === "main" ? setMainInput : setAuxInput;
      setTargetInput((previous) => (previous.trim() ? `${previous}\n\n${next}` : next));
      requestAnimationFrame(() => {
        const textarea = target === "main" ? mainTextareaRef.current : auxTextareaRef.current;
        textarea?.focus();
      });
    },
    [setMainInput, setAuxInput],
  );

  const openSearchResult = useCallback((result: SearchResult) => {
    setCurrentId(result.session_id);
    if (result.message_id && result.pane) {
      setVisible("both");
      setMessageFocus({
        sessionId: result.session_id,
        messageId: result.message_id,
        pane: result.pane,
        token: Date.now(),
      });
    }
  }, []);

  const branchFromMessage = useCallback(
    async (messageId: string) => {
      if (!currentId) return;
      try {
        const branch = await api.branchSession(currentId, messageId);
        await refresh();
        setCurrentId(branch.id);
      } catch (e) {
        alert(`创建分支失败: ${e}`);
      }
    },
    [currentId, refresh],
  );

  useEffect(() => {
    const computeSelectionInfo = (): SelectionInfo | null => {
      const sel = window.getSelection();
      const ref = mainConversationElRef.current;
      if (!sel || sel.isCollapsed || !ref) return null;
      const anchor = sel.anchorNode;
      const focus = sel.focusNode;
      // Only the actual conversation area triggers selection-to-aux.
      // The header (title / token stats / controls) and the input box
      // stay normally selectable + copyable without inserting anywhere.
      if (
        !anchor ||
        !focus ||
        !ref.contains(anchor) ||
        !ref.contains(focus)
      )
        return null;
      // Empty-state hints inside the conversation area opt out via
      // `data-no-aux`: they're UI scaffolding, not user/assistant content.
      const asEl = (n: Node | null): Element | null =>
        n && n.nodeType === 1
          ? (n as Element)
          : n?.parentElement ?? null;
      if (
        asEl(anchor)?.closest("[data-no-aux]") ||
        asEl(focus)?.closest("[data-no-aux]")
      )
        return null;
      const text = sel.toString();
      if (!text.trim()) return null;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const flipped = rect.top < 50;
      const top = flipped ? rect.bottom + 8 : rect.top - 8;
      const left = rect.left + rect.width / 2;
      return { text, top, left, flipped };
    };

    const onMouseUp = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("[data-selection-action]")) return;
      setTimeout(() => {
        const info = computeSelectionInfo();
        if (!info) {
          setSelectionInfo(null);
          return;
        }
        if (autoCopyToAux) {
          pushToAux(info.text);
          window.getSelection()?.removeAllRanges();
          setSelectionInfo(null);
          return;
        }
        setSelectionInfo(info);
      }, 0);
    };

    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setSelectionInfo(null);
    };

    const onScrollOrResize = () => {
      setSelectionInfo((prev) => (prev ? computeSelectionInfo() : prev));
    };

    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [autoCopyToAux, pushToAux]);

  const swap = () => setSwapped((s) => !s);
  const closePane = (p: Pane) => setVisible(p === "main" ? "aux" : "main");
  const showBoth = () => setVisible("both");

  const renderPane = (p: Pane) => {
    const both = visible === "both";
    const currentSession = sessions.find((s) => s.id === currentId);
    return (
      <ChatPane
        key={`${currentId ?? "none"}:${p}`}
        sessionId={currentId}
        pane={p}
        fallbackTitle={PANE_META[p]}
        sessionTitle={p === "main" ? currentSession?.title : undefined}
        onRenameSession={
          p === "main" && currentId
            ? (title) => handleRename(currentId, title)
            : undefined
        }
        modelLabel={
          (p === "main" ? settings?.model_main : settings?.model_aux) ?? "—"
        }
        onAfterSend={afterSend}
        onSwap={both && !anyPaneBusy ? swap : undefined}
        onClose={both && !anyPaneBusy ? () => closePane(p) : undefined}
        onShowOther={!both ? showBoth : undefined}
        otherLabel={PANE_META[p === "main" ? "aux" : "main"]}
        conversationRef={p === "main" ? mainConversationElRef : undefined}
        textareaRef={p === "main" ? mainTextareaRef : auxTextareaRef}
        inputValue={p === "main" ? mainInput : auxInput}
        onInputChange={p === "main" ? setMainInput : setAuxInput}
        sendShortcut={sendShortcut}
        focusMessageId={
          messageFocus?.sessionId === currentId && messageFocus.pane === p
            ? messageFocus.messageId
            : undefined
        }
        focusToken={
          messageFocus?.sessionId === currentId && messageFocus.pane === p
            ? messageFocus.token
            : undefined
        }
        onSendToOther={(content) => transferToOtherPane(p, content)}
        sendToOtherLabel={`引用到${PANE_META[p === "main" ? "aux" : "main"]}`}
        onBranch={branchFromMessage}
        onReady={onPaneReady}
        onBusyChange={onPaneBusy}
      />
    );
  };

  const onSplitterDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (layoutLocked) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onSplitterMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const next = Math.min(0.85, Math.max(0.15, x / rect.width));
    setRatio(next);
  };
  const onSplitterUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDragging(false);
  };
  const onSplitterDblClick = () => {
    if (layoutLocked) return;
    setRatio(0.5);
  };

  const leftFlex = ratio;
  const rightFlex = 1 - ratio;

  const anyDragging = dragging || sidebarDragging;

  return (
    <div
      className={`h-full flex ${anyDragging ? "select-none cursor-col-resize" : ""}`}
    >
      <Sidebar
        sessions={sessions}
        currentId={currentId}
        onSelect={setCurrentId}
        onCreate={handleCreate}
        onDelete={handleDelete}
        onRename={handleRename}
        onOpenSearchResult={openSearchResult}
        onOpenSettings={() => setSettingsOpen(true)}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((c) => !c)}
        width={sidebarWidth}
        onResize={setSidebarWidth}
        onDraggingChange={setSidebarDragging}
        locked={layoutLocked}
      />

      <main className="flex-1 min-w-0 flex flex-col">
        <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2 border-b border-border-subtle bg-bg-panel">
          <span className="text-xs text-fg-muted truncate">双栏独立上下文</span>
          <button type="button" disabled={anyPaneBusy || compareStarting || !!pendingComparison}
            onClick={() => { setCompareError(null); setCompareOpen(true); }}
            className="text-xs px-3 py-1.5 rounded-md border border-border-subtle hover:bg-bg-hover disabled:opacity-40">
            同题对比
          </button>
        </div>
        <div ref={containerRef} className="flex-1 min-h-0 min-w-0 flex relative">
            <div
              className="flex min-w-0 overflow-hidden"
              style={{ display: visible === "aux" ? "none" : "flex", order: swapped ? 2 : 0,
                flex: visible === "both" ? `${swapped ? rightFlex : leftFlex} 1 0` : "1 1 0" }}
            >
              {renderPane("main")}
            </div>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-disabled={layoutLocked || undefined}
              style={{ display: visible === "both" ? undefined : "none", order: 1 }}
              title={
                layoutLocked
                  ? "布局已锁定（在设置里关闭锁定后可拖拽）"
                  : "拖拽调节宽度，双击恢复 50/50"
              }
              onPointerDown={onSplitterDown}
              onPointerMove={onSplitterMove}
              onPointerUp={onSplitterUp}
              onPointerCancel={onSplitterUp}
              onDoubleClick={onSplitterDblClick}
              className={`relative shrink-0 w-1.5 transition-colors ${
                layoutLocked
                  ? "bg-border-subtle cursor-default"
                  : `cursor-col-resize ${
                      dragging
                        ? "bg-blue-500"
                        : "bg-border-subtle hover:bg-blue-500/70"
                    }`
              }`}
            >
              {!layoutLocked && (
                <span className="absolute inset-y-0 -left-1 -right-1" />
              )}
            </div>
            <div
              className="flex min-w-0 overflow-hidden"
              style={{ display: visible === "main" ? "none" : "flex", order: swapped ? 0 : 2,
                flex: visible === "both" ? `${swapped ? leftFlex : rightFlex} 1 0` : "1 1 0" }}
            >
              {renderPane("aux")}
            </div>
        </div>
      </main>

      {compareOpen && <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
        onClick={() => { if (!compareStarting) setCompareOpen(false); }}>
        <form role="dialog" aria-modal="true" aria-labelledby="compare-title"
          onClick={(event) => event.stopPropagation()}
          onSubmit={(event) => { event.preventDefault(); void startComparison(); }}
          onKeyDown={(event) => { if (event.key === "Escape" && !compareStarting) setCompareOpen(false); }}
          className="w-full max-w-xl rounded-xl bg-bg-base border border-border-subtle p-5 space-y-4 shadow-xl">
          <h2 id="compare-title" className="font-medium">同一问题，同时发送给两个助手</h2>
          <p className="text-sm text-fg-muted">会新建独立会话，两栏都从空历史开始，不影响当前聊天。各使用当前设置中的模型、系统提示词与输出上限。</p>
          <div className="text-xs text-fg-secondary break-words">主栏：{settings?.model_main ?? "未配置"}　/　辅栏：{settings?.model_aux ?? "未配置"}</div>
          <textarea autoFocus rows={5} value={comparePrompt} maxLength={1_000_000} disabled={compareStarting}
            onChange={(event) => setComparePrompt(event.target.value)}
            placeholder="输入用于对比的问题"
            className="w-full rounded-lg bg-bg-panel border border-border-subtle p-3 outline-none focus:border-blue-500 text-sm resize-y" />
          {compareError && <p role="alert" className="text-sm text-red-500 break-words">{compareError}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" disabled={compareStarting} onClick={() => setCompareOpen(false)} className="text-sm px-3 py-2 rounded hover:bg-bg-hover">取消</button>
            <button type="submit" disabled={!comparePrompt.trim() || compareStarting || anyPaneBusy || !settings?.api_key_set}
              className="text-sm px-3 py-2 rounded bg-blue-600 text-white disabled:opacity-40">
              {compareStarting ? "正在准备…" : "新建会话并对比"}
            </button>
          </div>
          {!settings?.api_key_set && <p className="text-xs text-red-500">请先在设置中配置 API Key。</p>}
        </form>
      </div>}

      {selectionInfo && !autoCopyToAux && (
        <SelectionCopyButton
          top={selectionInfo.top}
          left={selectionInfo.left}
          flipped={selectionInfo.flipped}
          onClick={() => {
            pushToAux(selectionInfo.text);
            window.getSelection()?.removeAllRanges();
            setSelectionInfo(null);
          }}
        />
      )}

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSettingsSaved={loadSettings}
        onClearAllSessions={clearAll}
        onSessionsChanged={refresh}
        currentSessionId={currentId}
        externalRevision={settings?.revision}
        theme={theme}
        onChangeTheme={setTheme}
        autoCopyToAux={autoCopyToAux}
        onChangeAutoCopyToAux={setAutoCopyToAux}
        autoCopyClearAux={autoCopyClearAux}
        onChangeAutoCopyClearAux={setAutoCopyClearAux}
        layoutLocked={layoutLocked}
        onChangeLayoutLocked={setLayoutLocked}
        sendShortcut={sendShortcut}
        onChangeSendShortcut={setSendShortcut}
      />
    </div>
  );
}
