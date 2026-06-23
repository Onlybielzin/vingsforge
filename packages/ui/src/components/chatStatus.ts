/**
 * Pure presentation helpers for per-chat status indicators (Sidebar tree +
 * ChatList rows). Kept framework-free in a `.ts` module so it can be unit-tested
 * under the package's node-env vitest (no DOM), mirroring externalSessions.ts.
 *
 * A chat is 'running' only when it is the ACTIVE chat AND its conversation is
 * currently streaming; everything else is 'idle'. The dot renders green and
 * pulsing (var(--vf-ok)) when running, neutral (var(--vf-text-faint)) otherwise.
 */

export type ChatStatus = 'running' | 'idle';

/**
 * Status for a single chat row.
 * @param chatId      the row's chat id
 * @param activeChatId the currently open chat (or null)
 * @param streaming   whether the active conversation is streaming a turn
 */
export function chatStatus(
  chatId: string,
  activeChatId: string | null,
  streaming: boolean,
): ChatStatus {
  return chatId === activeChatId && streaming ? 'running' : 'idle';
}

/** Dot color for a status: green when running, faint neutral when idle. */
export function statusColor(status: ChatStatus): string {
  return status === 'running' ? 'var(--vf-ok)' : 'var(--vf-text-faint)';
}

/** Whether the status dot should pulse (only the running chat does). */
export function statusPulses(status: ChatStatus): boolean {
  return status === 'running';
}
