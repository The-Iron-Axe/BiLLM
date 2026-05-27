import type { Message } from "../types";

const MAX_LEN = 40;

function truncate(text: string, max = MAX_LEN): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "…";
}

/** Brief one-line summary of user questions in this pane. */
export function paneQuestionSummary(
  messages: Message[],
  fallback: string,
): string {
  const questions = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  if (questions.length === 0) return fallback;
  if (questions.length === 1) return truncate(questions[0]);

  if (questions.length === 2) {
    return `${truncate(questions[0], 18)} · ${truncate(questions[1], 18)}`;
  }

  return `${truncate(questions[0], 28)} 等 ${questions.length} 问`;
}
