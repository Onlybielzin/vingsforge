/**
 * Pure helpers for discovering and importing Claude Code CLI sessions created
 * OUTSIDE the app (in the terminal). The CLI stores each session as an NDJSON
 * transcript at `~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`:
 *
 *  - the folder name is the workspace's absolute cwd with every non-alphanumeric
 *    character replaced by `-` ({@link encodeProjectDir});
 *  - the file name (minus `.jsonl`) is the session UUID;
 *  - each line is one JSON object — a header `{type,mode,sessionId}` on line 1,
 *    then event lines whose `type` is one of user/assistant/system/... Only
 *    `user`/`assistant` lines carry a `message` ({role, content:[blocks]}) and a
 *    `cwd`.
 *
 * Everything here is a PURE function over already-read text so it is unit-testable
 * without touching the filesystem. The I/O (locating the folder, reading files,
 * confining to `~/.claude/projects`) lives in the ProjectManager/ChatStore.
 */
import type { Block, ChatMessage } from '@vingsforge/shared';

/** A Claude Code session id is the transcript filename: a v4-ish UUID. */
export const SESSION_ID_RE = /^[0-9a-fA-F-]{36}$/;

/** True when `id` is a syntactically valid Claude Code session id (UUID shape). */
export function isSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

/**
 * Encode an absolute cwd into the Claude Code projects-folder name: every
 * character that is NOT `[A-Za-z0-9]` becomes `-`. This is the EXACT rule the CLI
 * uses, so the encoded name round-trips to the on-disk folder. E.g.
 * `/home/vings/ereemby/apistoreV2` -> `-home-vings-ereemby-apistoreV2`;
 * `/home/vings/Área de trabalho/projetos/claude tools`
 *   -> `-home-vings--rea-de-trabalho-projetos-claude-tools`
 * (the accented `Á` is a single non-alnum char -> one `-`, like any space/slash).
 */
export function encodeProjectDir(absPath: string): string {
  return absPath.replace(/[^A-Za-z0-9]/g, '-');
}

/** Result of scanning the head of a transcript for a preview. */
export interface SessionPreview {
  /** First user-authored text found, trimmed/collapsed for a one-line preview. */
  preview: string;
  /** Count of user/assistant turns seen in the lines scanned. */
  turns: number;
  /** The `cwd` recorded on the first user/assistant line, if any (for validation). */
  cwd?: string;
}

/** Pull a flat text string out of a CLI `message.content` (string or block array). */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('\n');
}

/** Collapse whitespace and clamp to a sane preview length. */
function toPreview(text: string, max = 200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max).trimEnd()}…` : collapsed;
}

/**
 * Parse the head of a transcript (already split into NDJSON lines) into a preview:
 * the FIRST user-authored text, a turn count, and the recorded `cwd`. Tolerant of
 * malformed lines (each is parsed in isolation; bad lines are skipped) so a single
 * corrupt line never throws. Pass only the first N lines to keep this cheap on
 * huge transcripts.
 */
export function parseSessionPreview(lines: readonly string[]): SessionPreview {
  let preview = '';
  let turns = 0;
  let cwd: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object') continue;
      row = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.type !== 'user' && row.type !== 'assistant') continue;
    turns += 1;
    if (cwd === undefined && typeof row.cwd === 'string' && row.cwd.length > 0) {
      cwd = row.cwd;
    }
    if (preview.length === 0 && row.type === 'user') {
      const message = row.message as Record<string, unknown> | undefined;
      const text = message ? textFromContent(message.content) : '';
      const candidate = toPreview(text);
      if (candidate.length > 0) preview = candidate;
    }
  }

  const out: SessionPreview = { preview, turns };
  if (cwd !== undefined) out.cwd = cwd;
  return out;
}

/** A ChatMessage shape without the engine-assigned id/chatId/createdAt fields. */
export interface PartialImportedMessage {
  role: 'user' | 'assistant';
  blocks: Block[];
}

/** Map one CLI `message.content` array into our {@link Block} list. */
function blocksFromContent(content: unknown): Block[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ kind: 'text', text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: Block[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as Record<string, unknown>;
    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string' && b.text.length > 0) {
          blocks.push({ kind: 'text', text: b.text });
        }
        break;
      case 'tool_use':
        if (typeof b.id === 'string' && typeof b.name === 'string') {
          blocks.push({
            kind: 'tool_use',
            callId: b.id,
            tool: b.name,
            input: b.input,
          });
        }
        break;
      case 'tool_result':
        if (typeof b.tool_use_id === 'string') {
          blocks.push({
            kind: 'tool_result',
            callId: b.tool_use_id,
            output: b.content,
            isError: b.is_error === true,
          });
        }
        break;
      default:
        // thinking / unknown block types are skipped on import (best-effort).
        break;
    }
  }
  return blocks;
}

/**
 * Convert an NDJSON transcript (already split into lines) into a best-effort list
 * of importable messages. Only `user`/`assistant` lines with a `message` are
 * mapped; text -> {kind:'text'}, tool_use -> {kind:'tool_use'}, tool_result ->
 * {kind:'tool_result'}. Anything that does not map (thinking, system lines,
 * empty turns) is dropped. Never throws on a malformed line.
 *
 * Returns id-less/chatId-less rows; the caller assigns ids, chatId and timestamps
 * when persisting. Exported and pure for direct unit testing.
 */
export function jsonlToBlocks(lines: readonly string[]): PartialImportedMessage[] {
  const messages: PartialImportedMessage[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object') continue;
      row = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.type !== 'user' && row.type !== 'assistant') continue;
    const message = row.message as Record<string, unknown> | undefined;
    if (!message) continue;
    const blocks = blocksFromContent(message.content);
    if (blocks.length === 0) continue;
    messages.push({ role: row.type, blocks });
  }
  return messages;
}

/** Convenience: type guard for the {@link ChatMessage} shape used in tests. */
export type ImportedMessageLike = Pick<ChatMessage, 'role' | 'blocks'>;
