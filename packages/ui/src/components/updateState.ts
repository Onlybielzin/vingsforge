/**
 * Pure view-model for the in-app auto-updater UI (Objetivo 2). Folds the
 * `update.log` / `update.done` engine events into a small state machine the
 * modal renders. Kept side-effect-free so it can be unit-tested under the
 * `node` test environment.
 */
import type { EngineEvent } from '@vingsforge/shared';

/** Phase of an update run. */
export type UpdatePhase = 'idle' | 'running' | 'done' | 'error';

/** A single captured log line, tagged by the stream it came from. */
export interface UpdateLogLine {
  stream: 'stdout' | 'stderr';
  line: string;
}

export interface UpdateRunState {
  phase: UpdatePhase;
  lines: UpdateLogLine[];
  /** Terminal message from `update.done` (success note or error text). */
  message: string | null;
}

export function idleUpdate(): UpdateRunState {
  return { phase: 'idle', lines: [], message: null };
}

/** Resets to a fresh running state (called when the user starts a run). */
export function startUpdate(): UpdateRunState {
  return { phase: 'running', lines: [], message: null };
}

/**
 * Folds one engine event into the update state. Only `update.*` events mutate
 * it; everything else (chat traffic on the same channel) is ignored. Returns a
 * new object on change, the same reference otherwise.
 */
export function reduceUpdate(state: UpdateRunState, event: EngineEvent): UpdateRunState {
  switch (event.type) {
    case 'update.log':
      return {
        ...state,
        // First log implies the run is live even if `start` was missed.
        phase: state.phase === 'idle' ? 'running' : state.phase,
        lines: [...state.lines, { stream: event.stream, line: event.line }],
      };
    case 'update.done':
      return {
        ...state,
        phase: event.ok ? 'done' : 'error',
        message:
          event.message ??
          (event.ok
            ? 'Atualização instalada. Reabra o app para usar a nova versão.'
            : 'A atualização falhou. Veja o log acima.'),
      };
    default:
      return state;
  }
}

/** Human label for the banner given a status probe result. */
export function updateBannerText(behind: number): string {
  const plural = behind === 1 ? 'commit' : 'commits';
  return `Atualização disponível (${behind} ${plural})`;
}
