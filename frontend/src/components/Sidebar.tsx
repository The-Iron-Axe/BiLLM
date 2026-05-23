import { useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "../types";
import { useConfirm } from "./ConfirmDialog";

interface Props {
  sessions: Session[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onOpenSettings: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  width: number;
  onResize: (w: number) => void;
  onDraggingChange?: (dragging: boolean) => void;
  locked?: boolean;
}

const RAIL_WIDTH = 56;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

export function Sidebar({
  sessions,
  currentId,
  onSelect,
  onCreate,
  onDelete,
  onRename,
  onOpenSettings,
  collapsed,
  onToggleCollapsed,
  width,
  onResize,
  onDraggingChange,
  locked = false,
}: Props) {
  const sidebarRef = useRef<HTMLElement>(null);
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const confirm = useConfirm();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) =>
      (s.title || "新对话").toLowerCase().includes(q),
    );
  }, [sessions, query]);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (locked) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    onDraggingChange?.(true);
  };
  const onResizeMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const rect = sidebarRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX - rect.left));
    onResize(next);
  };
  const endResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setDragging(false);
    onDraggingChange?.(false);
  };

  const handleDeleteClick = async (s: Session) => {
    const ok = await confirm({
      title: `删除会话「${s.title || "新对话"}」？`,
      message: "这条会话和它的全部消息都会被永久删除。",
      confirmLabel: "删除",
      danger: true,
    });
    if (ok) onDelete(s.id);
  };

  if (collapsed) {
    return (
      <aside
        className="relative shrink-0 flex flex-col items-center py-2 gap-1 bg-bg-panel border-r border-border-subtle"
        style={{ width: RAIL_WIDTH }}
      >
        <RailButton onClick={onToggleCollapsed} title="展开侧边栏">
          <ChevronRightIcon />
        </RailButton>
        <RailButton onClick={onCreate} title="新建对话">
          <PlusIcon />
        </RailButton>
        <div className="flex-1" />
        <RailButton onClick={onOpenSettings} title="设置">
          <GearIcon />
        </RailButton>
      </aside>
    );
  }

  return (
    <aside
      ref={sidebarRef}
      className="relative shrink-0 flex flex-col bg-bg-panel border-r border-border-subtle"
      style={{ width }}
    >
      <div className="p-3 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onToggleCollapsed}
          title="收起侧边栏"
          aria-label="收起侧边栏"
          className="grid place-items-center w-8 h-8 rounded-md text-fg-muted hover:text-fg-primary hover:bg-bg-hover transition"
        >
          <ChevronLeftIcon />
        </button>
        <button
          type="button"
          onClick={onCreate}
          title="新建对话"
          aria-label="新建对话"
          className="grid place-items-center w-8 h-8 rounded-md text-fg-secondary hover:text-fg-primary hover:bg-bg-hover transition"
        >
          <PlusIcon />
        </button>
      </div>

      <div className="px-2 pb-2">
        <div className="relative">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-muted">
            <SearchIcon />
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话…"
            className="w-full pl-7 pr-2 py-1.5 text-sm bg-bg-panelAlt rounded-md border border-transparent focus:border-border-subtle focus:bg-bg-base text-fg-primary placeholder:text-fg-muted outline-none transition"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin px-2 space-y-0.5">
        {sessions.length === 0 && (
          <div className="px-3 py-6 text-sm text-fg-muted">
            还没有会话，点上面新建一个吧。
          </div>
        )}
        {sessions.length > 0 && filtered.length === 0 && (
          <div className="px-3 py-6 text-sm text-fg-muted">
            没有匹配「{query}」的会话
          </div>
        )}
        {filtered.map((s) => {
          const active = s.id === currentId;
          const isEditing = editingId === s.id;
          return (
            <div
              key={s.id}
              onClick={() => !isEditing && onSelect(s.id)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditingId(s.id);
              }}
              className={`group flex items-center gap-1 rounded-md px-3 py-2 text-sm transition ${
                isEditing
                  ? "bg-bg-base ring-1 ring-blue-500/60"
                  : `cursor-pointer ${
                      active
                        ? "bg-bg-hover text-fg-primary"
                        : "text-fg-secondary hover:bg-bg-panelAlt"
                    }`
              }`}
            >
              {isEditing ? (
                <RenameInput
                  initial={s.title || "新对话"}
                  onSubmit={(next) => {
                    setEditingId(null);
                    const trimmed = next.trim();
                    if (trimmed && trimmed !== (s.title || "新对话")) {
                      onRename(s.id, trimmed);
                    }
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <>
                  <span className="flex-1 truncate" title={s.title || "新对话"}>
                    {s.title || "新对话"}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingId(s.id);
                    }}
                    className="opacity-0 group-hover:opacity-100 grid place-items-center w-6 h-6 rounded text-fg-muted hover:text-fg-primary hover:bg-bg-hover transition"
                    aria-label="重命名会话"
                    title="重命名（也可双击）"
                  >
                    <PencilIcon />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDeleteClick(s);
                    }}
                    className="opacity-0 group-hover:opacity-100 grid place-items-center w-6 h-6 rounded text-fg-muted hover:text-red-500 hover:bg-bg-hover transition"
                    aria-label="删除会话"
                    title="删除"
                  >
                    <TrashIcon />
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      <div className="border-t border-border-subtle p-2">
        <button
          onClick={onOpenSettings}
          className="w-full text-left text-sm text-fg-secondary hover:bg-bg-panelAlt rounded-md px-3 py-2 transition"
        >
          ⚙ 设置
        </button>
      </div>

      {!locked && (
        <div
          role="separator"
          aria-orientation="vertical"
          title="拖拽调节宽度"
          onPointerDown={startResize}
          onPointerMove={onResizeMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          className={`absolute top-0 right-0 h-full w-1.5 cursor-col-resize ${
            dragging ? "bg-blue-500" : "bg-transparent hover:bg-blue-500/40"
          } transition-colors`}
        />
      )}
    </aside>
  );
}

function RenameInput({
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
      onClick={(e) => e.stopPropagation()}
      className="flex-1 bg-transparent outline-none text-fg-primary text-sm"
      maxLength={120}
    />
  );
}

function RailButton({
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
      className="grid place-items-center w-9 h-9 rounded-md text-fg-secondary hover:text-fg-primary hover:bg-bg-hover transition"
    >
      {children}
    </button>
  );
}

function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 3.5L5.5 8 10 12.5" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 3.5L10.5 8 6 12.5" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.5v1.7M8 12.8v1.7M14.5 8h-1.7M3.2 8H1.5M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2M12.6 12.6l-1.2-1.2M4.6 4.6L3.4 3.4" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M13.5 13.5L10.5 10.5" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11.5 1.8l2.7 2.7-9 9H2.5v-2.7z" />
      <path d="M10 3.2l2.8 2.8" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 4.5h11" />
      <path d="M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5" />
      <path d="M4 4.5l.7 8.2a1.5 1.5 0 0 0 1.5 1.3h3.6a1.5 1.5 0 0 0 1.5-1.3l.7-8.2" />
    </svg>
  );
}
