import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (red). */
  danger?: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

const ConfirmContext = createContext<((o: ConfirmOptions) => Promise<boolean>) | null>(
  null,
);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setPending({ ...opts, resolve });
    });
  }, []);

  useEffect(() => {
    if (!pending) return;
    confirmBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        pending.resolve(false);
        setPending(null);
      } else if (e.key === "Enter") {
        e.preventDefault();
        pending.resolve(true);
        setPending(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pending]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <div className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            className="bg-bg-panel border border-border-subtle rounded-xl w-full max-w-sm shadow-xl"
          >
            <div className="px-5 pt-5 pb-2">
              <h3
                id="confirm-title"
                className="text-base font-medium text-fg-primary"
              >
                {pending.title}
              </h3>
              {pending.message && (
                <p className="mt-2 text-sm text-fg-secondary whitespace-pre-line">
                  {pending.message}
                </p>
              )}
            </div>
            <div className="px-5 py-3 border-t border-border-subtle flex justify-end gap-2">
              <button
                onClick={() => {
                  pending.resolve(false);
                  setPending(null);
                }}
                className="px-4 py-2 rounded-md text-sm bg-bg-panelAlt text-fg-primary hover:bg-bg-hover transition"
              >
                {pending.cancelLabel ?? "取消"}
              </button>
              <button
                ref={confirmBtnRef}
                onClick={() => {
                  pending.resolve(true);
                  setPending(null);
                }}
                className={`px-4 py-2 rounded-md text-sm text-white transition ${
                  pending.danger
                    ? "bg-red-600 hover:bg-red-500"
                    : "bg-blue-600 hover:bg-blue-500"
                }`}
              >
                {pending.confirmLabel ?? "确认"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm must be used inside <ConfirmProvider>");
  }
  return ctx;
}
