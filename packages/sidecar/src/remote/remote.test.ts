/**
 * Remote runtime tests (Spec 05). No real SSH/WebSocket: the protocol is tested
 * by round-trip; the RemoteRuntimeStore CRUD + the runtime router are tested with
 * an injected fake client. We assert validation, status, dedupe, and turn routing.
 */
import { describe, expect, it, vi } from 'vitest';
import { createInMemoryDbStore } from '@vingsforge/persistence';
import type { EngineEvent } from '@vingsforge/shared';
import {
  decodeClientFrame,
  decodeServerFrame,
  encodeFrame,
} from './protocol.js';
import {
  RemoteRuntimeStore,
  RemoteRuntimeNotFoundError,
  type RemoteRuntimeStoreDeps,
} from './runtimes.js';
import { isRemoteRuntime, makeRuntimeRouter } from './resolve.js';
import type { EngineTurnInput, TurnResult } from '../chats/store.js';

const ADD_INPUT = {
  label: 'box',
  ssh: { host: 'vps.example', port: 22, user: 'root', keyPath: '/k' },
  daemon: { installPath: '/opt/forge', version: '1.0.0' },
  apiKeyLocation: 'daemon' as const,
};

describe('protocol round-trip', () => {
  it('encodes and decodes a command frame', () => {
    const frame = encodeFrame({
      kind: 'command',
      command: { type: 'engine.send', chatId: 'c1', text: 'hi' },
    });
    const decoded = decodeClientFrame(frame);
    expect(decoded).toEqual({
      kind: 'command',
      command: { type: 'engine.send', chatId: 'c1', text: 'hi' },
    });
  });

  it('encodes and decodes an id-tagged event frame', () => {
    const event: EngineEvent = { type: 'message.delta', chatId: 'c1', text: 'yo' };
    const decoded = decodeServerFrame(encodeFrame({ kind: 'event', seq: 7, event }));
    expect(decoded).toEqual({ kind: 'event', seq: 7, event });
  });

  it('rejects a malformed frame', () => {
    expect(() => decodeClientFrame('{"kind":"nope"}')).toThrow();
  });
});

/** A fake client that records commands and lets tests inject events/status. */
class FakeClient {
  readonly commands: import('@vingsforge/shared').EngineCommand[] = [];
  connected = false;
  constructor(
    readonly handlers: {
      onEvent(e: EngineEvent): void;
      onStatus(s: import('@vingsforge/shared').RemoteRuntimeStatus): void;
    },
  ) {}
  async connect(): Promise<void> {
    this.connected = true;
    this.handlers.onStatus('online');
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    this.handlers.onStatus('offline');
  }
  sendCommand(c: import('@vingsforge/shared').EngineCommand): void {
    this.commands.push(c);
  }
  emit(e: EngineEvent): void {
    this.handlers.onEvent(e);
  }
}

function makeStore(): {
  store: RemoteRuntimeStore;
  fakes: Map<string, FakeClient>;
  events: EngineEvent[];
} {
  const db = createInMemoryDbStore();
  const fakes = new Map<string, FakeClient>();
  const events: EngineEvent[] = [];
  const deps: RemoteRuntimeStoreDeps = {
    db,
    onEvent: (e) => events.push(e),
    makeClient: (record, handlers) => {
      const fake = new FakeClient(handlers);
      fakes.set(record.id, fake);
      return fake as unknown as import('./client.js').RemoteRuntimeClient;
    },
  };
  return { store: new RemoteRuntimeStore(deps), fakes, events };
}

describe('RemoteRuntimeStore — CRUD (Spec 05 §7)', () => {
  it('adds a runtime offline and lists it', async () => {
    const { store } = makeStore();
    const added = await store.add(ADD_INPUT);
    expect(added.status).toBe('offline');
    expect(added.label).toBe('box');
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(added.id);
  });

  it('rejects an invalid ssh port', async () => {
    const { store } = makeStore();
    await expect(
      store.add({ ...ADD_INPUT, ssh: { ...ADD_INPUT.ssh, port: 0 } }),
    ).rejects.toThrow();
  });

  it('connect flips status to online; disconnect back to offline', async () => {
    const { store } = makeStore();
    const { id } = await store.add(ADD_INPUT);
    await store.connect(id);
    expect((await store.list())[0]!.status).toBe('online');
    await store.disconnect(id);
    expect((await store.list())[0]!.status).toBe('offline');
  });

  it('remove disconnects and deletes the row', async () => {
    const { store } = makeStore();
    const { id } = await store.add(ADD_INPUT);
    await store.connect(id);
    await store.remove(id);
    expect(await store.list()).toHaveLength(0);
    await expect(store.disconnect(id)).rejects.toBeInstanceOf(RemoteRuntimeNotFoundError);
  });

  it('fsList throws when not connected', async () => {
    const { store } = makeStore();
    const { id } = await store.add(ADD_INPUT);
    await expect(store.fsList(id, '/')).rejects.toThrow();
  });
});

describe('runtime router (Spec 05 §4/RF-05)', () => {
  it('isRemoteRuntime distinguishes local from remote', () => {
    expect(isRemoteRuntime(undefined)).toBe(false);
    expect(isRemoteRuntime('local')).toBe(false);
    expect(isRemoteRuntime('vps-1')).toBe(true);
  });

  it('routes a local turn to the local runner', async () => {
    const { store } = makeStore();
    const local = vi.fn(
      async (): Promise<TurnResult> => ({
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    );
    const router = makeRuntimeRouter(store, local);
    const input = turnInput({ runtimeId: 'local' });
    await router(input, () => {});
    expect(local).toHaveBeenCalledOnce();
  });

  it('drives a remote turn via the daemon and resolves on turn.end', async () => {
    const { store, fakes } = makeStore();
    const { id } = await store.add(ADD_INPUT);
    await store.connect(id);
    const fake = fakes.get(id)!;

    const local = vi.fn();
    const router = makeRuntimeRouter(store, local as never);
    const emitted: EngineEvent[] = [];
    const input = turnInput({ runtimeId: id });

    const pending = router(input, (e) => emitted.push(e));
    // The app ships the per-turn context (system + history) on `engine.send`:
    // the daemon is stateless, so history/system/policy travel on the command
    // (Spec 05 §4) instead of being reconstructed daemon-side.
    expect(fake.commands[0]).toEqual({
      type: 'engine.send',
      chatId: 'c1',
      text: 'hi',
      context: { system: 'sys', history: [] },
    });

    // The daemon streams a delta and then a turn.end for this chat.
    fake.emit({ type: 'message.delta', chatId: 'c1', text: 'remote' });
    fake.emit({
      type: 'turn.end',
      chatId: 'c1',
      stopReason: 'end_turn',
      usage: { inputTokens: 2, outputTokens: 3 },
    });

    const result = await pending;
    expect(local).not.toHaveBeenCalled();
    expect(result).toEqual({
      stopReason: 'end_turn',
      usage: { inputTokens: 2, outputTokens: 3 },
    });
    expect(emitted.map((e) => e.type)).toEqual(['message.delta', 'turn.end']);
  });

  it('ships per-turn context (history + system + policy/modes) on engine.send (Spec 05 §4)', async () => {
    const { store, fakes } = makeStore();
    const { id } = await store.add(ADD_INPUT);
    await store.connect(id);
    const fake = fakes.get(id)!;
    const router = makeRuntimeRouter(store, vi.fn() as never);

    const history = [
      {
        id: 'm0',
        chatId: 'c1',
        role: 'user' as const,
        blocks: [{ kind: 'text' as const, text: 'earlier' }],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const policy = { defaults: {}, rules: [{ tool: 'bash', decision: 'deny' as const }] };
    const input = turnInput({
      runtimeId: id,
      system: 'project sys',
      history,
      model: 'claude-opus-4-8',
      effort: 'high',
      maxTokens: 4096,
      volatileContext: 'vol',
      policy,
      modes: { readOnly: true },
    });

    void router(input, () => {});
    const sent = fake.commands[0];
    expect(sent).toEqual({
      type: 'engine.send',
      chatId: 'c1',
      text: 'hi',
      context: {
        system: 'project sys',
        history,
        model: 'claude-opus-4-8',
        effort: 'high',
        maxTokens: 4096,
        volatileContext: 'vol',
        policy,
        modes: { readOnly: true },
      },
    });

    // The shipped context survives a protocol round-trip (zod-validated).
    const decoded = decodeClientFrame(encodeFrame({ kind: 'command', command: sent! }));
    expect(decoded).toEqual({ kind: 'command', command: sent });
    input.controller.abort();
  });

  it('forwards an interrupt to the daemon on abort', async () => {
    const { store, fakes } = makeStore();
    const { id } = await store.add(ADD_INPUT);
    await store.connect(id);
    const fake = fakes.get(id)!;
    const router = makeRuntimeRouter(store, vi.fn() as never);
    const input = turnInput({ runtimeId: id });
    const pending = router(input, () => {});
    input.controller.abort();
    fake.emit({
      type: 'turn.end',
      chatId: 'c1',
      stopReason: 'interrupted',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    await pending;
    expect(fake.commands).toContainEqual({ type: 'engine.interrupt', chatId: 'c1' });
  });

  it('errors when the remote runtime is not connected', async () => {
    const { store } = makeStore();
    const router = makeRuntimeRouter(store, vi.fn() as never);
    const emitted: EngineEvent[] = [];
    const result = await router(turnInput({ runtimeId: 'ghost' }), (e) => emitted.push(e));
    expect(emitted[0]?.type).toBe('error');
    expect(result.stopReason).toBe('end_turn');
  });
});

function turnInput(over: Partial<EngineTurnInput>): EngineTurnInput {
  return {
    chatId: 'c1',
    system: 'sys',
    history: [],
    userText: 'hi',
    controller: new AbortController(),
    persistAssistant: () => {},
    persistToolResults: () => {},
    ...over,
  };
}
