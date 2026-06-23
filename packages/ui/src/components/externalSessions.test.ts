/**
 * Tests for the "Continuar sessão do Claude" feature:
 *  - the pure presentation helpers (preview truncation, turn label, date format,
 *    async-state constructors) used by ExternalSessionsModal;
 *  - the import flow end-to-end against the mock IpcClient: list external sessions
 *    → importSession → the new chat appears in chats.list and is openable with its
 *    mirrored history (the exact flow the store's importExternalSession drives).
 *
 * Lives as a `.test.ts` so it runs under the package's `node` vitest environment
 * (no DOM), matching the other UI unit tests (updateState/slashPopup).
 */
import { describe, expect, it } from 'vitest';
import {
  errorSessions,
  formatSessionDate,
  loadingSessions,
  previewText,
  readySessions,
  turnsLabel,
} from './externalSessions.js';
import { createMockIpcClient } from '../ipc/mock.js';

describe('externalSessions — presentation helpers', () => {
  it('collapses whitespace and truncates a long preview with an ellipsis', () => {
    const raw = `line one\n\n   line two   with     spaces`;
    expect(previewText(raw, 80)).toBe('line one line two with spaces');
    const long = 'a'.repeat(200);
    const out = previewText(long, 20);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(21); // 20 chars + ellipsis
  });

  it('falls back to a placeholder for an empty/whitespace preview', () => {
    expect(previewText('   \n  ')).toBe('Sessão sem prévia');
  });

  it('pluralizes the turn label and omits it for absent/zero counts', () => {
    expect(turnsLabel(12)).toBe('12 turnos');
    expect(turnsLabel(1)).toBe('1 turno');
    expect(turnsLabel(0)).toBe('');
    expect(turnsLabel(undefined)).toBe('');
  });

  it('formats a valid ISO date and yields empty string for an invalid one', () => {
    expect(formatSessionDate('2026-06-22T09:05:00')).toBe('22/06/2026 09:05');
    expect(formatSessionDate('not-a-date')).toBe('');
    expect(formatSessionDate('')).toBe('');
  });

  it('builds the async-state objects', () => {
    expect(loadingSessions).toEqual({ phase: 'loading', sessions: [] });
    expect(readySessions([])).toEqual({ phase: 'ready', sessions: [] });
    const err = errorSessions('boom');
    expect(err.phase).toBe('error');
    expect(err.error).toBe('boom');
  });
});

describe('externalSessions — import flow (mock IpcClient)', () => {
  it('lists external sessions for a local project and none for a remote one', async () => {
    const ipc = createMockIpcClient();
    const local = await ipc.projects.externalSessions('p-local');
    expect(local.length).toBeGreaterThan(0);
    expect(local[0]).toHaveProperty('sessionId');
    expect(local[0]).toHaveProperty('preview');

    const remote = await ipc.projects.externalSessions('p-remote');
    expect(remote).toEqual([]);
  });

  it('imports a session as a new chat that appears in the list and opens with history', async () => {
    const ipc = createMockIpcClient();
    const sessions = await ipc.projects.externalSessions('p-local');
    const target = sessions[0]!;

    const before = await ipc.chats.list('p-local');
    const chat = await ipc.chats.importSession('p-local', target.sessionId);

    // The imported chat carries the CLI session id, so the next turn resumes it.
    expect(chat.claudeSessionId).toBe(target.sessionId);

    const after = await ipc.chats.list('p-local');
    expect(after.length).toBe(before.length + 1);
    expect(after.some((c) => c.id === chat.id)).toBe(true);

    // It opens with a non-empty mirrored history (so the chat is not blank).
    const history = await ipc.chats.history(chat.id);
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]!.role).toBe('user');
  });
});
