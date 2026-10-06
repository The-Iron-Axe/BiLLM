import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { ContextOptions, ContextPreview, Pane } from "../types";
import { defaultContextOptions } from "../utils/contextPreferences";

interface Props {
  sessionId: string;
  pane: Pane;
  options: ContextOptions;
  onChange: (options: ContextOptions) => void;
  draft: string;
  busy: boolean;
  messageCount: number;
  onSummaryBusy: (busy: boolean) => void;
}

export function ContextPanel({ sessionId, pane, options, onChange, draft, busy, messageCount, onSummaryBusy }: Props) {
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const mounted = useRef(true);
  const summaryController = useRef<AbortController | null>(null);
  const latestOptions = useRef(options);
  latestOptions.current = options;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      summaryController.current?.abort();
      onSummaryBusy(false);
    };
  }, [onSummaryBusy]);
  useEffect(() => {
    let active = true;
    setPreview(null);
    if (busy) return;
    const timer = window.setTimeout(() => {
      api.previewContext(sessionId, pane, options, draft).then((next) => {
        if (active) { setPreview(next); setError(null); }
      }).catch((e) => { if (active) setError(String(e)); });
    }, 300);
    return () => { active = false; window.clearTimeout(timer); };
  }, [sessionId, pane, options, draft, busy, messageCount]);

  const generateSummary = async () => {
    if (summaryController.current) return;
    const controller = new AbortController();
    summaryController.current = controller;
    setSummarizing(true);
    onSummaryBusy(true);
    setError(null);
    try {
      const result = await api.summarizeContext(sessionId, pane, options, controller.signal);
      if (mounted.current && !controller.signal.aborted) onChange({ ...latestOptions.current, summary: result.summary });
    } catch (e) {
      if (mounted.current) setError(controller.signal.aborted ? "摘要生成已取消。" : String(e));
    } finally {
      summaryController.current = null;
      if (mounted.current) { setSummarizing(false); onSummaryBusy(false); }
    }
  };
  const locked = busy || summarizing;
  return (
    <div className="border-b border-border-subtle px-5 py-3 bg-bg-panel text-xs space-y-3 max-h-[45vh] overflow-y-auto">
      <p className="text-fg-muted">只影响下次发送，不删除消息；设置按会话、栏位保存在当前浏览器。Token 为估算值，请为模型输出预留空间。</p>
      <p className="text-fg-muted">排除问题也会省略该轮回答；预算不足会省略最早整轮。最近轮数包含待发送的新问题。</p>
      <fieldset disabled={locked} className="flex flex-wrap gap-3 disabled:opacity-60">
        <label className="flex items-center gap-2">输入 Token 预算
          <ContextNumber value={options.max_context_tokens} min={128} max={2_000_000}
            placeholder="不限制" onChange={(value) => onChange({ ...options, max_context_tokens: value })} />
        </label>
        <label className="flex items-center gap-2">最近轮数
          <ContextNumber value={options.recent_turns} min={1} max={1000}
            placeholder="全部" onChange={(value) => onChange({ ...options, recent_turns: value })} />
        </label>
        <button type="button" onClick={() => onChange(defaultContextOptions())} className="text-fg-muted hover:text-fg-primary">恢复全部上下文</button>
      </fieldset>
      <label className="block space-y-1">
        <span>背景摘要（可编辑；搭配最近轮数减少重复历史）</span>
        <textarea value={options.summary} disabled={locked} maxLength={100_000} rows={3}
          className="w-full resize-y rounded border border-border-subtle bg-bg-base px-2 py-1 text-sm outline-none focus:border-blue-500"
          onChange={(e) => onChange({ ...options, summary: e.target.value })} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={locked || !messageCount} onClick={generateSummary}
          className="rounded border border-border-subtle px-2 py-1 hover:bg-bg-hover disabled:opacity-40">
          {summarizing ? "正在生成摘要…" : "生成摘要（调用本栏模型）"}
        </button>
        {summarizing && <button type="button" onClick={() => summaryController.current?.abort()}
          className="text-fg-muted hover:text-fg-primary">取消摘要</button>}
        <span className="text-fg-muted">摘要最多读取所选历史约 {options.max_context_tokens?.toLocaleString() ?? "16,000"} Token。</span>
      </div>
      {preview && <p className="text-fg-secondary">下次输入约 {preview.estimated_tokens.toLocaleString()} Token（含系统提示词），包含 {preview.message_count} 条对话消息（含待发送草稿），省略 {preview.omitted_count} 条历史。</p>}
      {busy && <p className="text-fg-muted">生成中使用发送时的上下文快照。</p>}
      {error && <p role="alert" className="text-red-500 break-words">{error}</p>}
    </div>
  );
}

export function ContextNumber({ value, min, max, placeholder, onChange }: {
  value: number | null; min: number; max: number; placeholder: string;
  onChange: (value: number | null) => void;
}) {
  const [text, setText] = useState(value?.toString() ?? "");
  useEffect(() => { setText(value?.toString() ?? ""); }, [value]);
  const valid = text === "" || (Number.isInteger(Number(text)) && Number(text) >= min && Number(text) <= max);
  return <span className="inline-flex flex-col gap-1">
    <input type="number" min={min} max={max} step={1} value={text} placeholder={placeholder}
      aria-invalid={!valid} className={`w-28 rounded border bg-bg-base px-2 py-1 ${valid ? "border-border-subtle" : "border-red-500"}`}
      onChange={(event) => {
        const raw = event.target.value;
        setText(raw);
        const n = raw === "" ? null : Number(raw);
        if (n === null || (Number.isInteger(n) && n >= min && n <= max)) onChange(n);
      }}
      onBlur={() => { if (!valid) setText(value?.toString() ?? ""); }} />
    {!valid && <span className="text-red-500">请输入 {min}–{max} 的整数，当前尚未应用</span>}
  </span>;
}
