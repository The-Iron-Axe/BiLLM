export type ProviderId =
  | "openai"
  | "gemini"
  | "anthropic"
  | "minimax"
  | "glm"
  | "deepseek"
  | "grok"
  | "qwen"
  | "kimi"
  | "siliconflow"
  | "custom";

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  /** OpenAI-compatible base URL; `null` for custom (user types manually). */
  baseUrl: string | null;
}

/** Preset service providers (OpenAI-compatible `base_url` values). */
export const PROVIDERS: ProviderPreset[] = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  {
    id: "gemini",
    label: "Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
  },
  { id: "minimax", label: "MiniMax", baseUrl: "https://api.minimax.chat/v1" },
  { id: "glm", label: "GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { id: "grok", label: "Grok", baseUrl: "https://api.x.ai/v1" },
  {
    id: "qwen",
    label: "Qwen",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  { id: "kimi", label: "Kimi", baseUrl: "https://api.moonshot.cn/v1" },
  {
    id: "siliconflow",
    label: "硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
  },
  { id: "custom", label: "自定义", baseUrl: null },
];

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function matchProvider(baseUrl: string): ProviderId {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return "custom";
  for (const p of PROVIDERS) {
    if (p.baseUrl && normalizeBaseUrl(p.baseUrl) === normalized) {
      return p.id;
    }
  }
  return "custom";
}

export function getProviderBaseUrl(id: ProviderId): string | null {
  return PROVIDERS.find((p) => p.id === id)?.baseUrl ?? null;
}
