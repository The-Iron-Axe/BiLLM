import { useEffect, useRef, useState } from "react";
import appLogo from "@docs/images/logo.png";
import { api } from "../api/client";
import {
  getProviderBaseUrl,
  matchProvider,
  PROVIDERS,
  type ProviderId,
} from "../constants/providers";
import type { ThemePreference } from "../hooks/useTheme";
import type { SendShortcut } from "../prefs";
import type { AppSettings } from "../types";
import { useConfirm } from "./ConfirmDialog";

interface Props {
  open: boolean;
  onClose: () => void;
  onSettingsSaved?: () => void;
  onClearAllSessions?: () => Promise<void>;
  externalRevision?: number;
  theme: ThemePreference;
  onChangeTheme: (t: ThemePreference) => void;
  sendShortcut: SendShortcut;
  onChangeSendShortcut: (v: SendShortcut) => void;
  autoCopyToAux: boolean;
  onChangeAutoCopyToAux: (v: boolean) => void;
  autoCopyClearAux: boolean;
  onChangeAutoCopyClearAux: (v: boolean) => void;
  layoutLocked: boolean;
  onChangeLayoutLocked: (v: boolean) => void;
}

type TabId = "appearance" | "behavior" | "data" | "api" | "about";

interface TestResult {
  ok: boolean;
  detail: string;
}

const TABS: { id: TabId; label: string; icon: React.ReactNode }[] = [
  {
    id: "appearance",
    label: "外观",
    icon: (
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5" />
      </svg>
    ),
  },
  {
    id: "behavior",
    label: "选区行为",
    icon: (
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 4l8 8M12 4v3.5H8.5" />
        <rect x="2" y="2" width="12" height="12" rx="1.5" />
      </svg>
    ),
  },
  {
    id: "data",
    label: "数据",
    icon: (
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <ellipse cx="8" cy="5" rx="5" ry="2" />
        <path d="M3 5v6c0 1.1 2.24 2 5 2s5-.9 5-2V5" />
        <path d="M3 8c0 1.1 2.24 2 5 2s5-.9 5-2" />
      </svg>
    ),
  },
  {
    id: "api",
    label: "模型 / API",
    icon: (
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M8 2v2M8 12v2M2 8h2M12 8h2" />
        <circle cx="8" cy="8" r="3" />
      </svg>
    ),
  },
  {
    id: "about",
    label: "关于",
    icon: (
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 7v4M8 5h.01" />
      </svg>
    ),
  },
];

export function SettingsDialog({
  open,
  onClose,
  onSettingsSaved,
  onClearAllSessions,
  externalRevision,
  theme,
  onChangeTheme,
  autoCopyToAux,
  onChangeAutoCopyToAux,
  autoCopyClearAux,
  onChangeAutoCopyClearAux,
  layoutLocked,
  onChangeLayoutLocked,
  sendShortcut,
  onChangeSendShortcut,
}: Props) {
  const [tab, setTab] = useState<TabId>("appearance");
  const [current, setCurrent] = useState<AppSettings | null>(null);
  const [providerId, setProviderId] = useState<ProviderId>("custom");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelMain, setModelMain] = useState("");
  const [modelAux, setModelAux] = useState("");
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMainResult, setTestMainResult] = useState<TestResult | null>(null);
  const [testAuxResult, setTestAuxResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const hydratedRef = useRef(false);

  const apiDirty =
    !!current &&
    (baseUrl !== current.api_base_url ||
      modelMain !== current.model_main ||
      modelAux !== current.model_aux ||
      apiKey.length > 0);

  useEffect(() => {
    if (!open) {
      hydratedRef.current = false;
      return;
    }
    setError(null);
    setTestMainResult(null);
    setTestAuxResult(null);
    api
      .getSettings()
      .then((s) => {
        setCurrent(s);
        setBaseUrl(s.api_base_url);
        setProviderId(matchProvider(s.api_base_url));
        setModelMain(s.model_main);
        setModelAux(s.model_aux);
        setApiKey("");
        hydratedRef.current = true;
      })
      .catch((e) => setError(String(e)));
  }, [open]);

  useEffect(() => {
    if (!open || !hydratedRef.current || !apiDirty) return;

    const timer = window.setTimeout(async () => {
      setSaving(true);
      setError(null);
      try {
        const next = await api.updateSettings({
          api_base_url: baseUrl,
          api_key: apiKey || undefined,
          model_main: modelMain,
          model_aux: modelAux,
        });
        setCurrent(next);
        setApiKey("");
        onSettingsSaved?.();
      } catch (e) {
        setError(String(e));
      } finally {
        setSaving(false);
      }
    }, 500);

    return () => window.clearTimeout(timer);
  }, [
    open,
    apiDirty,
    baseUrl,
    apiKey,
    modelMain,
    modelAux,
    onSettingsSaved,
  ]);

  useEffect(() => {
    if (!open || !hydratedRef.current || apiDirty) return;
    if (externalRevision === undefined || !current) return;
    if (externalRevision === current.revision) return;

    api
      .getSettings()
      .then((s) => {
        setCurrent(s);
        setBaseUrl(s.api_base_url);
        setProviderId(matchProvider(s.api_base_url));
        setModelMain(s.model_main);
        setModelAux(s.model_aux);
        setApiKey("");
      })
      .catch((e) => setError(String(e)));
  }, [open, externalRevision, apiDirty, current?.revision]);

  useEffect(() => {
    // Shared fields invalidate both results.
    setTestMainResult(null);
    setTestAuxResult(null);
  }, [baseUrl, apiKey]);

  useEffect(() => {
    setTestMainResult(null);
  }, [modelMain]);

  useEffect(() => {
    setTestAuxResult(null);
  }, [modelAux]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector("[data-confirm-dialog]")) return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const testConnection = async () => {
    setTesting(true);
    setTestMainResult(null);
    setTestAuxResult(null);
    const shared = {
      api_base_url: baseUrl || undefined,
      api_key: apiKey || undefined,
    };
    const runOne = async (model: string): Promise<TestResult> => {
      if (!model) return { ok: false, detail: "未填写模型名" };
      try {
        const r = await api.testSettings({ ...shared, model });
        return { ok: r.ok, detail: r.detail };
      } catch (e) {
        return { ok: false, detail: String(e) };
      }
    };
    // Run both in parallel -- they hit the same provider so total wall time
    // is roughly one round trip.
    const [main, aux] = await Promise.all([
      runOne(modelMain),
      runOne(modelAux),
    ]);
    setTestMainResult(main);
    setTestAuxResult(aux);
    setTesting(false);
  };

  const resetToExample = async () => {
    const ok = await confirm({
      title: "恢复为默认配置？",
      message:
        "将模型与 API 设置恢复为默认值，当前填写的 Key、地址和模型名会被覆盖。",
      confirmLabel: "恢复",
      danger: true,
    });
    if (!ok) return;
    setResetting(true);
    setError(null);
    try {
      const next = await api.resetSettings();
      setCurrent(next);
      setBaseUrl(next.api_base_url);
      setProviderId(matchProvider(next.api_base_url));
      setModelMain(next.model_main);
      setModelAux(next.model_aux);
      setApiKey("");
      onSettingsSaved?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setResetting(false);
    }
  };

  const clearAllChats = async () => {
    if (!onClearAllSessions) return;
    const ok = await confirm({
      title: "清除所有聊天记录？",
      message:
        "将永久删除全部会话及其中的主栏、辅栏消息，且无法恢复。",
      confirmLabel: "全部清除",
      danger: true,
    });
    if (!ok) return;
    setClearing(true);
    setError(null);
    try {
      await onClearAllSessions();
    } catch (e) {
      setError(String(e));
    } finally {
      setClearing(false);
    }
  };

  const activeTab = TABS.find((t) => t.id === tab)!;

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="bg-bg-panel border border-border-subtle rounded-xl w-full max-w-2xl shadow-xl flex flex-col max-h-[85vh] min-h-[420px]"
      >
        <div className="flex flex-1 min-h-0">
          <nav
            role="tablist"
            aria-label="设置分类"
            className="w-44 shrink-0 flex flex-col border-r border-border-subtle py-3 px-2"
          >
            <button
              onClick={onClose}
              aria-label="关闭"
              className="self-start mb-3 ml-2 p-1.5 rounded-md text-fg-muted hover:text-fg-primary hover:bg-bg-hover transition"
            >
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
                <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
              </svg>
            </button>
            <div className="space-y-0.5">
              {TABS.map((t) => {
                const active = tab === t.id;
                return (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setTab(t.id)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition ${
                      active
                        ? "bg-bg-hover text-fg-primary font-medium"
                        : "text-fg-secondary hover:bg-bg-hover/60 hover:text-fg-primary"
                    }`}
                  >
                    <span className={active ? "text-fg-primary" : "text-fg-muted"}>
                      {t.icon}
                    </span>
                    {t.label}
                  </button>
                );
              })}
            </div>
          </nav>

          <div className="flex-1 flex flex-col min-w-0 min-h-0">
            <div className="px-6 pt-5 pb-4 border-b border-border-subtle flex items-center gap-3">
              <h3 id="settings-title" className="text-lg font-medium text-fg-primary">
                {activeTab.label}
              </h3>
              {saving && (
                <span className="text-xs text-fg-muted">保存中…</span>
              )}
            </div>

            <div className="flex-1 px-6 py-5 space-y-4 overflow-y-auto scrollbar-thin">
          {tab === "appearance" && (
            <>
              <Field label="外观主题">
                <ThemeSwitch value={theme} onChange={onChangeTheme} />
              </Field>

              <Field
                label="发送消息"
                hint={
                  sendShortcut === "enter"
                    ? "Enter 发送，Shift+Enter 换行"
                    : "Ctrl+Enter 或 ⌘+Enter 发送，Enter 换行"
                }
              >
                <SendShortcutSwitch
                  value={sendShortcut}
                  onChange={onChangeSendShortcut}
                />
              </Field>

              <Field
                label="布局"
                hint={
                  layoutLocked
                    ? "已锁定：分割线不响应鼠标，无法拖动调节"
                    : "未锁定：可拖动侧边栏右侧 / 左右栏之间的分割线"
                }
              >
                <ToggleSwitch
                  checked={layoutLocked}
                  onChange={onChangeLayoutLocked}
                  label={layoutLocked ? "锁定" : "可拖动"}
                />
              </Field>
            </>
          )}

          {tab === "behavior" && (
            <>
              <Field
                label="主栏选中文本时"
                hint={
                  autoCopyToAux
                    ? "选中即自动复制到辅助栏输入框（不显示按钮）"
                    : "选中文字上方会显示『复制到辅助栏』按钮，需要点一下"
                }
              >
                <ToggleSwitch
                  checked={autoCopyToAux}
                  onChange={onChangeAutoCopyToAux}
                  label={autoCopyToAux ? "自动复制" : "手动按钮"}
                />
              </Field>

              <Field
                label="复制到辅助栏时"
                hint={
                  autoCopyClearAux
                    ? "先清空辅助输入框，再写入选中文字（替换）"
                    : "把选中文字追加到辅助输入框末尾（保留原有内容）"
                }
              >
                <ToggleSwitch
                  checked={autoCopyClearAux}
                  onChange={onChangeAutoCopyClearAux}
                  label={autoCopyClearAux ? "替换" : "追加"}
                />
              </Field>
            </>
          )}

          {tab === "data" && (
            <div className="space-y-4">
              <Field
                label="聊天记录"
                hint="清空所有会话及聊天记录；模型、API Key 等设置不受影响。"
              >
                <button
                  type="button"
                  onClick={clearAllChats}
                  disabled={clearing || !onClearAllSessions}
                  className="px-4 py-2 rounded-md text-sm bg-red-600/90 text-white hover:bg-red-600 disabled:opacity-50 transition"
                >
                  {clearing ? "清除中…" : "清除所有聊天记录"}
                </button>
              </Field>
            </div>
          )}

          {tab === "api" && (
            <>
              <Field label="服务商">
                <Dropdown
                  value={providerId}
                  options={PROVIDERS.map((p) => ({
                    value: p.id,
                    label: p.label,
                  }))}
                  onChange={(id) => {
                    const nextId = id as ProviderId;
                    setProviderId(nextId);
                    const preset = getProviderBaseUrl(nextId);
                    if (preset) setBaseUrl(preset);
                  }}
                />
              </Field>

              <Field
                label="Base URL"
                hint={
                  providerId === "custom"
                    ? "自定义服务商，请手动填写 OpenAI 兼容地址"
                    : undefined
                }
              >
                <input
                  value={baseUrl}
                  onChange={(e) => {
                    const v = e.target.value;
                    setBaseUrl(v);
                    setProviderId(matchProvider(v));
                  }}
                  placeholder="https://api.openai.com/v1"
                  className="input"
                />
              </Field>

              <Field
                label="API Key"
                hint={
                  current?.api_key_set
                    ? "已设置；修改后将自动保存"
                    : "尚未设置，填入后自动保存"
                }
              >
                <div className="flex items-stretch gap-2">
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={
                      current?.api_key_set ? "••••••••" : "sk-..."
                    }
                    className="input flex-1"
                  />
                  <button
                    type="button"
                    onClick={testConnection}
                    disabled={testing}
                    className="shrink-0 px-3 rounded-md text-sm bg-bg-panelAlt text-fg-primary hover:bg-bg-hover disabled:opacity-50 transition"
                  >
                    {testing ? "测试中…" : "测试连通"}
                  </button>
                </div>
              </Field>

              <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
                <Field
                  label="主 LLM 模型"
                  badge={
                    <TestBadge
                      testing={testing}
                      result={testMainResult}
                    />
                  }
                >
                  <input
                    value={modelMain}
                    onChange={(e) => setModelMain(e.target.value)}
                    placeholder="gpt-4o"
                    className="input"
                  />
                </Field>
                <button
                  type="button"
                  onClick={() => {
                    setModelMain(modelAux);
                    setModelAux(modelMain);
                  }}
                  title="交换主/辅 LLM 模型"
                  aria-label="交换主/辅 LLM 模型"
                  className="grid place-items-center w-9 h-9 rounded-md text-fg-muted hover:text-fg-primary hover:bg-bg-hover transition"
                >
                  <SwapIcon />
                </button>
                <Field
                  label="辅助 LLM 模型"
                  badge={
                    <TestBadge
                      testing={testing}
                      result={testAuxResult}
                    />
                  }
                >
                  <input
                    value={modelAux}
                    onChange={(e) => setModelAux(e.target.value)}
                    placeholder="gpt-4o-mini"
                    className="input"
                  />
                </Field>
              </div>

              <div className="pt-1">
                <button
                  onClick={resetToExample}
                  disabled={resetting}
                  title="恢复为默认的模型与 API 配置"
                  className="text-sm text-fg-secondary hover:text-fg-primary underline-offset-2 hover:underline disabled:opacity-50 transition"
                >
                  {resetting ? "恢复中…" : "恢复为默认配置"}
                </button>
              </div>
            </>
          )}

          {tab === "about" && <AboutPanel />}

          {error && (
            <div className="text-sm text-red-500 dark:text-red-400 bg-red-500/10 dark:bg-red-950/30 border border-red-500/30 dark:border-red-900 rounded-md px-3 py-2">
              {error}
            </div>
          )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AboutPanel() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center gap-3 text-center pb-1">
        <img
          src={appLogo}
          alt="BiLLM"
          width={96}
          height={96}
          className="object-contain"
        />
        <div className="text-2xl font-semibold text-fg-primary tracking-tight">
          BiLLM
        </div>
        <p className="text-sm text-fg-secondary leading-relaxed max-w-sm">
          两个 LLM，一个窗口。主线不被零碎问题拖垮。
        </p>
        <p className="text-xs text-fg-muted leading-relaxed max-w-sm">
          本地双栏大模型聊天应用：左栏跑主线，右栏接杂问，上下文互不污染。
        </p>
      </div>

      <dl className="space-y-3 text-sm">
        <AboutRow label="版本" value="0.1.0" />
        <AboutRow label="技术栈" value="FastAPI · SQLite · React · TypeScript" />
        <AboutRow
          label="开源协议"
          value={
            <a
              href="https://www.apache.org/licenses/LICENSE-2.0"
              target="_blank"
              rel="noreferrer noopener"
              className="text-blue-600 dark:text-blue-400 hover:underline"
            >
              Apache License 2.0
            </a>
          }
        />
        <AboutRow
          label="源代码"
          value={
            <a
              href="https://github.com/The-Iron-Axe/BiLLM"
              target="_blank"
              rel="noreferrer noopener"
              className="text-blue-600 dark:text-blue-400 hover:underline break-all"
            >
              github.com/The-Iron-Axe/BiLLM
            </a>
          }
        />
      </dl>
    </div>
  );
}

function AboutRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-2 border-b border-border-subtle last:border-0">
      <dt className="text-fg-secondary shrink-0">{label}</dt>
      <dd className="text-fg-primary text-right">{value}</dd>
    </div>
  );
}

function Dropdown({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`dropdown-trigger w-full flex items-center justify-between gap-3
          rounded-xl border px-3.5 py-2.5 text-sm text-left transition
          bg-bg-panelAlt border-border-subtle text-fg-primary
          hover:border-fg-muted hover:bg-bg-hover
          focus:outline-none focus:border-blue-500 focus:ring-[3px] focus:ring-blue-500/15
          disabled:opacity-55 disabled:cursor-not-allowed`}
      >
        <span className="truncate">{selected?.label ?? "请选择"}</span>
        <ChevronDownIcon open={open} />
      </button>

      {open && (
        <ul
          role="listbox"
          aria-label="服务商"
          className="dropdown-menu absolute z-30 mt-1.5 w-full max-h-60 overflow-y-auto
            rounded-xl border border-border-subtle bg-bg-panel py-1.5 shadow-xl
            scrollbar-thin"
        >
          {options.map((opt) => {
            const active = opt.value === value;
            return (
              <li key={opt.value} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  className={`dropdown-option w-full flex items-center justify-between gap-3
                    px-3.5 py-2 text-sm text-left transition
                    ${
                      active
                        ? "bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium"
                        : "text-fg-primary hover:bg-bg-hover"
                    }`}
                >
                  <span className="truncate">{opt.label}</span>
                  {active && (
                    <span className="shrink-0 text-blue-600 dark:text-blue-400">
                      <CheckIcon />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ChevronDownIcon({ open }: { open?: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 text-fg-muted transition-transform duration-200 ${
        open ? "rotate-180" : ""
      }`}
    >
      <path d="M4 6l4 4 4-4" />
    </svg>
  );
}

function Field({
  label,
  hint,
  badge,
  children,
}: {
  label: string;
  hint?: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <div className="text-sm text-fg-secondary flex items-center gap-1.5">
        <span>{label}</span>
        {badge}
      </div>
      {children}
      {hint && <div className="text-xs text-fg-muted">{hint}</div>}
    </label>
  );
}

function TestBadge({
  testing,
  result,
}: {
  testing: boolean;
  result: TestResult | null;
}) {
  if (testing) {
    return (
      <span
        aria-label="测试中"
        className="inline-grid place-items-center w-4 h-4 rounded-full text-fg-muted"
      >
        <SpinnerIcon />
      </span>
    );
  }
  if (!result) return null;
  if (result.ok) {
    return (
      <span
        aria-label="通过"
        className="inline-grid place-items-center w-4 h-4 rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      >
        <CheckIcon />
      </span>
    );
  }
  // Only failures still carry a tooltip -- you need to know why it failed.
  return (
    <span
      title={result.detail}
      aria-label="失败"
      className="inline-grid place-items-center w-4 h-4 rounded-full bg-red-500/15 text-red-500 dark:text-red-400"
    >
      <CrossIcon />
    </span>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden className="animate-spin">
      <path d="M8 2a6 6 0 1 1-6 6" />
    </svg>
  );
}

function ToggleSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 text-sm text-fg-secondary"
    >
      <span
        className={`relative inline-flex items-center w-10 h-6 rounded-full transition ${
          checked ? "bg-blue-600" : "bg-bg-active"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </span>
      {label && <span>{label}</span>}
    </button>
  );
}

function SwapIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 5h10l-2-2M2 5l2 2" />
      <path d="M14 11H4l2 2M14 11l-2-2" />
    </svg>
  );
}

function SendShortcutSwitch({
  value,
  onChange,
}: {
  value: SendShortcut;
  onChange: (v: SendShortcut) => void;
}) {
  const options: { id: SendShortcut; label: string }[] = [
    { id: "enter", label: "Enter 发送" },
    { id: "ctrl-enter", label: "Ctrl+Enter" },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="发送消息快捷键"
      className="inline-flex p-0.5 rounded-lg bg-bg-panelAlt border border-border-subtle"
    >
      {options.map((opt) => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.id)}
            className={`inline-flex items-center px-3 py-1.5 rounded-md text-sm transition ${
              active
                ? "bg-bg-base text-fg-primary shadow-sm"
                : "text-fg-secondary hover:text-fg-primary"
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function ThemeSwitch({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (t: ThemePreference) => void;
}) {
  const options: { id: ThemePreference; label: string; icon: React.ReactNode }[] = [
    {
      id: "light",
      label: "日间",
      icon: (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06" />
        </svg>
      ),
    },
    {
      id: "dark",
      label: "夜间",
      icon: (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7z" />
        </svg>
      ),
    },
    {
      id: "system",
      label: "跟随系统",
      icon: (
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <path d="M5 13h6" />
        </svg>
      ),
    },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="外观主题"
      className="inline-flex p-0.5 rounded-lg bg-bg-panelAlt border border-border-subtle"
    >
      {options.map((opt) => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.id)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition ${
              active
                ? "bg-bg-base text-fg-primary shadow-sm"
                : "text-fg-secondary hover:text-fg-primary"
            }`}
          >
            {opt.icon}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
