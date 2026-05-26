import { useEffect, useState } from "react";
import { api } from "../api/client";
import {
  getProviderBaseUrl,
  matchProvider,
  PROVIDERS,
  type ProviderId,
} from "../constants/providers";
import type { Theme } from "../hooks/useTheme";
import type { AppSettings } from "../types";
import { useConfirm } from "./ConfirmDialog";

interface Props {
  open: boolean;
  onClose: () => void;
  theme: Theme;
  onChangeTheme: (t: Theme) => void;
  autoCopyToAux: boolean;
  onChangeAutoCopyToAux: (v: boolean) => void;
  autoCopyClearAux: boolean;
  onChangeAutoCopyClearAux: (v: boolean) => void;
  layoutLocked: boolean;
  onChangeLayoutLocked: (v: boolean) => void;
}

type TabId = "appearance" | "behavior" | "api";

interface TestResult {
  ok: boolean;
  detail: string;
}

const TABS: { id: TabId; label: string }[] = [
  { id: "appearance", label: "外观" },
  { id: "behavior", label: "选区行为" },
  { id: "api", label: "模型 / API" },
];

export function SettingsDialog({
  open,
  onClose,
  theme,
  onChangeTheme,
  autoCopyToAux,
  onChangeAutoCopyToAux,
  autoCopyClearAux,
  onChangeAutoCopyClearAux,
  layoutLocked,
  onChangeLayoutLocked,
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
  const [testing, setTesting] = useState(false);
  const [testMainResult, setTestMainResult] = useState<TestResult | null>(null);
  const [testAuxResult, setTestAuxResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

  useEffect(() => {
    if (!open) return;
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
      })
      .catch((e) => setError(String(e)));
  }, [open]);

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

  const save = async () => {
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
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

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

  const resetToEnv = async () => {
    const ok = await confirm({
      title: "重置为 .env 默认值？",
      message:
        "会丢弃前端这里覆盖保存过的 Base URL / API Key / 模型名，回退到后端 .env 里的配置。",
      confirmLabel: "重置",
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
    } catch (e) {
      setError(String(e));
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="bg-bg-panel border border-border-subtle rounded-xl w-full max-w-lg shadow-xl flex flex-col max-h-[90vh]"
      >
        <div className="px-5 pt-5 pb-3 flex items-center justify-between">
          <h3 id="settings-title" className="text-lg font-medium text-fg-primary">
            设置
          </h3>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="text-fg-muted hover:text-fg-primary"
          >
            ✕
          </button>
        </div>

        <div
          role="tablist"
          aria-label="设置分类"
          className="px-5 flex items-center gap-1 border-b border-border-subtle"
        >
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                className={`px-3 py-2 -mb-px text-sm border-b-2 transition ${
                  active
                    ? "text-fg-primary border-blue-500"
                    : "text-fg-secondary border-transparent hover:text-fg-primary"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto scrollbar-thin">
          {tab === "appearance" && (
            <>
              <Field label="外观主题">
                <ThemeSwitch value={theme} onChange={onChangeTheme} />
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

          {tab === "api" && (
            <>
              <Field label="服务商">
                <select
                  value={providerId}
                  onChange={(e) => {
                    const id = e.target.value as ProviderId;
                    setProviderId(id);
                    const preset = getProviderBaseUrl(id);
                    if (preset) setBaseUrl(preset);
                  }}
                  className="input cursor-pointer"
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
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
                    ? "已设置（留空表示不修改）"
                    : "尚未设置，请填入 API Key"
                }
              >
                <div className="flex items-stretch gap-2">
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={
                      current?.api_key_set ? "•••••••• (留空保留)" : "sk-..."
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
                  onClick={resetToEnv}
                  disabled={resetting || saving}
                  title="清除保存在数据库的覆盖，回退到 .env 配置"
                  className="text-sm text-fg-secondary hover:text-fg-primary underline-offset-2 hover:underline disabled:opacity-50 transition"
                >
                  {resetting ? "重置中…" : "重置为 .env 默认值"}
                </button>
              </div>
            </>
          )}

          {error && (
            <div className="text-sm text-red-500 dark:text-red-400 bg-red-500/10 dark:bg-red-950/30 border border-red-500/30 dark:border-red-900 rounded-md px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-border-subtle flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-md text-sm bg-bg-panelAlt text-fg-primary hover:bg-bg-hover transition"
          >
            取消
          </button>
          <button
            onClick={save}
            disabled={saving || resetting}
            className="px-4 py-2 rounded-md text-sm bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50 transition"
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
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

function ThemeSwitch({
  value,
  onChange,
}: {
  value: Theme;
  onChange: (t: Theme) => void;
}) {
  const options: { id: Theme; label: string; icon: React.ReactNode }[] = [
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
