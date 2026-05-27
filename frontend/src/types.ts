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
}

export interface AppSettings {
  api_base_url: string;
  api_key_set: boolean;
  model_main: string;
  model_aux: string;
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
