/**
 * Pure extractor for the "Agentes" right-panel tab. Walks a ConversationState
 * and surfaces every subagent (Agent/Task) tool call in the order it appeared,
 * with its task label, lifecycle state, raw output text and parsed telemetry.
 *
 * No React / DOM dependency so it can be unit-tested in isolation — the live
 * component (AgentsPanel.tsx) consumes the AgentEntry[] this returns.
 */
import type { ConversationState, ToolState } from '../state/conversation.js';
import { isSubagentTool, outputToText, parseSubagentUsage, type SubagentUsage } from './subagentUsage.js';

export interface AgentEntry {
  callId: string;
  /** Best-effort task description from the tool input (truncated). */
  task: string;
  state: ToolState;
  /** Readable text of the subagent output (empty while still running). */
  outputText: string;
  /** Telemetry parsed from the output's `<usage>` block, or null. */
  usage: SubagentUsage | null;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Best-effort task description from the subagent's tool input. */
function taskLabel(input: unknown): string {
  const rec = asRecord(input);
  return (
    str(rec.description) ??
    str(rec.task) ??
    str(rec.prompt) ??
    str(rec.subagent_type) ??
    ''
  );
}

/** Collapses whitespace and truncates to `max` chars with an ellipsis. */
export function truncateTask(text: string, max = 96): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Returns every subagent tool call across all turns, in stream order. A call is
 * a subagent when its card.tool passes isSubagentTool.
 */
export function extractSubagents(conversation: ConversationState): AgentEntry[] {
  const out: AgentEntry[] = [];
  for (const turn of conversation.turns) {
    for (const item of turn.items) {
      if (item.kind !== 'tool') continue;
      const card = item.card;
      if (!isSubagentTool(card.tool)) continue;
      const outputText = outputToText(card.output);
      out.push({
        callId: card.callId,
        task: truncateTask(taskLabel(card.input)),
        state: card.state,
        outputText,
        usage: parseSubagentUsage(outputText),
      });
    }
  }
  return out;
}

/** True when the entry is actively working (pending counts as in-flight). */
export function isAgentRunning(entry: AgentEntry): boolean {
  return entry.state === 'running' || entry.state === 'pending';
}

/** Count of subagents currently running (used for the tab badge / summary). */
export function countRunning(entries: AgentEntry[]): number {
  return entries.reduce((n, e) => (isAgentRunning(e) ? n + 1 : n), 0);
}
