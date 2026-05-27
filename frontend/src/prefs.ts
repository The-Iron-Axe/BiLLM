import type { KeyboardEvent } from "react";

/** How Enter submits a message in chat textareas (browser-local). */
export type SendShortcut = "enter" | "ctrl-enter";

export const DEFAULT_SEND_SHORTCUT: SendShortcut = "enter";

export function loadSendShortcut(raw: unknown): SendShortcut {
  return raw === "ctrl-enter" ? "ctrl-enter" : DEFAULT_SEND_SHORTCUT;
}

export function sendShortcutHint(mode: SendShortcut): string {
  if (mode === "ctrl-enter") {
    return "(Ctrl+Enter 发送, Enter 换行)";
  }
  return "(Enter 发送, Shift+Enter 换行)";
}

export function shouldSubmitFromKeyDown(
  e: KeyboardEvent,
  mode: SendShortcut,
): boolean {
  if (e.nativeEvent.isComposing) return false;
  if (mode === "enter") {
    return e.key === "Enter" && !e.shiftKey;
  }
  return e.key === "Enter" && (e.ctrlKey || e.metaKey);
}
