import type {
  AppSettings,
  ContextOptions,
  ContextPreview,
  ConversationBackup,
  MessageListResponse,
  Pane,
  PaneStats,
  SearchResult,
  Session,
  UsageStats,
} from "../types";

export class HttpResponseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpResponseError";
  }
}

async function jsonFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpResponseError(res.status, `${res.status} ${res.statusText} ${text}`);
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

async function download(input: string, filename: string): Promise<void> {
  const res = await fetch(input);
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
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
  search: (query: string) =>
    jsonFetch<{ results: SearchResult[] }>(
      `/api/sessions/search?q=${encodeURIComponent(query)}`,
    ),
  exportBackup: () => download("/api/sessions/export", "billm-backup.json"),
  exportSessionMarkdown: (sessionId: string) =>
    download(
      `/api/sessions/${sessionId}/export/markdown`,
      "billm-session.md",
    ),
  importBackup: (backup: ConversationBackup) =>
    jsonFetch<{
      imported_sessions: number;
      imported_messages: number;
      session_ids: string[];
    }>("/api/sessions/import", {
      method: "POST",
      body: JSON.stringify(backup),
    }),
  branchSession: (id: string, fromMessageId: string, title?: string) =>
    jsonFetch<Session>(`/api/sessions/${id}/branch`, {
      method: "POST",
      body: JSON.stringify({ from_message_id: fromMessageId, title }),
    }),
  getUsage: () => jsonFetch<UsageStats>("/api/sessions/usage"),
  listMessages: (sessionId: string, pane: Pane) =>
    jsonFetch<MessageListResponse>(
      `/api/sessions/${sessionId}/messages?pane=${pane}`,
    ),
  getStats: (sessionId: string, pane: Pane) =>
    jsonFetch<PaneStats>(`/api/sessions/${sessionId}/stats?pane=${pane}`),
  previewContext: (sessionId: string, pane: Pane, options: ContextOptions, draft?: string) =>
    jsonFetch<ContextPreview>(`/api/sessions/${sessionId}/context/preview`, {
      method: "POST",
      body: JSON.stringify({ pane, options, draft }),
    }),
  summarizeContext: (sessionId: string, pane: Pane, options: ContextOptions, signal?: AbortSignal) =>
    jsonFetch<{ summary: string }>(`/api/sessions/${sessionId}/context/summary`, {
      method: "POST",
      body: JSON.stringify({ pane, options }),
      signal,
    }),
  stopChat: (requestId: string) =>
    jsonFetch<StreamTerminal>(`/api/chat/${requestId}/stop`, { method: "POST" }),
  chatStatus: (requestId: string) =>
    jsonFetch<StreamTerminal>(`/api/chat/${requestId}/status`),
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
    system_prompt_main?: string;
    system_prompt_aux?: string;
    max_output_tokens_main?: number | null;
    max_output_tokens_aux?: number | null;
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
  onOpen?: () => void;
  onDelta: (text: string) => void;
  onError: (msg: string) => void;
  onSaved?: (result: StreamTerminal) => void | Promise<void>;
  onDone: () => void | Promise<void>;
  signal?: AbortSignal;
}

export interface StreamChatRequest {
  request_id: string;
  session_id: string;
  pane: Pane;
  content?: string | null;
  replace_from_message_id?: string | null;
  context_options?: ContextOptions;
}

export interface StreamTerminal {
  request_id: string;
  saved: boolean;
  status?: "running" | "saved" | "failed" | "stopped";
  message_id?: string;
  branch_id?: string;
  session_id?: string;
  error?: string;
  error_kind?: string;
  input_tokens_estimate?: number;
  output_tokens_estimate?: number;
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
    throw new HttpResponseError(res.status, `${res.status} ${res.statusText} ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let terminalReceived = false;

  try {
    handlers.onOpen?.();
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const raw = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = raw
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        if (data.trim() === "[DONE]") {
          if (!terminalReceived) throw new Error("回复结束，但服务端未确认保存结果。");
          await handlers.onDone();
          return;
        }
        let parsed: { content?: string; error?: string; saved?: boolean } & Partial<StreamTerminal>;
        try {
          parsed = JSON.parse(data);
        } catch {
          throw new Error("收到无法解析的回复数据，请重试。");
        }
        if (typeof parsed.saved === "boolean") {
          if (parsed.request_id !== body.request_id) {
            throw new Error("回复请求标识不匹配，请刷新会话。");
          }
          terminalReceived = true;
          await handlers.onSaved?.(parsed as StreamTerminal);
        }
        if (typeof parsed.error === "string" && parsed.error) handlers.onError(parsed.error);
        if (typeof parsed.content === "string" && parsed.content) handlers.onDelta(parsed.content);
      }

      if (done) throw new Error("回复连接已中断，尚未收到完成确认。");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
