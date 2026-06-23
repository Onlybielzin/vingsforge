/**
 * Pure presentation helpers for the "continue a Claude Code session" modal
 * (Objetivo: importar sessões feitas no terminal). Kept fs-free and free of any
 * React/transport dependency so the formatting can be unit-tested under the
 * `node` test environment, exactly like updateState.ts / slashPopup.ts.
 */
import type { ExternalSession } from '@vingsforge/shared';

/** Loading / ready / error phases for the modal's async session listing. */
export type ExternalSessionsPhase = 'loading' | 'ready' | 'error';

export interface ExternalSessionsState {
  phase: ExternalSessionsPhase;
  sessions: ExternalSession[];
  /** Human-readable error message when `phase === 'error'`. */
  error?: string;
}

export const loadingSessions: ExternalSessionsState = { phase: 'loading', sessions: [] };

/** A successfully loaded (possibly empty) session list. */
export function readySessions(sessions: ExternalSession[]): ExternalSessionsState {
  return { phase: 'ready', sessions };
}

/** A failed load; the message is surfaced to the user. */
export function errorSessions(message: string): ExternalSessionsState {
  return { phase: 'error', sessions: [], error: message };
}

/**
 * Truncate a preview to a single line of at most `max` chars, collapsing internal
 * whitespace/newlines so a multi-line first message renders as one tidy row. An
 * empty/whitespace-only preview falls back to a stable placeholder.
 */
export function previewText(raw: string, max = 120): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0) return 'Sessão sem prévia';
  return oneLine.length > max ? `${oneLine.slice(0, max).trimEnd()}…` : oneLine;
}

/**
 * Format the turn count as a short label, e.g. `12 turnos` / `1 turno`. Returns
 * an empty string when the count is absent or non-positive so the caller can omit
 * the chip entirely.
 */
export function turnsLabel(turns: number | undefined): string {
  if (turns === undefined || turns <= 0) return '';
  return turns === 1 ? '1 turno' : `${turns} turnos`;
}

/**
 * Format an ISO date as a compact pt-BR `dd/mm/aaaa HH:MM`. Invalid/empty input
 * yields an empty string rather than `Invalid Date`, so a malformed `updatedAt`
 * never leaks into the UI. Pure: builds the string from UTC-agnostic local parts.
 */
export function formatSessionDate(iso: string): string {
  const d = new Date(iso);
  const t = d.getTime();
  if (Number.isNaN(t)) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}
