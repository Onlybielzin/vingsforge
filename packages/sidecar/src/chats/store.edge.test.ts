/**
 * ChatStore edge & security tests (Spec 02). These complement store.test.ts and
 * focus on the boundaries the happy-path suite does not exercise:
 *
 *  - Input validation / DoS guards (message-text bounds, title bounds).
 *  - Override re-validation on send() for overrides that bypassed create()
 *    (defence in depth — Spec 05/07: never route a turn to an unknown
 *    runtime/model).
 *  - Lifecycle races: delete()/interrupt() interacting with an in-flight turn,
 *    and a chat removed mid-turn (during the async resolveContext await) must
 *    not leave orphan assistant/tool turns or emit events for a dead chat.
 *  - Persistence durability of tool_result turns and event-stream fan-out.
 *
 * The engine runner is mocked — NO real API call is made.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDbStore, type DbStore } from '@vingsforge/persistence';
import type { EngineEvent } from '@vingsforge/shared';
import {
  ChatNotFoundError,
  ChatStore,
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

// --- Input validation / DoS guards (Spec 02 §5) ----------------------------

describe('ChatStore — input validation', () => {
  let db: DbStore;
  let store: ChatStore;
  let projectId: string;
  let chatId: string;

  beforeEach(async () => {
    ({ store, db } = makeStore());
    projectId = seedProject(db);
    chatId = (await store.create(projectId)).id;
  });

  it('rejects an empty message', async () => {
    await expect(store.send(chatId, '')).rejects.toThrow();
    // Nothing was persisted (no double-billing / orphan user turn).
    expect(await store.history(chatId)).toHaveLength(0);
  });

  it('rejects an oversized message (DoS / cost guard)', async () => {
    const huge = 'a'.repeat(200_001);
    await expect(store.send(chatId, huge)).rejects.toThrow();
    expect(await store.history(chatId)).toHaveLength(0);
  });

  it('accepts a message exactly at the size boundary', async () => {
    const atMax = 'a'.repeat(200_000);
    await expect(store.send(chatId, atMax)).resolves.toBeUndefined();
    const history = await store.history(chatId);
    expect(history[0]?.blocks).toEqual([{ kind: 'text', text: atMax }]);
  });

  it('rejects a non-string message at runtime', async () => {
    // Untrusted IPC payloads may not respect the static type — the zod schema
    // is the real boundary.
    await expect(
      store.send(chatId, 123 as unknown as string),
    ).rejects.toThrow();
    expect(await store.history(chatId)).toHaveLength(0);
  });

  it('rejects an empty / whitespace-only title on rename', async () => {
    await expect(store.rename(chatId, '   ')).rejects.toThrow();
    await expect(store.rename(chatId, '')).rejects.toThrow();
  });

  it('rejects an over-long title on rename (200 char bound)', async () => {
    await expect(store.rename(chatId, 'x'.repeat(201))).rejects.toThrow();
    await expect(store.rename(chatId, 'x'.repeat(200))).resolves.toBeUndefined();
  });

  it('rejects unknown keys in create opts (strict schema)', async () => {
    await expect(
      store.create(projectId, { evil: true } as unknown as { model?: string }),
    ).rejects.toThrow();
  });

  it('validates the chat exists before validating override on rename order', async () => {
    // requireChat fires for unknown chats regardless of a valid title.
    await expect(store.rename('ghost', 'fine title')).rejects.toBeInstanceOf(
      ChatNotFoundError,
    );
  });
});

// --- Override re-validation on send (defence in depth, Spec 05/07) ----------

describe('ChatStore — send re-validates resolved overrides', () => {
  it('rejects a turn whose resolved model is outside the allowlist', async () => {
    // resolveContext returns a model that never passed create()'s guard (e.g.
    // a legacy/persisted override). send() must re-check it before routing.
    const resolveContext = vi.fn(
      (): ChatContext => ({ system: 'sys', model: 'gpt-4o' }),
    );
    const { store, db, runEngineTurn } = makeStore({ resolveContext });
    const projectId = seedProject(db);
    const chat = await store.create(projectId);

    await expect(store.send(chat.id, 'hi')).rejects.toBeInstanceOf(
      UnknownModelError,
    );
    // The turn never reached the engine.
    expect(runEngineTurn).not.toHaveBeenCalled();
    // The user turn was still persisted before the guard tripped (durable
    // history, Spec 02 RF-09) — but no assistant turn exists.
    const history = await store.history(chat.id);
    expect(history.map((m) => m.role)).toEqual(['user']);
  });

  it('rejects a turn whose resolved runtime does not exist', async () => {
    const resolveContext = vi.fn(
      (): ChatContext => ({ system: 'sys', runtimeId: 'ghost' }),
    );
    const { store, db, runEngineTurn } = makeStore({ resolveContext });
    const projectId = seedProject(db);
    const chat = await store.create(projectId);

    await expect(store.send(chat.id, 'hi')).rejects.toBeInstanceOf(
      RuntimeNotFoundError,
    );
    expect(runEngineTurn).not.toHaveBeenCalled();
  });

  it("accepts the resolved 'local' runtime sentinel without a runtimes row", async () => {
    const resolveContext = vi.fn(
      (): ChatContext => ({ system: 'sys', runtimeId: 'local' }),
    );
    const { store, db, runEngineTurn } = makeStore({ resolveContext });
    const projectId = seedProject(db);
    const chat = await store.create(projectId);

    await expect(store.send(chat.id, 'hi')).resolves.toBeUndefined();
    const input = runEngineTurn.mock.calls[0]?.[0] as EngineTurnInput;
    expect(input.runtimeId).toBe('local');
  });

  it('forwards a known resolved runtime through to the engine', async () => {
    const { store, db, runEngineTurn } = makeStore({
      resolveContext: vi.fn(
        (): ChatContext => ({ system: 'sys', runtimeId: 'vps-1' }),
      ),
    });
    const projectId = seedProject(db);
    seedRuntime(db, 'vps-1');
    const chat = await store.create(projectId);

    await store.send(chat.id, 'hi');
    const input = runEngineTurn.mock.calls[0]?.[0] as EngineTurnInput;
    expect(input.runtimeId).toBe('vps-1');
  });
});

// --- Lifecycle races: delete / interrupt vs in-flight turn (Spec 02 RF-05/07)

describe('ChatStore — lifecycle races', () => {
  it('delete() interrupts the in-flight turn and removes the chat', async () => {
    let captured: EngineTurnInput | undefined;
    const runEngineTurn = vi.fn(async (input: EngineTurnInput): Promise<TurnResult> => {
      captured = input;
      await new Promise<void>((resolve) => {
        input.controller.signal.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
      return { stopReason: 'interrupted', usage: { inputTokens: 0, outputTokens: 0 } };
    });
    const { store, db } = makeStore({ runEngineTurn });
    const projectId = seedProject(db);
    const chat = await store.create(projectId);

    const turn = store.send(chat.id, 'long task');
    await vi.waitFor(() => expect(captured).toBeDefined());

    await store.delete(chat.id);
    // The running turn's controller was aborted (no event for a dead chat).
    expect(captured?.controller.signal.aborted).toBe(true);
    await turn;
    expect(db.chats.get(chat.id)).toBeUndefined();
    // History is gone with the chat.
    await expect(store.history(chat.id)).rejects.toBeInstanceOf(ChatNotFoundError);
  });

  it('a chat removed during resolveContext does not get an assistant turn', async () => {
    // resolveContext is async; delete() lands while send() is parked on it. The
    // post-await requireChat() must throw so the engine never runs and no
    // orphan assistant/tool turn is persisted for a non-existent chat.
    let releaseContext: () => void = () => {};
    const contextGate = new Promise<void>((r) => (releaseContext = r));
    const resolveContext = vi.fn(async (): Promise<ChatContext> => {
      await contextGate;
      return { system: 'sys', model: 'claude-opus-4-8' };
    });
    const runEngineTurn = vi.fn(
      async (): Promise<TurnResult> => ({
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    );
    const { store, db } = makeStore({ resolveContext, runEngineTurn });
    const projectId = seedProject(db);
    const chat = await store.create(projectId);

    const turn = store.send(chat.id, 'hi');
    await vi.waitFor(() => expect(resolveContext).toHaveBeenCalledTimes(1));

    // Delete while the first send() is parked on resolveContext.
    await store.delete(chat.id);
    releaseContext();

    await expect(turn).rejects.toBeInstanceOf(ChatNotFoundError);
    // The engine was never invoked for the dead chat.
    expect(runEngineTurn).not.toHaveBeenCalled();
    expect(db.chats.get(chat.id)).toBeUndefined();
  });

  it('interrupt() on an idle chat is a no-op', async () => {
    const { store, db } = makeStore();
    const projectId = seedProject(db);
    const chat = await store.create(projectId);
    await expect(store.interrupt(chat.id)).resolves.toBeUndefined();
  });

  it('a fresh send() succeeds after the prior turn was interrupted', async () => {
    // The in-flight slot must be released after interruption so the chat is not
    // wedged in a permanent TurnInProgress state.
    let captured: EngineTurnInput | undefined;
    const runEngineTurn = vi
      .fn()
      .mockImplementationOnce(async (input: EngineTurnInput): Promise<TurnResult> => {
        captured = input;
        await new Promise<void>((resolve) => {
          input.controller.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        return { stopReason: 'interrupted', usage: { inputTokens: 0, outputTokens: 0 } };
      })
      .mockImplementationOnce(
        async (): Promise<TurnResult> => ({
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      );
    const { store, db } = makeStore({ runEngineTurn });
    const projectId = seedProject(db);
    const chat = await store.create(projectId);

    const first = store.send(chat.id, 'one');
    await vi.waitFor(() => expect(captured).toBeDefined());
    await store.interrupt(chat.id);
    await first;

    // Second turn is accepted (slot released).
    await expect(store.send(chat.id, 'two')).resolves.toBeUndefined();
    expect(runEngineTurn).toHaveBeenCalledTimes(2);
  });
});

// --- Persistence & event stream -------------------------------------------

describe('ChatStore — persistence & events', () => {
  it('persists a tool_result user turn via the persistToolResults hook (RF-09)', async () => {
    const runEngineTurn = vi.fn(async (input: EngineTurnInput): Promise<TurnResult> => {
      // Engine emits an assistant tool_use turn, then a user turn carrying the
      // batched tool_result, then a final assistant text turn.
      const now = new Date().toISOString();
      input.persistAssistant(input.chatId, {
        id: 'asst-tooluse',
        chatId: input.chatId,
        role: 'assistant',
        blocks: [{ kind: 'tool_use', callId: 'c1', tool: 'read', input: { path: '/x' } }],
        ...(input.model !== undefined ? { model: input.model } : {}),
        createdAt: now,
      });
      input.persistToolResults(input.chatId, {
        id: 'tool-result',
        chatId: input.chatId,
        role: 'user',
        blocks: [{ kind: 'tool_result', callId: 'c1', output: 'file body', isError: false }],
        createdAt: now,
      });
      input.persistAssistant(input.chatId, {
        id: 'asst-final',
        chatId: input.chatId,
        role: 'assistant',
        blocks: [{ kind: 'text', text: 'done' }],
        ...(input.model !== undefined ? { model: input.model } : {}),
        createdAt: now,
      });
      return { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5 } };
    });
    const { store, db } = makeStore({ runEngineTurn });
    const projectId = seedProject(db);
    const chat = await store.create(projectId);

    await store.send(chat.id, 'read /x');

    const history = await store.history(chat.id);
    // user(text) -> assistant(tool_use) -> user(tool_result) -> assistant(text)
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const toolResultTurn = history[2];
    expect(toolResultTurn?.blocks).toEqual([
      { kind: 'tool_result', callId: 'c1', output: 'file body', isError: false },
    ]);
    // The assistant turn carries the model so replay can reconcile thinking.
    expect(history[1]?.model).toBe('claude-opus-4-8');
  });

  it('fans events out to multiple listeners and honours unsubscribe', async () => {
    const a: EngineEvent[] = [];
    const b: EngineEvent[] = [];
    const runEngineTurn = vi.fn(async (input: EngineTurnInput): Promise<TurnResult> => {
      input.persistAssistant(input.chatId, {
        id: 'm',
        chatId: input.chatId,
        role: 'assistant',
        blocks: [{ kind: 'text', text: 'x' }],
        createdAt: new Date().toISOString(),
      });
      return { stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
    });
    const { store, db } = makeStore({ runEngineTurn });
    const projectId = seedProject(db);
    const chat = await store.create(projectId);

    store.onEvent((e) => a.push(e));
    const off = store.onEvent((e) => b.push(e));

    // Force an error event through emit() by failing the engine.
    runEngineTurn.mockRejectedValueOnce(new Error('boom'));
    await expect(store.send(chat.id, 'first')).rejects.toThrow('boom');

    off(); // b unsubscribes before the second turn.
    await store.send(chat.id, 'second');

    expect(a).toContainEqual({ type: 'error', chatId: chat.id, message: 'boom' });
    expect(b).toContainEqual({ type: 'error', chatId: chat.id, message: 'boom' });
    // After unsubscribe, b receives nothing further; a is unaffected.
    expect(b.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(a.length).toBeGreaterThanOrEqual(b.length);
  });
});

// --- Auto-title behaviour (Spec 02 RF-06) ----------------------------------

describe('ChatStore — auto-title', () => {
  it('uses a custom titleFromText and clamps it to 200 chars', async () => {
    const titleFromText = vi.fn((text: string) => `T:${text}`.repeat(50));
    const { store, db } = makeStore({ titleFromText });
    const projectId = seedProject(db);
    const chat = await store.create(projectId);

    await store.send(chat.id, 'hello');
    const title = db.chats.get(chat.id)?.title ?? '';
    expect(titleFromText).toHaveBeenCalledWith('hello');
    expect(title.length).toBeLessThanOrEqual(200);
  });

  it('only auto-titles the first message, not subsequent ones', async () => {
    const { store, db } = makeStore();
    const projectId = seedProject(db);
    const chat = await store.create(projectId);

    await store.send(chat.id, 'First message here');
    const firstTitle = db.chats.get(chat.id)?.title;
    expect(firstTitle).toBe('First message here');

    await store.send(chat.id, 'A completely different second message');
    // Title is unchanged by the second turn.
    expect(db.chats.get(chat.id)?.title).toBe(firstTitle);
  });

  it('falls back to the default truncated multi-line title', async () => {
    const { store, db } = makeStore();
    const projectId = seedProject(db);
    const chat = await store.create(projectId);

    // Leading blank lines are skipped; the first non-empty line is used and
    // truncated past 60 chars with an ellipsis.
    const text = `\n\n   ${'word '.repeat(40)}`;
    await store.send(chat.id, text);
    const title = db.chats.get(chat.id)?.title ?? '';
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(61); // 60 + ellipsis
  });
});

// --- Archive vs delete semantics (Spec 02 RF-07) ---------------------------

describe('ChatStore — archive keeps history; list excludes archived', () => {
  it('archive hides from list but preserves messages', async () => {
    const { store, db } = makeStore();
    const projectId = seedProject(db);
    const chat = await store.create(projectId);
    await store.send(chat.id, 'keep me');

    await store.archive(chat.id);
    expect(await store.list(projectId)).toHaveLength(0);

    // History survives archiving (only delete() removes it).
    const history = await store.history(chat.id);
    expect(history.length).toBeGreaterThan(0);
    expect((history[0]?.blocks[0] as { text: string }).text).toBe('keep me');
  });
});
