import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import type { Session } from "../types";

export function useSessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const list = await api.listSessions();
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

  const create = useCallback(async () => {
    const s = await api.createSession();
    setSessions((prev) => [s, ...prev]);
    setCurrentId(s.id);
    return s;
  }, []);

  const remove = useCallback(
    async (id: string) => {
      await api.deleteSession(id);
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
    const updated = await api.renameSession(id, title);
    setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
  }, []);

  const clearAll = useCallback(async () => {
    await api.deleteAllSessions();
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
