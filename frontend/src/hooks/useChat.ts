import { useCallback, useEffect, useRef, useState } from "react";
import { api, streamChat, type StreamChatRequest, type StreamTerminal } from "../api/client";
import type { ContextOptions, Message, Pane, PaneStats } from "../types";
import { RequestScope } from "../utils/requestScope";

interface UseChatOptions {
  sessionId: string | null;
  pane: Pane;
  contextOptions?: ContextOptions;
  onAfterSend?: () => void;
}

interface StreamStartOptions {
  content?: string;
  replaceFromMessageId?: string;
  userPreview?: string;
}

interface ChatRun {
  requestId: string;
  scope: RequestScope;
  controller: AbortController;
  assistant: Message;
  userPreviewMessage?: Message;
  full: string;
  startedAt: number;
  opened: Promise<void>;
  markOpened: () => void;
  terminal?: StreamTerminal;
  finalization?: Promise<void>;
  stopPromise?: Promise<void>;
}

export interface ChatRunStats {
  elapsed_ms: number;
  saved: boolean;
  status?: StreamTerminal["status"];
  branch_id?: string;
  estimated_tokens?: number;
  input_tokens_estimate?: number;
  output_tokens_estimate?: number;
}

export function useChat({ sessionId, pane, contextOptions, onAfterSend }: UseChatOptions) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [stats, setStats] = useState<PaneStats | null>(null);
  // Busy includes streaming, graceful stop and the final canonical resync.
  const [streaming, setStreaming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<ChatRunStats | null>(null);
  const key = `${sessionId ?? ""}:${pane}`;
  const viewKeyRef = useRef(key);
  viewKeyRef.current = key;
  const scopeRef = useRef(new RequestScope(key));
  const runRef = useRef<ChatRun | null>(null);
  const mutationRef = useRef(false);
  const retainedRef = useRef<Message[]>([]);

  const isActive = useCallback((scope: RequestScope) =>
    scopeRef.current === scope && viewKeyRef.current === scope.key && scope.isCurrent(), []);

  const refreshAll = useCallback(async () => {
    const scope = scopeRef.current;
    const revision = scope.capture();
    if (!sessionId || scope.key !== key || !isActive(scope) || runRef.current) return;
    try {
      const result = await api.listMessages(sessionId, pane);
      if (!isActive(scope) || !scope.isCurrent(revision)) return;
      setMessages([...result.messages, ...retainedRef.current]);
      setStats(result.stats);
    } catch (e) {
      if (isActive(scope) && scope.isCurrent(revision)) setError(String(e));
    }
  }, [sessionId, pane, key, isActive]);

  useEffect(() => {
    const scope = new RequestScope(key);
    scopeRef.current = scope;
    runRef.current = null;
    mutationRef.current = false;
    retainedRef.current = [];
    setMessages([]);
    setStats(null);
    setError(null);
    setStreaming(false);
    setStopping(false);
    setLastRun(null);
    const revision = scope.capture();
    if (sessionId) {
      api.listMessages(sessionId, pane).then((result) => {
        if (!isActive(scope) || !scope.isCurrent(revision)) return;
        setMessages(result.messages);
        setStats(result.stats);
      }).catch((e) => {
        if (isActive(scope) && scope.isCurrent(revision)) setError(String(e));
      });
    }
    return () => {
      scope.invalidate();
      const run = runRef.current;
      if (run?.scope === scope) {
        run.controller.abort();
        runRef.current = null;
      }
    };
  }, [key, sessionId, pane, isActive]);

  const finishRun = useCallback((run: ChatRun): Promise<void> => {
    if (run.finalization) return run.finalization;
    run.finalization = (async () => {
      if (!sessionId || !isActive(run.scope) || runRef.current !== run) return;
      const saved = run.terminal?.saved === true;
      const branched = Boolean(run.terminal?.session_id && run.terminal.session_id !== sessionId);
      if (!saved || branched) {
        const localStatus = branched ? "branched" : "unsaved";
        const drafts: Message[] = [];
        if (run.userPreviewMessage) drafts.push({ ...run.userPreviewMessage, local_status: localStatus });
        if (run.full) drafts.push({ ...run.assistant, content: run.full, local_status: localStatus });
        const draftIds = new Set(drafts.map((message) => message.id));
        retainedRef.current = [
          ...retainedRef.current.filter((message) => !draftIds.has(message.id)),
          ...drafts,
        ];
      }
      try {
        const result = await api.listMessages(sessionId, pane);
        if (!isActive(run.scope) || runRef.current !== run) return;
        // Failed replacements restore the original tail; unsaved generated
        // work remains available to copy alongside those canonical messages.
        setMessages([...result.messages, ...retainedRef.current]);
        setStats(result.stats);
      } catch (e) {
        if (isActive(run.scope) && runRef.current === run) {
          setError((prev) => prev ?? `无法同步已保存的会话：${String(e)}`);
        }
      } finally {
        if (isActive(run.scope) && runRef.current === run) {
          setLastRun({ elapsed_ms: Math.round(performance.now() - run.startedAt), saved,
            status: run.terminal?.status, branch_id: run.terminal?.branch_id,
            input_tokens_estimate: run.terminal?.input_tokens_estimate,
            output_tokens_estimate: run.terminal?.output_tokens_estimate });
          runRef.current = null;
          setStreaming(false);
          setStopping(false);
          onAfterSend?.();
        }
      }
    })();
    return run.finalization;
  }, [sessionId, pane, isActive, onAfterSend]);

  const awaitTerminal = useCallback(async (run: ChatRun, terminal: StreamTerminal): Promise<StreamTerminal> => {
    while (terminal.status === "running" && isActive(run.scope) && runRef.current === run) {
      // Poll the worker's actual persistence state, rather than guessing when
      // it is safe to reload messages or allow another request.
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      if (!isActive(run.scope) || runRef.current !== run) break;
      try {
        terminal = await api.chatStatus(run.requestId);
      } catch (e) {
        if ((e as { status?: number }).status === 404) {
          return { request_id: run.requestId, saved: false, status: "failed", error: "服务端已找不到该请求，未确认的回复仍保留在本地。" };
        }
        if (isActive(run.scope) && runRef.current === run) {
          setError((prev) => prev ?? "暂时无法确认保存状态，正在重试。");
        }
      }
    }
    return terminal;
  }, [isActive]);

  const confirmStop = useCallback(async (run: ChatRun): Promise<StreamTerminal> => {
    while (isActive(run.scope) && runRef.current === run) {
      try {
        return await awaitTerminal(run, await api.stopChat(run.requestId));
      } catch (e) {
        if ((e as { status?: number }).status === 404) {
          return { request_id: run.requestId, saved: false, status: "failed" };
        }
        if (isActive(run.scope) && runRef.current === run) {
          setError((prev) => prev ?? `暂时无法停止或确认保存，正在重试：${String(e)}`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      }
    }
    return { request_id: run.requestId, saved: false, status: "running" };
  }, [isActive, awaitTerminal]);

  const runStream = useCallback(async ({ content, replaceFromMessageId, userPreview }: StreamStartOptions) => {
    const scope = scopeRef.current;
    // Acquire synchronously, before React can render the busy state.
    if (!sessionId || scope.key !== key || !isActive(scope) || runRef.current || mutationRef.current) return;
    const requestId = crypto.randomUUID();
    const now = new Date().toISOString();
    let markOpened!: () => void;
    const opened = new Promise<void>((resolve) => { markOpened = resolve; });
    const run: ChatRun = {
      requestId,
      scope,
      controller: new AbortController(),
      assistant: {
        id: `local-asst-${requestId}`,
        session_id: sessionId,
        pane,
        role: "assistant",
        content: "",
        created_at: now,
      },
      userPreviewMessage: userPreview === undefined ? undefined : {
        id: `local-user-${requestId}`,
        session_id: sessionId,
        pane,
        role: "user",
        content: userPreview,
        created_at: now,
      },
      full: "",
      startedAt: performance.now(),
      opened,
      markOpened,
    };
    runRef.current = run;
    scope.advance();
    setError(null);
    setLastRun(null);
    setStreaming(true);
    setMessages((prev) => {
      let base = prev;
      if (replaceFromMessageId) {
        const index = base.findIndex((message) => message.id === replaceFromMessageId);
        if (index >= 0) base = base.slice(0, index);
      }
      if (run.userPreviewMessage) base = [...base, run.userPreviewMessage];
      return [...base, run.assistant];
    });

    const body: StreamChatRequest = { request_id: requestId, session_id: sessionId, pane, context_options: contextOptions };
    if (content !== undefined) body.content = content;
    if (replaceFromMessageId !== undefined) body.replace_from_message_id = replaceFromMessageId;
    const active = () => isActive(scope) && runRef.current === run;
    try {
      await streamChat(body, {
        onOpen: run.markOpened,
        onDelta: (delta) => {
          if (!active()) return;
          run.full += delta;
          setMessages((prev) => prev.map((message) =>
            message.id === run.assistant.id ? { ...message, content: run.full } : message));
        },
        onError: (message) => { if (active()) setError(message); },
        onSaved: (terminal) => { if (active()) run.terminal = terminal; },
        onDone: () => active() ? finishRun(run) : undefined,
        signal: run.controller.signal,
      });
    } catch (e) {
      run.markOpened();
      if (!active()) return;
      if (run.stopPromise) {
        await run.stopPromise;
        if (!active()) return;
      }
      setError(String(e));
      // A transport failure can happen after persistence. Query the same
      // worker before replacing optimistic content with canonical history.
      setStopping(true);
      run.stopPromise = (async () => {
        const terminal = await confirmStop(run);
        if (!active()) return;
        run.terminal = terminal;
        if (terminal.error) setError(terminal.error);
        await finishRun(run);
      })();
      await run.stopPromise;
    }
  }, [sessionId, pane, key, contextOptions, isActive, finishRun, confirmStop]);

  const send = useCallback((content: string) => {
    const value = content.trim();
    return value ? runStream({ content: value, userPreview: value }) : Promise.resolve();
  }, [runStream]);

  const regenerate = useCallback((messageId: string) =>
    runStream({ replaceFromMessageId: messageId }), [runStream]);

  const editAndResend = useCallback((messageId: string, content: string) => {
    const value = content.trim();
    return value ? runStream({ replaceFromMessageId: messageId, content: value, userPreview: value }) : Promise.resolve();
  }, [runStream]);

  const deleteMessage = useCallback(async (messageId: string) => {
    const scope = scopeRef.current;
    if (!sessionId || scope.key !== key || !isActive(scope) || runRef.current || mutationRef.current) return;
    mutationRef.current = true;
    scope.advance();
    retainedRef.current = retainedRef.current.filter((message) => message.id !== messageId);
    setMessages((prev) => prev.filter((message) => message.id !== messageId));
    try {
      if (!messageId.startsWith("local-")) await api.deleteMessage(sessionId, messageId);
      const result = await api.listMessages(sessionId, pane);
      if (isActive(scope)) {
        setMessages([...result.messages, ...retainedRef.current]);
        setStats(result.stats);
        onAfterSend?.();
      }
    } catch (e) {
      if (isActive(scope)) {
        setError(String(e));
        await refreshAll();
      }
    } finally {
      if (isActive(scope)) mutationRef.current = false;
    }
  }, [sessionId, pane, key, isActive, refreshAll, onAfterSend]);

  const stop = useCallback((): Promise<void> => {
    const run = runRef.current;
    if (!run || run.scope.key !== key || !isActive(run.scope)) return Promise.resolve();
    if (run.stopPromise) return run.stopPromise;
    if (run.finalization) return run.finalization;
    setStopping(true);
    run.stopPromise = (async () => {
      try {
        // The stream response confirms that the server has registered this
        // UUID. A very fast Stop click must not race registration and 404.
        await run.opened;
        if (!isActive(run.scope) || runRef.current !== run) return;
        const terminal = await confirmStop(run);
        if (!isActive(run.scope) || runRef.current !== run) return;
        run.terminal = terminal;
        if (terminal.error) setError(terminal.error);
        run.controller.abort();
        await finishRun(run);
      } catch (e) {
        if (isActive(run.scope) && runRef.current === run) {
          setError(`停止请求失败：${String(e)}`);
          setStopping(false);
          run.stopPromise = undefined;
        }
      }
    })();
    return run.stopPromise;
  }, [key, isActive, finishRun, confirmStop]);

  return { messages, stats, streaming, stopping, error, lastRun, send, regenerate, editAndResend, deleteMessage, stop, refresh: refreshAll };
}
