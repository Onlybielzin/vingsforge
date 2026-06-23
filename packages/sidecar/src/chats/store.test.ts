/**
 * ChatStore tests (Spec 02). The engine runner is mocked — NO real API call is
 * made. We assert CRUD, turn orchestration (user-turn persistence, event
 * forwarding, auto-title), interruption, and model/runtime override resolution.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDbStore, type DbStore } from '@vingsforge/persistence';
import type { ChatMessage, EngineEvent } from '@vingsforge/shared';
import {
  ChatNotFoundError,
  ChatStore,
  TurnInProgressError,
  UnknownModelError,
  type ChatContext,
  type ChatStoreDeps,
  type EngineTurnInput,
  type TurnResult,
} from './store.js';
import { RuntimeNotFoundError } from '../projects/manager.js';

function makeStore(over: Partial<ChatStoreDeps> = {}): {
  store: ChatStore;
  db: DbStore;
  resolveContext: ReturnType<typeof vi.fn>;
  runEngineTurn: ReturnType<typeof vi.fn>;
} {
  const db = createInMemoryDbStore();
  const resolveContext = vi.fn(
    (): ChatContext => ({ system: 'sys', model: 'claude-opus-4-8' }),
  );
  const runEngineTurn = vi.fn(
    async (_i: EngineTurnInput): Promise<TurnResult> => ({
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  );
  const deps: ChatStoreDeps = { db, resolveContext, runEngineTurn, ...over };
  return { store: new ChatStore(deps), db, resolveContext, runEngineTurn };
}

function seedProject(db: DbStore): string {
  const p = db.projects.create({ name: 'p', workspace: { kind: 'local', path: '/w' } });
  return p.id;
}

function seedRuntime(db: DbStore, id: string): string {
  db.runtimes.upsert({
    id,
    label: id,
    ssh: { host: 'h', port: 22, user: 'root', keyPath: '/k' },
    daemon: { installPath: '/opt/d', version: '1.0.0' },
    apiKeyLocation: 'daemon',
  });
  return id;
}

describe('ChatStore — CRUD', () => {
  let db: DbStore;
  let store: ChatStore;
  let projectId: string;

  beforeEach(() => {
    ({ store, db } = makeStore());
    projectId = seedProject(db);
  });

  it('creates, lists and isolates chats per project', async () => {
    const a = await store.create(projectId);
    const b = await store.create(projectId);
    expect(a.id).not.toBe(b.id);
    const list = await store.list(projectId);
    expect(list.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    expect(await store.list('other')).toHaveLength(0);
  });

  it('records model/runtime overrides on create (RF-08)', async () => {
    seedRuntime(db, 'vps-1');
    const chat = await store.create(projectId, { model: 'claude-sonnet-4-5', runtimeId: 'vps-1' });
    expect(chat.modelOverride).toBe('claude-sonnet-4-5');
    expect(chat.runtimeOverride).toBe('vps-1');
  });

  it("accepts the 'local' runtime sentinel without a registered runtime", async () => {
    const chat = await store.create(projectId, { runtimeId: 'local' });
    expect(chat.runtimeOverride).toBe('local');
  });

  it('rejects create with an unknown runtime override (Spec 05)', async () => {
    await expect(
      store.create(projectId, { runtimeId: 'ghost' }),
    ).rejects.toBeInstanceOf(RuntimeNotFoundError);
  });

  it('rejects create with a model outside the allowlist (Spec 07)', async () => {
    await expect(
      store.create(projectId, { model: 'gpt-4o' }),
    ).rejects.toBeInstanceOf(UnknownModelError);
  });

  it('rejects create for an unknown project', async () => {
    await expect(store.create('nope')).rejects.toThrow(/project not found/);
  });

  it('renames, archives and deletes', async () => {
    const chat = await store.create(projectId);
    await store.rename(chat.id, '  Hello  ');
    expect(db.chats.get(chat.id)?.title).toBe('Hello');

    await store.archive(chat.id);
    expect(db.chats.get(chat.id)?.archived).toBe(true);
    expect(await store.list(projectId)).toHaveLength(0);

    await store.delete(chat.id);
    expect(db.chats.get(chat.id)).toBeUndefined();
  });

  it('throws ChatNotFoundError for unknown chats', async () => {
    await expect(store.history('nope')).rejects.toBeInstanceOf(ChatNotFoundError);
    await expect(store.rename('nope', 'x')).rejects.toBeInstanceOf(ChatNotFoundError);
  });
});

describe('ChatStore — send / turn orchestration', () => {
  it('persists the user turn, forwards events, and auto-titles from the first message', async () => {
    const events: EngineEvent[] = [];
    const runEngineTurn = vi.fn(async (input: EngineTurnInput): Promise<TurnResult> => {
      // The engine would persist the assistant turn via the supplied hook.
      const assistant: ChatMessage = {
        id: 'asst-1',
        chatId: input.chatId,
        role: 'assistant',
        blocks: [{ kind: 'text', text: 'hi back' }],
        createdAt: new Date().toISOString(),
      };
      if (input.model !== undefined) assistant.model = input.model;
      input.persistAssistant(input.chatId, assistant);
      return { stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 3 } };
    });
    const { store, db } = makeStore({ runEngineTurn });
    const projectId = seedProject(db);
    const chat = await store.create(projectId);
    store.onEvent((e) => events.push(e));

    await store.send(chat.id, 'Fix the build pipeline please');

    // Title derived from the first message (RF-06).
    expect(db.chats.get(chat.id)?.title).toBe('Fix the build pipeline please');

    // History: user turn then assistant turn (RF-09).
    const history = await store.history(chat.id);
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history[0]?.blocks).toEqual([{ kind: 'text', text: 'Fix the build pipeline please' }]);

    // The engine received the resolved model and history WITHOUT the new user
    // turn (it appends userText itself).
    const input = runEngineTurn.mock.calls[0]?.[0] as EngineTurnInput;
    expect(input.model).toBe('claude-opus-4-8');
    expect(input.userText).toBe('Fix the build pipeline please');
    expect(input.history).toHaveLength(0);
  });

  it('rejects concurrent turns for the same chat', async () => {
    let release: () => void = () => {};
    let started = false;
    const gate = new Promise<void>((r) => (release = r));
    const runEngineTurn = vi.fn(async (): Promise<TurnResult> => {
      started = true;
      await gate;
      return { stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
    });
    const { store, db } = makeStore({ runEngineTurn });
    const projectId = seedProject(db);
    const chat = await store.create(projectId);

    const first = store.send(chat.id, 'one');
    await vi.waitFor(() => expect(started).toBe(true));
    await expect(store.send(chat.id, 'two')).rejects.toBeInstanceOf(TurnInProgressError);
    release();
    await first;
  });

  it('rejects a concurrent turn even when resolveContext is async (TOCTOU)', async () => {
    // resolveContext returns a still-pending promise, so the first send() is
    // parked on `await this.deps.resolveContext(chat)`. The guard must already
    // have reserved the in-flight slot synchronously, so the second send()
    // rejects rather than slipping past and double-billing the chat.
    let releaseContext: () => void = () => {};
    const contextGate = new Promise<void>((r) => (releaseContext = r));
    const resolveContext = vi.fn(async (): Promise<ChatContext> => {
      await contextGate;
      return { system: 'sys', model: 'claude-opus-4-8' };
    });
    const { store, db } = makeStore({ resolveContext });
    const projectId = seedProject(db);
    const chat = await store.create(projectId);

    const first = store.send(chat.id, 'one');
    await vi.waitFor(() => expect(resolveContext).toHaveBeenCalledTimes(1));
    await expect(store.send(chat.id, 'two')).rejects.toBeInstanceOf(TurnInProgressError);
    // The second turn never persisted a user message (no double-billing).
    expect(await store.history(chat.id)).toHaveLength(1);
    releaseContext();
    await first;
    // resolveContext ran exactly once — the second send() bailed at the guard.
    expect(resolveContext).toHaveBeenCalledTimes(1);
  });

  it('interrupt aborts the in-flight turn controller (RF-05)', async () => {
    let captured: EngineTurnInput | undefined;
    const runEngineTurn = vi.fn(async (input: EngineTurnInput): Promise<TurnResult> => {
      captured = input;
      await new Promise<void>((resolve) => {
        input.controller.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { stopReason: 'interrupted', usage: { inputTokens: 0, outputTokens: 0 } };
    });
    const { store, db } = makeStore({ runEngineTurn });
    const projectId = seedProject(db);
    const chat = await store.create(projectId);

    const turn = store.send(chat.id, 'long task');
    await vi.waitFor(() => expect(captured).toBeDefined());
    await store.interrupt(chat.id);
    await turn;
    expect(captured?.controller.signal.aborted).toBe(true);
  });

  it('emits an error event and rethrows when the engine fails', async () => {
    const events: EngineEvent[] = [];
    const runEngineTurn = vi.fn(async (): Promise<TurnResult> => {
      throw new Error('boom');
    });
    const { store, db } = makeStore({ runEngineTurn });
    const projectId = seedProject(db);
    const chat = await store.create(projectId);
    store.onEvent((e) => events.push(e));

    await expect(store.send(chat.id, 'hi')).rejects.toThrow('boom');
    expect(events).toContainEqual({ type: 'error', chatId: chat.id, message: 'boom' });
    // The user turn is still durable even though the turn failed (RF-09).
    expect(await store.history(chat.id)).toHaveLength(1);
  });
});
