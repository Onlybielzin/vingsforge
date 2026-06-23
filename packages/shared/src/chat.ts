/**
 * Chat threads, messages and content blocks. Spec 02 §3.
 */
import type { IsoDateString, ModelId, Usage } from './common.js';

export interface Chat {
  id: string;
  projectId: string;
  title: string;
  modelOverride?: ModelId;
  runtimeOverride?: string;
  /**
   * Claude Code CLI `session_id` captured from the engine, persisted per chat so
   * `claude --resume <id>` can continue the same CLI session across app restarts
   * (the CLI stores sessions under ~/.claude/projects/...). Absent on chats that
   * have never run a turn on the CLI engine, or on databases predating the column.
   */
  claudeSessionId?: string;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
  archived: boolean;
}

/** Lightweight chat row for lists (Spec 02 RF-02). */
export interface ChatSummary {
  id: string;
  projectId: string;
  title: string;
  updatedAt: IsoDateString;
  archived: boolean;
  /** Preview of the last message (Spec 02 RF-02). */
  lastMessagePreview?: string;
}

/**
 * A content block within a message turn (Spec 02 §3).
 * `thinking` is preserved verbatim (with signature) for replay (Spec 02 §3 note, Spec 08 §4).
 */
export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; signature?: string }
  | { kind: 'tool_use'; callId: string; tool: string; input: unknown }
  | { kind: 'tool_result'; callId: string; output: unknown; isError: boolean };

/**
 * A Claude Code CLI session created OUTSIDE the app (in the terminal), discovered
 * under `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`. Surfaced so a user
 * can import it and continue it inside VingsForge (`claude --resume <sessionId>`).
 * Lightweight on purpose: only enough to list and preview, not the full history.
 */
export interface ExternalSession {
  /** The CLI `session_id` — the `.jsonl` filename without its extension (a UUID). */
  sessionId: string;
  /** File mtime as an ISO date string; used to sort most-recent-first. */
  updatedAt: IsoDateString;
  /** First user-text snippet from the transcript, for display in a list. */
  preview: string;
  /** Best-effort count of user/assistant turns parsed from the transcript head. */
  turns?: number;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  role: 'user' | 'assistant';
  blocks: Block[];
  usage?: Usage;
  /**
   * Model that produced this message (assistant turns). Persisted so replay can
   * decide whether to keep or drop `thinking` blocks on a model switch (Spec 08 §4).
   */
  model?: ModelId;
  createdAt: IsoDateString;
}
