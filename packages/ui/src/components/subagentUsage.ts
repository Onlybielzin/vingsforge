/**
 * Pure helpers for rendering a subagent (Agent/Task) tool call nicely.
 *
 * The subagent's tool output is an array of text blocks whose LAST block carries
 * telemetry in a `<usage>…</usage>` envelope plus a boilerplate `agentId: …`
 * line. The useful text the subagent produced comes BEFORE that. These helpers
 * extract the telemetry, strip the noise, and format durations — with no React
 * or DOM dependency so they can be unit-tested in isolation.
 */

/** True for the subagent dispatch tools ('Agent' / 'Task'), case-insensitive. */
export function isSubagentTool(tool: string): boolean {
  const t = tool.trim().toLowerCase();
  return t === 'agent' || t === 'task';
}

export interface SubagentUsage {
  tokens?: number;
  tools?: number;
  durationMs?: number;
}

/**
 * Pulls the readable text out of a tool_result `output` shape. Accepts a raw
 * string, a single block ({text} / {content}), or an array of such blocks —
 * mirroring ToolCard's own `outputToText` so callers can pass `card.output`
 * straight through.
 */
export function outputToText(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output.map(blockText).filter(Boolean).join('\n');
  }
  return blockText(output);
}

function blockText(block: unknown): string {
  if (typeof block === 'string') return block;
  if (block && typeof block === 'object') {
    const rec = block as Record<string, unknown>;
    if (typeof rec.text === 'string') return rec.text;
    if (typeof rec.content === 'string') return rec.content;
  }
  return '';
}

/**
 * Extracts `subagent_tokens`, `tool_uses` and `duration_ms` from the
 * `<usage>…</usage>` block. Tolerant of fields separated by newlines OR commas,
 * of missing fields, and of surrounding whitespace. Returns null when there is
 * no `<usage>` block at all.
 */
export function parseSubagentUsage(text: string): SubagentUsage | null {
  const span = findUsageSpan(text.toLowerCase(), 0);
  if (!span) return null;
  const body = text.slice(span.bodyStart, span.bodyEnd);
  const usage: SubagentUsage = {};
  const tokens = field(body, 'subagent_tokens');
  const tools = field(body, 'tool_uses');
  const duration = field(body, 'duration_ms');
  if (tokens != null) usage.tokens = tokens;
  if (tools != null) usage.tools = tools;
  if (duration != null) usage.durationMs = duration;
  return usage;
}

const OPEN_TAG = '<usage>';
const CLOSE_TAG = '</usage>';

interface UsageSpan {
  /** Index of the `<usage>` opening tag. */
  start: number;
  /** Index just after the opening tag (start of body). */
  bodyStart: number;
  /** Index of the `</usage>` closing tag (end of body). */
  bodyEnd: number;
  /** Index just after the closing tag. */
  end: number;
}

/**
 * Finds the first complete `<usage>…</usage>` envelope at or after `from`, using
 * plain `indexOf` (case-insensitive) so it is strictly linear in the input size —
 * no regex backtracking / ReDoS even with many unclosed `<usage>` openings.
 * Returns null when no closed envelope exists.
 */
function findUsageSpan(lower: string, from: number): UsageSpan | null {
  const start = lower.indexOf(OPEN_TAG, from);
  if (start === -1) return null;
  const bodyStart = start + OPEN_TAG.length;
  // The earliest `</usage>` after this opening closes the envelope. Any extra
  // `<usage>` openings before it are just part of the (inert) body text.
  const bodyEnd = lower.indexOf(CLOSE_TAG, bodyStart);
  if (bodyEnd === -1) return null;
  return { start, bodyStart, bodyEnd, end: bodyEnd + CLOSE_TAG.length };
}

/** Reads `name: <number>` from a usage body, regardless of newline/comma separators. */
function field(body: string, name: string): number | undefined {
  const m = new RegExp(`${name}\\s*:\\s*(-?\\d+)`, 'i').exec(body);
  if (!m || m[1] == null) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Strips the `<usage>…</usage>` envelope and the `agentId: … (use SendMessage …)`
 * boilerplate line(s), leaving only the subagent's useful prose (trimmed).
 */
export function cleanSubagentOutput(text: string): string {
  return stripUsageBlocks(text)
    .replace(/^\s*agentId:\s*\S+\s*\(use SendMessage\b.*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Removes every complete `<usage>…</usage>` envelope via linear `indexOf`
 * slicing (no regex), so adversarial input with many unclosed `<usage>`
 * openings can never trigger quadratic backtracking.
 */
function stripUsageBlocks(text: string): string {
  const lower = text.toLowerCase();
  let out = '';
  let from = 0;
  for (let span = findUsageSpan(lower, from); span; span = findUsageSpan(lower, from)) {
    out += text.slice(from, span.start);
    from = span.end;
  }
  return out + text.slice(from);
}

/** Human-friendly duration: 5440 → "5.4s", 65000 → "1m5s", 800 → "0.8s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 60000) {
    // Keep one decimal under a minute for finer granularity (5440 → "5.4s").
    const oneDecimal = Math.round(ms / 100) / 10;
    return `${oneDecimal}s`;
  }
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return sec === 0 ? `${min}m` : `${min}m${sec}s`;
}
