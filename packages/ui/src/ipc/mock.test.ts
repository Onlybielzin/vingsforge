/**
 * Tests for the in-memory mock IpcClient (Spec 06 §7).
 *
 * Covers:
 *  - command-boundary validation: the mock engine validates every EngineCommand
 *    with a zod discriminated union (defensive, mirrors a real transport) and
 *    rejects malformed / out-of-enum commands (security / replay hardening);
 *  - quick-mode gating in the scripted turn (Spec 04 §3.2): read-only disables
 *    bash, auto-approve runs without a permission prompt, otherwise the engine
 *    gates with a permission event;
 *  - permission resolve replay: allow vs deny produce ok vs error results;
 *  - project/chat data plumbing + unknown-id errors;
 *  - the chatId carried on every event matches the requested chat (confinement).
 */
import { describe, expect, it, vi } from 'vitest';
import type { EngineCommand, EngineEvent } from '@vingsforge/shared';
import { createMockIpcClient } from './mock.js';

/** Collects engine events until `predicate` is satisfied or the timeout fires. */
function collectUntil(
  ipc: ReturnType<typeof createMockIpcClient>,
  predicate: (events: EngineEvent[]) => boolean,
  timeoutMs = 3000,
): Promise<EngineEvent[]> {
  return new Promise((resolve, reject) => {
    const events: EngineEvent[] = [];
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timeout; got: ${events.map((e) => e.type).join(',')}`));
    }, timeoutMs);
    const unsub = ipc.engine.onEvent((e) => {
      events.push(e);
      if (predicate(events)) {
        clearTimeout(timer);
        unsub();
        resolve(events);
      }
    });
  });
}

describe('mock engine — command-boundary validation', () => {
  it('rejects an unknown command type', async () => {
    const ipc = createMockIpcClient();
    await expect(ipc.engine.send({ type: 'nope' } as unknown as EngineCommand)).rejects.toThrow();
  });

  it('rejects engine.send without a chatId', async () => {
    const ipc = createMockIpcClient();
    await expect(
      ipc.engine.send({ type: 'engine.send', text: 'hi' } as unknown as EngineCommand),
    ).rejects.toThrow();
  });

  it('rejects a permission resolution with an out-of-enum decision', async () => {
    const ipc = createMockIpcClient();
    await expect(
      ipc.engine.send({
        type: 'tool.permission.resolve',
        chatId: 'c-1',
        callId: 'k1',
        decision: 'maybe',
      } as unknown as EngineCommand),
    ).rejects.toThrow();
  });

  it('rejects a permission resolution missing callId', async () => {
    const ipc = createMockIpcClient();
    await expect(
      ipc.engine.send({
        type: 'tool.permission.resolve',
        chatId: 'c-1',
        decision: 'allow',
      } as unknown as EngineCommand),
    ).rejects.toThrow();
  });

  it('accepts a well-formed engine.send (no throw)', async () => {
    const ipc = createMockIpcClient();
    await expect(
      ipc.engine.send({ type: 'engine.send', chatId: 'c-1', text: 'hi' }),
    ).resolves.toBeUndefined();
  });
});

describe('mock engine — scripted turn + quick-mode gating (Spec 04 §3.2)', () => {
  it('default turn streams thinking/text/tool and stops at a permission prompt', async () => {
    const ipc = createMockIpcClient();
    const pending = collectUntil(ipc, (es) => es.some((e) => e.type === 'tool.permission'));
    await ipc.engine.send({ type: 'engine.send', chatId: 'c-1', text: 'run ls' });
    const events = await pending;

    const types = events.map((e) => e.type);
    expect(types).toContain('thinking.delta');
    expect(types).toContain('message.delta');
    expect(types).toContain('tool.start');
    const perm = events.find((e) => e.type === 'tool.permission')!;
    expect(perm).toMatchObject({ tool: 'bash' });
    // No result/turn.end yet — flow is blocked on the gate.
    expect(types).not.toContain('tool.result');
  });

  it('read-only mode disables bash and ends the turn with an error result', async () => {
    const ipc = createMockIpcClient();
    const pending = collectUntil(ipc, (es) => es.some((e) => e.type === 'turn.end'));
    await ipc.engine.send({
      type: 'engine.send',
      chatId: 'c-1',
      text: 'run ls',
      context: { system: '', history: [], modes: { readOnly: true } },
    });
    const events = await pending;

    const result = events.find((e) => e.type === 'tool.result');
    expect(result).toMatchObject({ isError: true });
    expect(String((result as { output: unknown }).output)).toMatch(/read-only/i);
    // Never asked for permission in read-only mode.
    expect(events.some((e) => e.type === 'tool.permission')).toBe(false);
  });

  it('auto-approve mode runs the tool without a permission prompt', async () => {
    const ipc = createMockIpcClient();
    const pending = collectUntil(ipc, (es) => es.some((e) => e.type === 'turn.end'));
    await ipc.engine.send({
      type: 'engine.send',
      chatId: 'c-1',
      text: 'run ls',
      context: { system: '', history: [], modes: { autoApprove: true } },
    });
    const events = await pending;

    const result = events.find((e) => e.type === 'tool.result');
    expect(result).toMatchObject({ isError: false });
    expect(events.some((e) => e.type === 'tool.permission')).toBe(false);
  });

  it('every emitted event carries the requested chatId (confinement)', async () => {
    const ipc = createMockIpcClient();
    const pending = collectUntil(ipc, (es) => es.some((e) => e.type === 'turn.end'));
    await ipc.engine.send({
      type: 'engine.send',
      chatId: 'c-9',
      text: 'run ls',
      context: { system: '', history: [], modes: { autoApprove: true } },
    });
    const events = await pending;

    expect(events.every((e) => 'chatId' in e && e.chatId === 'c-9')).toBe(true);
  });
});

describe('mock engine — permission resolution replay', () => {
  it('allow produces a non-error tool.result then a final message + turn.end', async () => {
    const ipc = createMockIpcClient();
    const pending = collectUntil(ipc, (es) => es.some((e) => e.type === 'turn.end'));
    await ipc.engine.send({
      type: 'tool.permission.resolve',
      chatId: 'c-1',
      callId: 'k1',
      decision: 'allow',
    });
    const events = await pending;

    const result = events.find((e) => e.type === 'tool.result')!;
    expect(result).toMatchObject({ callId: 'k1', isError: false });
    expect(events.filter((e) => e.type === 'message.delta').length).toBeGreaterThan(0);
  });

  it('deny produces an error result echoing the reason', async () => {
    const ipc = createMockIpcClient();
    const pending = collectUntil(ipc, (es) => es.some((e) => e.type === 'tool.result'));
    await ipc.engine.send({
      type: 'tool.permission.resolve',
      chatId: 'c-1',
      callId: 'k1',
      decision: 'deny',
      reason: 'not allowed',
    });
    const events = await pending;

    const result = events.find((e) => e.type === 'tool.result')!;
    expect(result).toMatchObject({ callId: 'k1', isError: true, output: 'not allowed' });
  });

  it('interrupt clears timers and emits turn.end with interrupted stop reason', async () => {
    const ipc = createMockIpcClient();
    const pending = collectUntil(ipc, (es) => es.some((e) => e.type === 'turn.end'));
    await ipc.engine.send({ type: 'engine.interrupt', chatId: 'c-1' });
    const events = await pending;

    const end = events.find((e) => e.type === 'turn.end')!;
    expect(end).toMatchObject({ stopReason: 'interrupted' });
  });
});

describe('mock IpcClient — data plumbing', () => {
  it('lists seeded projects and opens one with its chats', async () => {
    const ipc = createMockIpcClient();
    const projects = await ipc.projects.list();
    expect(projects.map((p) => p.id)).toContain('p-local');
    const opened = await ipc.projects.open('p-local');
    expect(opened.project.id).toBe('p-local');
    expect(opened.chats.length).toBeGreaterThan(0);
  });

  it('throws when opening an unknown project', async () => {
    const ipc = createMockIpcClient();
    await expect(ipc.projects.open('does-not-exist')).rejects.toThrow(/Unknown project/);
  });

  it('chats.send appends the user message to history before streaming', async () => {
    const ipc = createMockIpcClient();
    const before = (await ipc.chats.history('c-1')).length;
    await ipc.chats.send('c-1', 'a new question', { autoApprove: true });
    const after = await ipc.chats.history('c-1');
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)).toMatchObject({ role: 'user' });
  });

  it('returns isolated structuredClones (mutating a result does not corrupt the store)', async () => {
    const ipc = createMockIpcClient();
    const a = await ipc.projects.list();
    a[0]!.name = 'mutated';
    const b = await ipc.projects.list();
    expect(b[0]!.name).not.toBe('mutated');
  });

  it('lists git worktrees for a local project (main + extra checkouts)', async () => {
    const ipc = createMockIpcClient();
    const worktrees = await ipc.projects.worktrees('p-local');
    expect(worktrees.length).toBeGreaterThan(0);
    const main = worktrees.find((w) => w.isMain);
    expect(main).toBeDefined();
    expect(main!.branch).toBe('main');
    // A detached + locked checkout is surfaced without a branch.
    const detached = worktrees.find((w) => w.isDetached);
    expect(detached).toMatchObject({ isLocked: true });
    expect(detached!.branch).toBeUndefined();
    // HEADs are full SHAs the UI shortens to 7 chars.
    expect(main!.head.slice(0, 7)).toHaveLength(7);
  });

  it('returns no worktrees for a remote (non-local) project', async () => {
    const ipc = createMockIpcClient();
    const projects = await ipc.projects.list();
    const remote = projects.find((p) => p.workspace.kind !== 'local');
    if (remote) expect(await ipc.projects.worktrees(remote.id)).toEqual([]);
    // Unknown project ids are also empty (no repo to inspect).
    expect(await ipc.projects.worktrees('does-not-exist')).toEqual([]);
  });

  it('newly created chat starts with empty history', async () => {
    const ipc = createMockIpcClient();
    const chat = await ipc.chats.create('p-local', { model: 'claude-opus-4-8' });
    expect(await ipc.chats.history(chat.id)).toEqual([]);
  });

  it('onEvent unsubscribe stops further delivery', async () => {
    const ipc = createMockIpcClient();
    const spy = vi.fn();
    const unsub = ipc.engine.onEvent(spy);
    unsub();
    await ipc.engine.send({
      type: 'engine.send',
      chatId: 'c-1',
      text: 'x',
      context: { system: '', history: [], modes: { autoApprove: true } },
    });
    await new Promise((r) => setTimeout(r, 900));
    expect(spy).not.toHaveBeenCalled();
  });
});
