import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { Session } from "../types";

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const revision = useRef(0);

  const refresh = useCallback(async () => {
    const requestRevision = ++revision.current;
    const list = await api.listSessions();
    if (requestRevision !== revision.current) return;
    setSessions(list);
    setCurrentId((prev) => {
      if (prev && list.some((s) => s.id === prev)) return prev;
      return list[0]?.id ?? null;
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh().catch(() => setLoading(false));
  }, [refresh]);

  const create = useCallback(async (title?: string) => {
    revision.current++;
    const s = await api.createSession(title);
    revision.current++;
    setSessions((prev) => [s, ...prev.filter((session) => session.id !== s.id)]);
    setCurrentId(s.id);
    setLoading(false);
    return s;
  }, []);

  const remove = useCallback(
    async (id: string) => {
      revision.current++;
      await api.deleteSession(id);
      revision.current++;
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setCurrentId((prev) => {
        if (prev !== id) return prev;
        const remaining = sessions.filter((s) => s.id !== id);
        return remaining[0]?.id ?? null;
      });
    },
    [sessions],
  );

  const rename = useCallback(async (id: string, title: string) => {
    revision.current++;
    const updated = await api.renameSession(id, title);
    revision.current++;
    setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
  }, []);

  const clearAll = useCallback(async () => {
    revision.current++;
    await api.deleteAllSessions();
    revision.current++;
    setSessions([]);
    setCurrentId(null);
  }, []);

  return {
    sessions,
    currentId,
    setCurrentId,
    loading,
    refresh,
    create,
    remove,
    rename,
    clearAll,
  };
}
