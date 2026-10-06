export interface QueuedSaveState {
  saving: boolean;
  pending: boolean;
  error: unknown | null;
}

interface SaveSnapshot<T> {
  value: T;
  revision: number;
}

interface QueuedSaveOptions<T, R> {
  save: (value: T) => Promise<R>;
  onSaved?: (result: R, current: boolean) => void;
  onState?: (state: QueuedSaveState) => void;
  delayMs?: number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/** Coalesces drafts and serializes writes. Failed drafts remain available for retry. */
export function createQueuedSave<T, R>(options: QueuedSaveOptions<T, R>) {
  const schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let revision = 0;
  let pending: SaveSnapshot<T> | null = null;
  let running: Promise<void> | null = null;
  let timer: unknown | null = null;
  let error: unknown | null = null;
  let disposed = false;

  function publish() {
    if (!disposed) options.onState?.({ saving: running !== null, pending: pending !== null, error });
  }

  function clearTimer() {
    if (timer !== null) cancel(timer);
    timer = null;
  }

  async function drain(immediate: boolean): Promise<void> {
    if (immediate) clearTimer();
    while (!disposed && (pending || running)) {
      if (!running && pending) {
        if (!immediate && timer !== null) return;
        const snapshot = pending;
        pending = null;
        error = null;
        // Deferring the save also guarantees `running` is set before callbacks run.
        running = Promise.resolve().then(async () => {
          try {
            const result = await options.save(snapshot.value);
            if (!disposed) options.onSaved?.(result, snapshot.revision === revision);
          } catch (failure) {
            if (!pending && snapshot.revision === revision) pending = snapshot;
            error = failure;
            throw failure;
          } finally {
            running = null;
            publish();
          }
        });
        publish();
      }
      await running;
      if (immediate) clearTimer();
    }
  }

  return {
    enqueue(value: T, autoSave = true) {
      if (disposed) return;
      pending = { value, revision: ++revision };
      error = null;
      clearTimer();
      if (autoSave) {
        timer = schedule(() => {
          timer = null;
          void drain(false).catch(() => undefined);
        }, options.delayMs ?? 500);
      }
      publish();
    },
    flush: () => drain(true),
    discard() {
      clearTimer();
      pending = null;
      error = null;
      revision++;
      publish();
    },
    async settle() {
      await running?.catch(() => undefined);
    },
    get revision() { return revision; },
    get pending() { return pending !== null; },
    get saving() { return running !== null; },
    dispose() {
      disposed = true;
      clearTimer();
      pending = null;
    },
  };
}
