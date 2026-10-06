import type { ContextOptions, Pane } from "../types";

export function defaultContextOptions(): ContextOptions {
  return { excluded_message_ids: [], recent_turns: null, summary: "", max_context_tokens: null };
}

function key(sessionId: string, pane: Pane) {
  return `billm.context.v1.${sessionId}.${pane}`;
}

export function loadContextOptions(sessionId: string | null, pane: Pane): ContextOptions {
  if (!sessionId) return defaultContextOptions();
  try {
    const value = JSON.parse(localStorage.getItem(key(sessionId, pane)) ?? "null");
    if (!value || typeof value !== "object") return defaultContextOptions();
    const integer = (number: unknown, min: number, max: number) =>
      typeof number === "number" && Number.isInteger(number) && number >= min && number <= max
        ? number : null;
    return {
      excluded_message_ids: Array.isArray(value.excluded_message_ids)
        ? value.excluded_message_ids.filter((id: unknown) => typeof id === "string").slice(0, 10_000) : [],
      recent_turns: integer(value.recent_turns, 1, 1000),
      summary: typeof value.summary === "string" ? value.summary.slice(0, 100_000) : "",
      max_context_tokens: integer(value.max_context_tokens, 128, 2_000_000),
    };
  } catch {
    return defaultContextOptions();
  }
}

export function saveContextOptions(sessionId: string | null, pane: Pane, options: ContextOptions): boolean {
  if (!sessionId) return true;
  try {
    localStorage.setItem(key(sessionId, pane), JSON.stringify(options));
    return true;
  } catch {
    return false;
  }
}
