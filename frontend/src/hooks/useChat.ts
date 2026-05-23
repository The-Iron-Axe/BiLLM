import { useCallback, useEffect, useRef, useState } from "react";
import { api, streamChat, type StreamChatRequest } from "../api/client";
import type { Message, Pane, PaneStats } from "../types";

interface UseChatOptions {
  sessionId: string | null;
  pane: Pane;
  onAfterSend?: () => void;
}

interface StreamStartOptions {
  content?: string;
  replaceFromMessageId?: string;
  userPreview?: string;
}

export function useChat({ sessionId, pane, onAfterSend }: UseChatOptions) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [stats, setStats] = useState<PaneStats | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refreshAll = useCallback(async () => {
    if (!sessionId) {
      setMessages([]);
      setStats(null);
      return;
    }
    try {
      const r = await api.listMessages(sessionId, pane);
      setMessages(r.messages);
      setStats(r.stats);
    } catch (e) {
      setError(String(e));
    }
  }, [sessionId, pane]);

  const refreshStats = useCallback(async () => {
    if (!sessionId) return;
    try {
      const s = await api.getStats(sessionId, pane);
      setStats(s);
    } catch {
      // ignore
    }
  }, [sessionId, pane]);

  useEffect(() => {
    setMessages([]);
    setStats(null);
    setError(null);
    if (!sessionId) return;
    let cancelled = false;
    api
      .listMessages(sessionId, pane)
      .then((r) => {
        if (cancelled) return;
        setMessages(r.messages);
        setStats(r.stats);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, pane]);

  const runStream = useCallback(
    async ({ content, replaceFromMessageId, userPreview }: StreamStartOptions) => {
      if (!sessionId || streaming) return;
      setError(null);

      const now = new Date().toISOString();
      const localAssistantId = `local-asst-${Date.now()}`;

      // Optimistic UI: build the new messages array based on what the server
      // will see after the rewind/insert step.
      setMessages((prev) => {
        let base = prev;
        if (replaceFromMessageId) {
          const idx = base.findIndex((m) => m.id === replaceFromMessageId);
          if (idx >= 0) base = base.slice(0, idx);
        }
        if (userPreview !== undefined) {
          base = [
            ...base,
            {
              id: `local-user-${Date.now()}`,
              session_id: sessionId,
              pane,
              role: "user",
              content: userPreview,
              created_at: now,
            },
          ];
        }
        return [
          ...base,
          {
            id: localAssistantId,
            session_id: sessionId,
            pane,
            role: "assistant",
            content: "",
            created_at: now,
          },
        ];
      });

      setStreaming(true);
      const ac = new AbortController();
      abortRef.current = ac;

      const body: StreamChatRequest = { session_id: sessionId, pane };
      if (content !== undefined) body.content = content;
      if (replaceFromMessageId !== undefined)
        body.replace_from_message_id = replaceFromMessageId;

      try {
        await streamChat(body, {
          onDelta: (delta) => {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === localAssistantId
                  ? { ...m, content: m.content + delta }
                  : m,
              ),
            );
          },
          onError: (msg) => setError(msg),
          onDone: async () => {
            setStreaming(false);
            // Resync with server: this gives us real message IDs (so
            // regenerate/edit/delete buttons work) plus the partial save
            // that happened on abort.
            await refreshAll();
            onAfterSend?.();
          },
          signal: ac.signal,
        });
      } catch (e) {
        const err = e as Error;
        if (err.name === "AbortError") {
          // The fetch was aborted client-side. Server has saved partial
          // assistant output. Pull the canonical state back.
          await refreshAll();
        } else {
          setError(String(e));
        }
        setStreaming(false);
      }
    },
    [sessionId, pane, streaming, onAfterSend, refreshAll],
  );

  const send = useCallback(
    (content: string) => {
      const v = content.trim();
      if (!v) return Promise.resolve();
      return runStream({ content: v, userPreview: v });
    },
    [runStream],
  );

  const regenerate = useCallback(
    (assistantMessageId: string) =>
      runStream({ replaceFromMessageId: assistantMessageId }),
    [runStream],
  );

  const editAndResend = useCallback(
    (userMessageId: string, newContent: string) => {
      const v = newContent.trim();
      if (!v) return Promise.resolve();
      return runStream({
        replaceFromMessageId: userMessageId,
        content: v,
        userPreview: v,
      });
    },
    [runStream],
  );

  const deleteMessage = useCallback(
    async (messageId: string) => {
      if (!sessionId) return;
      // Optimistic local removal
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
      try {
        await api.deleteMessage(sessionId, messageId);
        await refreshStats();
        // Deletion is session activity; refresh the sidebar so the
        // "most-recent" order reflects it.
        onAfterSend?.();
      } catch (e) {
        setError(String(e));
        // Restore from server on failure
        await refreshAll();
      }
    },
    [sessionId, onAfterSend, refreshAll, refreshStats],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setStreaming(false);
  }, []);

  return {
    messages,
    stats,
    streaming,
    error,
    send,
    regenerate,
    editAndResend,
    deleteMessage,
    stop,
    refresh: refreshAll,
  };
}
