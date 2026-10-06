export type Pane = "main" | "aux";
export type Role = "user" | "assistant";

export interface Session {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  session_id: string;
  pane: Pane;
  role: Role;
  content: string;
  created_at: string;
  local_status?: "unsaved" | "branched";
}

export interface AppSettings {
  api_base_url: string;
  api_key_set: boolean;
  model_main: string;
  model_aux: string;
  system_prompt_main: string;
  system_prompt_aux: string;
  max_output_tokens_main: number | null;
  max_output_tokens_aux: number | null;
  revision: number;
}

export interface PaneStats {
  message_count: number;
  total_tokens: number;
}

export interface MessageListResponse {
  messages: Message[];
  stats: PaneStats;
}

export interface ContextOptions {
  excluded_message_ids: string[];
  recent_turns: number | null;
  summary: string;
  max_context_tokens: number | null;
}

export interface ContextPreview {
  estimated_tokens: number;
  omitted_count: number;
  message_count: number;
  messages: { role: string; content: string }[];
}

export interface ExportedMessage {
  pane: Pane;
  role: Role;
  content: string;
  created_at: string;
}

export interface ExportedSession {
  title: string;
  created_at: string;
  updated_at: string;
  messages: ExportedMessage[];
}

export interface ConversationBackup {
  version: 1;
  exported_at: string;
  sessions: ExportedSession[];
}

export interface SearchResult {
  session_id: string;
  session_title: string;
  message_id?: string | null;
  pane?: Pane | null;
  role?: Role | null;
  snippet: string;
}

export interface UsageStats {
  session_count: number;
  message_count: number;
  main_messages: number;
  aux_messages: number;
  main_tokens: number;
  aux_tokens: number;
}
