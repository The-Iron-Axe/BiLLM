import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "../hooks/useChat";
import {
  sendShortcutHint,
  shouldSubmitFromKeyDown,
  type SendShortcut,
} from "../prefs";
import type { Pane } from "../types";
import { loadContextOptions, saveContextOptions } from "../utils/contextPreferences";
import { paneQuestionSummary } from "../utils/paneHeader";
import { MessageBubble } from "./MessageBubble";
import { ContextPanel } from "./ContextPanel";

interface Props {
  sessionId: string | null;
  pane: Pane;
  /** Shown when this pane has no user messages yet. */
  fallbackTitle: string;
  /** Session title from sidebar; main pane only. */
  sessionTitle?: string | null;
  onRenameSession?: (title: string) => void;
  modelLabel: string;
  onAfterSend?: () => void;
  onSwap?: () => void;
  onClose?: () => void;
  onShowOther?: () => void;
  otherLabel?: string;
  inputValue?: string;
  onInputChange?: (value: string) => void;
  sectionRef?: React.Ref<HTMLElement>;
  /** Ref to the scrollable message-list area (not the header or input). */
  conversationRef?: React.Ref<HTMLDivElement>;
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  sendShortcut?: SendShortcut;
  focusMessageId?: string | null;
  focusToken?: number;
  onSendToOther?: (content: string) => void;
  sendToOtherLabel?: string;
  onBranch?: (messageId: string) => void;
  onReady?: (pane: Pane, sessionId: string | null, send: ((content: string) => Promise<void>) | null) => void;
  onBusyChange?: (pane: Pane, busy: boolean) => void;
}

export function ChatPane({
  sessionId,
  pane,
  fallbackTitle,
  sessionTitle,
  onRenameSession,
  modelLabel,
  onAfterSend,
  onSwap,
  onClose,
  onShowOther,
  otherLabel,
  inputValue,
  onInputChange,
  sectionRef,
  conversationRef,
  textareaRef,
  sendShortcut = "enter",
  focusMessageId,
  focusToken,
  onSendToOther,
  sendToOtherLabel,
  onBranch,
  onReady,
  onBusyChange,
}: Props) {
  const [contextOptions, setContextOptions] = useState(() => loadContextOptions(sessionId, pane));
  const [contextOpen, setContextOpen] = useState(false);
  const [contextStorageError, setContextStorageError] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const {
    messages,
    stats,
    streaming,
    stopping,
    error,
    lastRun,
    send,
    regenerate,
    editAndResend,
    deleteMessage,
    stop,
  } = useChat({
    sessionId,
    pane,
    onAfterSend,
    contextOptions,
  });
  useEffect(() => {
    setContextStorageError(!saveContextOptions(sessionId, pane, contextOptions));
  }, [sessionId, pane, contextOptions]);
  useEffect(() => {
    onReady?.(pane, sessionId, send);
    return () => onReady?.(pane, sessionId, null);
  }, [onReady, pane, sessionId, send]);
  useEffect(() => {
    onBusyChange?.(pane, streaming || summaryBusy);
    return () => onBusyChange?.(pane, false);
  }, [onBusyChange, pane, streaming, summaryBusy]);
  const toggleContext = useCallback((id: string) => {
    setContextOptions((previous) => ({
      ...previous,
      excluded_message_ids: previous.excluded_message_ids.includes(id)
        ? previous.excluded_message_ids.filter((messageId) => messageId !== id)
        : [...previous.excluded_message_ids, id],
    }));
  }, []);
  const [internalInput, setInternalInput] = useState("");
  const controlled = inputValue !== undefined && onInputChange !== undefined;
  const input = controlled ? (inputValue as string) : internalInput;
  const setInput = (v: string) => {
    if (controlled) onInputChange!(v);
    else setInternalInput(v);
  };
  const listRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const [showJumpBtn, setShowJumpBtn] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [focusedMessageId, setFocusedMessageId] = useState<string | null>(null);
  const messageElsRef = useRef(new Map<string, HTMLDivElement>());
  const handledFocusTokenRef = useRef<number | undefined>(undefined);

  const BOTTOM_THRESHOLD = 80;

  const setListRef = (el: HTMLDivElement | null) => {
    listRef.current = el;
    if (typeof conversationRef === "function") {
      conversationRef(el);
    } else if (conversationRef) {
      (conversationRef as React.MutableRefObject<HTMLDivElement | null>).current =
        el;
    }
  };

  const isNearBottom = (el: HTMLDivElement) =>
    el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;

  const scrollToBottom = (behavior: ScrollBehavior = "auto") => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    pinnedRef.current = true;
    setShowJumpBtn(false);
  };

  const handleListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const pinned = isNearBottom(el);
    pinnedRef.current = pinned;
    setShowJumpBtn(!pinned);
  };

  useEffect(() => {
    pinnedRef.current = true;
    setShowJumpBtn(false);
    requestAnimationFrame(() => scrollToBottom());
  }, [sessionId]);

  useEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [messages]);

  useEffect(() => {
    if (!focusMessageId || focusToken === undefined) return;
    if (handledFocusTokenRef.current === focusToken) return;
    const el = messageElsRef.current.get(focusMessageId);
    if (!el) return;
    handledFocusTokenRef.current = focusToken;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFocusedMessageId(focusMessageId);
    const timer = window.setTimeout(() => setFocusedMessageId(null), 1800);
    return () => window.clearTimeout(timer);
  }, [focusMessageId, focusToken, messages]);

  const submit = () => {
    const value = input.trim();
    if (!value || streaming || summaryBusy || !sessionId) return;
    setInput("");
    pinnedRef.current = true;
    setShowJumpBtn(false);
    send(value);
    requestAnimationFrame(() => scrollToBottom());
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (shouldSubmitFromKeyDown(e, sendShortcut)) {
      e.preventDefault();
      submit();
    }
  };

  const inputPlaceholder = useMemo(() => {
    if (!sessionId) return "请先选择会话";
    const hint = sendShortcutHint(sendShortcut);
    return pane === "main"
      ? `向主助手提问… ${hint}`
      : `辅助助手 · 临时问题… ${hint}`;
  }, [sessionId, pane, sendShortcut]);

  useEffect(() => {
    setEditingTitle(false);
  }, [sessionId]);

  const headerTitle = useMemo(
    () => paneQuestionSummary(messages, fallbackTitle),
    [messages, fallbackTitle],
  );

  const displayTitle = useMemo(() => {
    if (!onRenameSession) return headerTitle;
    const named = sessionTitle?.trim();
    if (named && named !== "新对话") return named;
    return headerTitle;
  }, [onRenameSession, sessionTitle, headerTitle]);

  const canRename = !!sessionId && !!onRenameSession;
  const lastRoleIndices = useMemo(() => {
    const indices = { user: -1, assistant: -1 };
    messages.forEach((message, index) => {
      if (!message.id.startsWith("local-")) indices[message.role] = index;
    });
    return indices;
  }, [messages]);
  const excludedIds = useMemo(() => new Set(contextOptions.excluded_message_ids), [contextOptions]);

  return (
    <section ref={sectionRef} className="flex-1 min-w-0 h-full flex flex-col bg-bg-base">
      <header className="px-5 py-3 border-b border-border-subtle flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-0.5 min-w-0 max-w-full">
            {editingTitle && canRename ? (
              <HeaderTitleInput
                initial={displayTitle}
                onSubmit={(next) => {
                  setEditingTitle(false);
                  const trimmed = next.trim();
                  if (trimmed && trimmed !== displayTitle) {
                    onRenameSession!(trimmed);
                  }
                }}
                onCancel={() => setEditingTitle(false)}
              />
            ) : (
              <>
                <h2
                  className="font-medium text-fg-primary truncate min-w-0 text-[15px] leading-6"
                  title={displayTitle}
                >
                  {displayTitle}
                </h2>
                {canRename && (
                  <button
                    type="button"
                    onClick={() => setEditingTitle(true)}
                    aria-label="编辑标题"
                    title="编辑标题"
                    className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-md text-fg-muted hover:text-fg-primary hover:bg-bg-hover transition"
                  >
                    <PencilIcon />
                  </button>
                )}
              </>
            )}
          </div>
          <div
            className="mt-1 flex items-center gap-2 min-w-0 text-xs text-fg-muted font-mono"
            title="本栏已保存消息数、存储文本 Token 估算（非 API 累计用量）与当前模型"
          >
            {stats && stats.message_count > 0 ? (
              <>
                <span className="shrink-0">{stats.message_count} 条</span>
                <span className="shrink-0 text-fg-muted/50">·</span>
                <span className="shrink-0">
                  ~{stats.total_tokens.toLocaleString()} token
                </span>
                <span className="shrink-0 text-fg-muted/50">·</span>
              </>
            ) : null}
            <span className="truncate" title={modelLabel}>
              {modelLabel}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" disabled={!sessionId || summaryBusy} onClick={() => setContextOpen((open) => !open)}
            aria-expanded={contextOpen} className="text-xs rounded px-2 py-1 text-fg-muted hover:bg-bg-hover disabled:opacity-40">
            上下文{excludedIds.size ? ` (${excludedIds.size})` : ""}
          </button>
          {onSwap && (
            <IconButton onClick={onSwap} title="交换左右位置">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M2 5h10l-2-2" />
                <path d="M14 11H4l2 2" />
              </svg>
            </IconButton>
          )}
          {onShowOther && (
            <IconButton onClick={onShowOther} title={`显示${otherLabel ?? "另一栏"}`}>
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="2" y="3" width="12" height="10" rx="1.5" />
                <line x1="8" y1="3" x2="8" y2="13" />
              </svg>
            </IconButton>
          )}
          {onClose && (
            <IconButton onClick={onClose} title="关闭本栏">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
              </svg>
            </IconButton>
          )}
        </div>
      </header>

      {contextOpen && sessionId && <ContextPanel sessionId={sessionId} pane={pane}
        options={contextOptions} onChange={setContextOptions} draft={input} busy={streaming}
        messageCount={stats?.message_count ?? 0} onSummaryBusy={setSummaryBusy} />}
      {contextStorageError && <p role="alert" className="text-xs text-red-500 px-5 py-1">浏览器存储不可用，上下文设置仅在本次打开期间有效。</p>}
      {lastRun && <div className="px-5 py-1.5 border-b border-border-subtle text-xs text-fg-muted flex flex-wrap items-center gap-2">
        <span>本次总耗时 {(lastRun.elapsed_ms / 1000).toFixed(1)} 秒</span>
        <span>{lastRun.status === "failed" ? "生成失败" : lastRun.status === "stopped" ? "已停止" : "生成完成"}</span>
        <span>{lastRun.saved ? "已保存" : "未确认保存"}</span>
        {lastRun.input_tokens_estimate !== undefined && <span title="本次输入及输出文本的本地估算，非服务商账单">估算输入 {lastRun.input_tokens_estimate.toLocaleString()} / 输出 {(lastRun.output_tokens_estimate ?? 0).toLocaleString()} Token</span>}
        {lastRun.branch_id && lastRun.status !== "saved" && <span>未完成回复保存在侧栏的新分支中</span>}
      </div>}

      <div className="relative flex-1 min-h-0">
        <div
          ref={setListRef}
          onScroll={handleListScroll}
          className="h-full overflow-y-auto scrollbar-thin px-5 py-6 space-y-4"
        >
        {!sessionId && (
          <div
            data-no-aux="true"
            className="h-full grid place-items-center text-fg-muted text-sm"
          >
            选择或新建一个会话开始聊天
          </div>
        )}
        {sessionId && messages.length === 0 && !streaming && (
          <div
            data-no-aux="true"
            className="h-full grid place-items-center text-fg-muted text-sm"
          >
            {pane === "main"
              ? "向主助手提出你的核心问题"
              : "在这里问些零碎/次要的问题，不会污染主上下文"}
          </div>
        )}
        {messages.map((m, i) => {
          const isLastOfRole = lastRoleIndices[m.role] === i;
          return (
            <div
              key={m.id}
              ref={(el) => {
                if (el) messageElsRef.current.set(m.id, el);
                else messageElsRef.current.delete(m.id);
              }}
              className={
                focusedMessageId === m.id
                  ? "rounded-xl outline outline-2 outline-blue-500/70 outline-offset-4 transition"
                  : "transition"
              }
            >
              <MessageBubble
                message={m}
                streaming={
                  streaming && i === messages.length - 1 && m.role === "assistant"
                }
                isLast={isLastOfRole}
                busy={streaming || summaryBusy}
                onRegenerate={regenerate}
                onEdit={editAndResend}
                onDelete={deleteMessage}
                onSendToOther={m.role === "assistant" ? onSendToOther : undefined}
                sendToOtherLabel={sendToOtherLabel}
                onBranch={onBranch}
                excludedFromContext={excludedIds.has(m.id)}
                onToggleContext={toggleContext}
              />
            </div>
          );
        })}
        {error && (
          <div className="text-sm text-red-500 dark:text-red-400 bg-red-500/10 dark:bg-red-950/30 border border-red-500/30 dark:border-red-900 rounded-md px-3 py-2">
            {error}
          </div>
        )}
        </div>
        {showJumpBtn && (
          <button
            type="button"
            onClick={() => scrollToBottom("smooth")}
            aria-label="回到底部"
            className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10
              px-3 py-1.5 rounded-full text-xs font-medium
              bg-bg-panel/95 text-fg-secondary border border-border-subtle shadow-md
              hover:text-fg-primary hover:bg-bg-hover transition"
          >
            回到底部
          </button>
        )}
      </div>

      <div className="border-t border-border-subtle p-3">
        <div className="flex items-end gap-2 bg-bg-panel rounded-xl border border-border-subtle px-3 py-2 focus-within:border-fg-muted transition">
          <textarea
            ref={textareaRef}
            className="flex-1 resize-none bg-transparent outline-none text-[15px] leading-relaxed py-1 max-h-48 min-h-[24px] text-fg-primary placeholder:text-fg-muted"
            placeholder={inputPlaceholder}
            value={input}
            disabled={!sessionId}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
          />
          {streaming ? (
            <button
              onClick={() => { void stop(); }}
              disabled={stopping}
              className="text-sm px-3 py-1.5 rounded-md bg-bg-active text-fg-primary hover:opacity-90 transition"
            >
              {stopping ? "正在停止并保存…" : "停止"}
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!input.trim() || !sessionId || summaryBusy}
              className="text-sm px-3 py-1.5 rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:hover:bg-blue-600 transition"
            >
              发送
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11.5 2.5l2 2L5 13H3v-2L11.5 2.5z" />
    </svg>
  );
}

function HeaderTitleInput({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (next: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  return (
    <input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onSubmit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => onSubmit(value)}
      className="flex-1 min-w-0 h-6 font-medium text-[15px] leading-6 text-fg-primary bg-bg-panel border border-border-subtle rounded-md px-2 outline-none focus:border-blue-500"
    />
  );
}

function IconButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="grid place-items-center w-7 h-7 rounded-md text-fg-muted hover:text-fg-primary hover:bg-bg-hover transition"
    >
      {children}
    </button>
  );
}
