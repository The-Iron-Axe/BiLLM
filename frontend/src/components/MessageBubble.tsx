import { memo, useEffect, useRef, useState } from "react";
import type { Message } from "../types";
import { useConfirm } from "./ConfirmDialog";
import { Markdown } from "./Markdown";

interface Props {
  message: Message;
  streaming?: boolean;
  /** When true, this message is the last of its kind for its role,
   *  i.e. the latest assistant reply or the latest user message.
   *  Affects what the toolbar offers (e.g. only the latest assistant
   *  bubble shows "regenerate"). */
  isLast?: boolean;
  busy?: boolean;
  onRegenerate?: (id: string) => void;
  onEdit?: (id: string, newContent: string) => void;
  onDelete?: (id: string) => void;
  onSendToOther?: (content: string) => void;
  sendToOtherLabel?: string;
  onBranch?: (messageId: string) => void;
  excludedFromContext?: boolean;
  onToggleContext?: (messageId: string) => void;
}

export const MessageBubble = memo(function MessageBubble({
  message,
  streaming,
  isLast,
  busy,
  onRegenerate,
  onEdit,
  onDelete,
  onSendToOther,
  sendToOtherLabel,
  onBranch,
  excludedFromContext,
  onToggleContext,
}: Props) {
  const isUser = message.role === "user";
  const isLocal = message.id.startsWith("local-");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [copied, setCopied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const confirm = useConfirm();

  useEffect(() => {
    if (editing) setDraft(message.content);
  }, [editing, message.content]);

  useEffect(() => {
    if (editing && textareaRef.current) {
      const el = textareaRef.current;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };

  const confirmDelete = async () => {
    if (!onDelete) return;
    const ok = await confirm({
      title: "删除这条消息？",
      message: "此操作不可撤销。",
      confirmLabel: "删除",
      danger: true,
    });
    if (ok) onDelete(message.id);
  };

  const saveEdit = () => {
    const v = draft.trim();
    if (!v || v === message.content.trim()) {
      setEditing(false);
      return;
    }
    onEdit?.(message.id, v);
    setEditing(false);
  };

  // -------- user bubble --------
  if (isUser) {
    if (editing) {
      return (
        <div className="flex justify-end">
          <div className="w-full max-w-[85%] rounded-2xl rounded-br-sm bg-blue-600/90 px-3 py-2 text-white">
            <textarea
              ref={textareaRef}
              className="w-full bg-transparent outline-none resize-none text-[15px] leading-relaxed placeholder:text-white/60 min-h-[60px]"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (
                  (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ||
                  (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing)
                ) {
                  e.preventDefault();
                  saveEdit();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                }
              }}
            />
            <div className="flex justify-end gap-2 mt-2">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="px-3 py-1 rounded-md text-xs bg-white/15 hover:bg-white/25 transition"
              >
                取消
              </button>
              <button
                type="button"
                onClick={saveEdit}
                disabled={!draft.trim() || busy}
                className="px-3 py-1 rounded-md text-xs bg-white text-blue-700 hover:bg-white/90 disabled:opacity-50 transition"
              >
                保存并重新发送
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className={`group flex flex-col items-end ${excludedFromContext ? "opacity-60" : ""}`}>
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-blue-600/90 text-white px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words">
          {message.content}
        </div>
        {excludedFromContext && <span className="text-[10px] text-fg-muted mt-1">已排除上下文（保留记录）</span>}
        {message.local_status && <span className="text-xs text-amber-600 mt-1">{message.local_status === "branched" ? "此问题保存在未完成分支" : "此问题尚未保存，请复制后重试"}</span>}
          <Toolbar align="right">
            <ToolButton onClick={copy} title={copied ? "已复制" : "复制"}>
              <CopyIcon />
            </ToolButton>
            {!isLocal && onEdit && (
              <ToolButton
                onClick={() => setEditing(true)}
                title="编辑并重新发送"
                disabled={busy}
              >
                <PencilIcon />
              </ToolButton>
            )}
            {!isLocal && onDelete && (
              <ToolButton
                onClick={confirmDelete}
                title="删除"
                disabled={busy}
              >
                <TrashIcon />
              </ToolButton>
            )}
            {!isLocal && onBranch && (
              <ToolButton onClick={() => onBranch(message.id)} title="从此消息创建分支" disabled={busy}>
                <BranchIcon />
              </ToolButton>
            )}
            {!isLocal && onToggleContext && <ToolButton onClick={() => onToggleContext(message.id)}
              title={excludedFromContext ? "纳入上下文" : "排除上下文"} disabled={busy}><ContextIcon /></ToolButton>}
          </Toolbar>
      </div>
    );
  }

  // -------- assistant bubble --------
  const empty = !message.content && !streaming;

  return (
    <div className={`group flex flex-col items-start ${excludedFromContext ? "opacity-60" : ""}`}>
      <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-bg-panelAlt text-fg-primary border border-border-subtle px-4 py-2.5">
        {empty ? (
          <span className="text-fg-muted italic text-[15px]">（空响应）</span>
        ) : (
          <Markdown content={message.content} streaming={streaming} />
        )}
      </div>
      {excludedFromContext && <span className="text-[10px] text-fg-muted mt-1">已排除上下文（保留记录）</span>}
      {message.local_status && <span className="text-xs text-amber-600 mt-1">{message.local_status === "branched" ? "此回复已存入未完成分支" : "此回复尚未保存，请复制保留"}</span>}
      {!streaming && (
        <Toolbar align="left">
          <ToolButton onClick={copy} title={copied ? "已复制" : "复制"}>
            <CopyIcon />
          </ToolButton>
          {onSendToOther && (
            <ToolButton
              onClick={() => onSendToOther(message.content)}
              title={sendToOtherLabel ?? "发送到另一栏"}
              disabled={busy}
            >
              <SendToOtherIcon />
            </ToolButton>
          )}
          {!isLocal && onRegenerate && isLast && (
            <ToolButton
              onClick={() => onRegenerate(message.id)}
              title="重新生成"
              disabled={busy}
            >
              <RefreshIcon />
            </ToolButton>
          )}
          {!isLocal && onDelete && (
            <ToolButton
              onClick={confirmDelete}
              title="删除"
              disabled={busy}
            >
              <TrashIcon />
            </ToolButton>
          )}
          {!isLocal && onBranch && (
            <ToolButton onClick={() => onBranch(message.id)} title="从此消息创建分支" disabled={busy}>
              <BranchIcon />
            </ToolButton>
          )}
          {!isLocal && onToggleContext && <ToolButton onClick={() => onToggleContext(message.id)}
            title={excludedFromContext ? "纳入上下文" : "排除上下文"} disabled={busy}><ContextIcon /></ToolButton>}
        </Toolbar>
      )}
    </div>
  );
});

function Toolbar({
  align,
  children,
}: {
  align: "left" | "right";
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex gap-0.5 mt-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity ${
        align === "right" ? "self-end" : "self-start"
      }`}
    >
      {children}
    </div>
  );
}

function ToolButton({
  onClick,
  title,
  disabled,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className="grid place-items-center w-7 h-7 rounded-md text-fg-muted hover:text-fg-primary hover:bg-bg-hover disabled:opacity-40 disabled:hover:bg-transparent transition"
    >
      {children}
    </button>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4.5" y="4.5" width="9" height="9" rx="1.5" />
      <path d="M2.5 11.5V3a1.5 1.5 0 0 1 1.5-1.5h7.5" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11.5 1.8l2.7 2.7-9 9H2.5v-2.7z" />
      <path d="M10 3.2l2.8 2.8" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M13.5 5a5.5 5.5 0 1 0 1.2 4.5" />
      <path d="M13.5 2v3h-3" />
    </svg>
  );
}

function ContextIcon() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
    <path d="M3 3h10v10H3zM5 6h6M5 9h6" />
  </svg>;
}

function SendToOtherIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 8h9" />
      <path d="M8.5 4.5L12 8l-3.5 3.5" />
      <path d="M13.5 3v10" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 3v10" />
      <circle cx="5" cy="3" r="1.5" />
      <circle cx="5" cy="13" r="1.5" />
      <path d="M6.5 5.5h2A2.5 2.5 0 0 1 11 8v.5" />
      <circle cx="11" cy="11.5" r="1.5" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 4.5h11" />
      <path d="M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5" />
      <path d="M4 4.5l.7 8.2a1.5 1.5 0 0 0 1.5 1.3h3.6a1.5 1.5 0 0 0 1.5-1.3l.7-8.2" />
    </svg>
  );
}
