import type {
  AppSettings,
  MessageListResponse,
  Pane,
  PaneStats,
  Session,
} from "../types";

async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} ${text}`);
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

export const api = {
  listSessions: () => jsonFetch<Session[]>("/api/sessions"),
  createSession: (title?: string) =>
    jsonFetch<Session>("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  renameSession: (id: string, title: string) =>
    jsonFetch<Session>(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  deleteSession: (id: string) =>
    jsonFetch<void>(`/api/sessions/${id}`, { method: "DELETE" }),
  deleteAllSessions: () =>
    jsonFetch<void>("/api/sessions", { method: "DELETE" }),
  listMessages: (sessionId: string, pane: Pane) =>
    jsonFetch<MessageListResponse>(
      `/api/sessions/${sessionId}/messages?pane=${pane}`,
    ),
  getStats: (sessionId: string, pane: Pane) =>
    jsonFetch<PaneStats>(`/api/sessions/${sessionId}/stats?pane=${pane}`),
  deleteMessage: (sessionId: string, messageId: string) =>
    jsonFetch<void>(`/api/sessions/${sessionId}/messages/${messageId}`, {
      method: "DELETE",
    }),
  getSettings: () => jsonFetch<AppSettings>("/api/settings"),
  updateSettings: (payload: {
    api_base_url?: string;
    api_key?: string;
    model_main?: string;
    model_aux?: string;
  }) =>
    jsonFetch<AppSettings>("/api/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),
  resetSettings: () =>
    jsonFetch<AppSettings>("/api/settings/reset", { method: "POST" }),
  testSettings: (overrides: {
    api_base_url?: string;
    api_key?: string;
    model?: string;
  }) =>
    jsonFetch<{
      ok: boolean;
      detail: string;
      latency_ms?: number | null;
      model?: string | null;
    }>("/api/settings/test", {
      method: "POST",
      body: JSON.stringify(overrides),
    }),
};

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onError: (msg: string) => void;
  onDone: () => void;
  signal?: AbortSignal;
}

export interface StreamChatRequest {
  session_id: string;
  pane: Pane;
  content?: string | null;
  replace_from_message_id?: string | null;
}

export async function streamChat(
  body: StreamChatRequest,
  handlers: StreamHandlers,
): Promise<void> {
  const res = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: handlers.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    handlers.onError(`${res.status} ${res.statusText} ${text}`);
    handlers.onDone();
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);

      const line = raw.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        handlers.onDone();
        return;
      }
      try {
        const parsed = JSON.parse(data) as { content?: string; error?: string };
        if (parsed.error) handlers.onError(parsed.error);
        if (parsed.content) handlers.onDelta(parsed.content);
      } catch {
        // ignore malformed chunk
      }
    }
  }
  handlers.onDone();
}
