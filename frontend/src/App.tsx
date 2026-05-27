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
import type { AppSettings, Pane } from "./types";

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

  const [auxInput, setAuxInput] = useState("");
  const [selectionInfo, setSelectionInfo] = useState<SelectionInfo | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const mainConversationElRef = useRef<HTMLDivElement | null>(null);
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

  const afterSend = () => {
    refresh().catch(() => {});
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
    [autoCopyClearAux],
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
        key={p}
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
        onSwap={both ? swap : undefined}
        onClose={both ? () => closePane(p) : undefined}
        onShowOther={!both ? showBoth : undefined}
        otherLabel={PANE_META[p === "main" ? "aux" : "main"]}
        conversationRef={p === "main" ? mainConversationElRef : undefined}
        textareaRef={p === "aux" ? auxTextareaRef : undefined}
        inputValue={p === "aux" ? auxInput : undefined}
        onInputChange={p === "aux" ? setAuxInput : undefined}
        sendShortcut={sendShortcut}
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

  const leftPane: Pane = swapped ? "aux" : "main";
  const rightPane: Pane = swapped ? "main" : "aux";

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
        onOpenSettings={() => setSettingsOpen(true)}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((c) => !c)}
        width={sidebarWidth}
        onResize={setSidebarWidth}
        onDraggingChange={setSidebarDragging}
        locked={layoutLocked}
      />

      <main ref={containerRef} className="flex-1 min-w-0 flex relative">
        {visible === "both" && (
          <>
            <div
              className="flex min-w-0 overflow-hidden"
              style={{ flex: `${leftFlex} 1 0` }}
            >
              {renderPane(leftPane)}
            </div>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-disabled={layoutLocked || undefined}
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
              style={{ flex: `${rightFlex} 1 0` }}
            >
              {renderPane(rightPane)}
            </div>
          </>
        )}

        {visible === "main" && (
          <div className="flex-1 min-w-0 flex">{renderPane("main")}</div>
        )}
        {visible === "aux" && (
          <div className="flex-1 min-w-0 flex">{renderPane("aux")}</div>
        )}
      </main>

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
