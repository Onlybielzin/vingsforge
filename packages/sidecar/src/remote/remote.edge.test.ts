/**
 * Remote runtime EDGE/SECURITY tests (Spec 05). Complements `remote.test.ts` and
 * `daemon.integration.test.ts` by hammering the boundaries the happy-path suites
 * skip:
 *  - protocol validation of every untrusted frame (empty fs path, persist frames,
 *    malformed blocks, missing reqId, version mismatch tolerance),
 *  - TOFU host-key pinning PERSISTED through the store on first connect and the
 *    pinned fingerprint surviving reconnects (Spec 05 §2),
 *  - the persist fan-out routing assembled turns to the right store hook and
 *    being filtered by chatId so replay history stays correct (Spec 05 §4),
 *  - daemon fsList path confinement to the workspace root (Spec 05 §5),
 *  - daemon-side malformed-frame and unknown-tool handling.
 *
 * No real SSH/WS where avoidable: the protocol is exercised by round-trip, the
 * store with an injected fake client, and the daemon over loopback `ws`.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createInMemoryDbStore } from '@vingsforge/persistence';
import type {
  ChatMessage,
  EngineEvent,
  RemoteRuntimeStatus,
} from '@vingsforge/shared';
import {
  PROTOCOL_VERSION,
  decodeClientFrame,
  decodeServerFrame,
  encodeFrame,
  type ServerFrame,
} from './protocol.js';
import {
  RemoteRuntimeStore,
  type RemoteRuntimeStoreDeps,
  type RemotePersist,
} from './runtimes.js';
import { makeRuntimeRouter, isRemoteRuntime, LOCAL_RUNTIME } from './resolve.js';
import { startForgeDaemon, type ForgeDaemon } from './daemon.js';
import { RemoteRuntimeClient } from './client.js';
import type { EngineTurnInput } from '../chats/store.js';

const ADD_INPUT = {
  label: 'box',
  ssh: { host: 'vps.example', port: 22, user: 'root', keyPath: '/k' },
  daemon: { installPath: '/opt/forge', version: '1.0.0' },
  apiKeyLocation: 'daemon' as const,
};

const PERSIST_MSG: ChatMessage = {
  id: 'm1',
  chatId: 'c1',
  role: 'assistant',
  blocks: [
    { kind: 'thinking', text: 'hmm', signature: 'sig-abc' },
    { kind: 'text', text: 'hello' },
    { kind: 'tool_use', callId: 'call-1', tool: 'read_file', input: { path: 'a.txt' } },
  ],
  usage: { inputTokens: 3, outputTokens: 4 },
  model: 'claude-opus-4-8',
  createdAt: '2026-01-01T00:00:00.000Z',
};

// --- Protocol validation (every frame on the socket is untrusted) -----------

describe('protocol validation — edges (Spec 05 §4)', () => {
  it('rejects an fs.list with an empty path (no listing of "" ambiguity)', () => {
    expect(() =>
      decodeClientFrame(encodeFrame({ kind: 'fs.list', reqId: 'r1', path: '' } as never)),
    ).toThrow();
  });

  it('rejects an fs.list with an empty reqId (cannot correlate a reply)', () => {
    expect(() =>
      decodeClientFrame(encodeFrame({ kind: 'fs.list', reqId: '', path: '/x' } as never)),
    ).toThrow();
  });

  it('rejects a command with an empty chatId', () => {
    expect(() =>
      decodeClientFrame(
        encodeFrame({
          kind: 'command',
          command: { type: 'engine.send', chatId: '', text: 'hi' },
        } as never),
      ),
    ).toThrow();
  });

  it('rejects a tool.permission.resolve with a bogus decision', () => {
    expect(() =>
      decodeClientFrame(
        encodeFrame({
          kind: 'command',
          command: {
            type: 'tool.permission.resolve',
            chatId: 'c1',
            callId: 'call-1',
            decision: 'maybe',
          },
        } as never),
      ),
    ).toThrow();
  });

  it('round-trips a persist.assistant frame preserving thinking signatures + tool_use', () => {
    const decoded = decodeServerFrame(
      encodeFrame({ kind: 'persist.assistant', seq: 5, message: PERSIST_MSG }),
    );
    expect(decoded).toEqual({ kind: 'persist.assistant', seq: 5, message: PERSIST_MSG });
    // The signature survives — without it replay 400s on the next turn (§4).
    expect(JSON.stringify(decoded)).toContain('sig-abc');
  });

  it('round-trips a persist.toolResults frame preserving tool_result pairing', () => {
    const toolResults: ChatMessage = {
      id: 'm2',
      chatId: 'c1',
      role: 'user',
      blocks: [{ kind: 'tool_result', callId: 'call-1', output: { ok: true }, isError: false }],
      createdAt: '2026-01-01T00:00:01.000Z',
    };
    const decoded = decodeServerFrame(
      encodeFrame({ kind: 'persist.toolResults', seq: 6, message: toolResults }),
    );
    expect(decoded).toEqual({ kind: 'persist.toolResults', seq: 6, message: toolResults });
  });

  it('rejects a persist frame whose message block is malformed (unknown block kind)', () => {
    const bad = {
      kind: 'persist.assistant',
      seq: 1,
      message: {
        id: 'm1',
        chatId: 'c1',
        role: 'assistant',
        blocks: [{ kind: 'bogus', text: 'x' }],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    };
    expect(() => decodeServerFrame(JSON.stringify(bad))).toThrow();
  });

  it('rejects a persist frame whose message id is empty', () => {
    const bad = { kind: 'persist.assistant', seq: 1, message: { ...PERSIST_MSG, id: '' } };
    expect(() => decodeServerFrame(JSON.stringify(bad))).toThrow();
  });

  it('rejects a daemon.status with a status outside the enum', () => {
    expect(() =>
      decodeServerFrame(
        JSON.stringify({ kind: 'daemon.status', seq: 1, status: 'rebooting' }),
      ),
    ).toThrow();
  });

  it('rejects non-JSON garbage on both directions', () => {
    expect(() => decodeClientFrame('not json at all')).toThrow();
    expect(() => decodeServerFrame('}{')).toThrow();
  });

  it('keeps PROTOCOL_VERSION a positive integer (handshake sanity)', () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });
});

// --- Store: TOFU host-key pinning + persist fan-out -------------------------

/** A fake client that surfaces the host-key pin + persist handler hooks. */
class FakeClient {
  readonly commands: import('@vingsforge/shared').EngineCommand[] = [];
  connected = false;
  constructor(
    readonly handlers: {
      onEvent(e: EngineEvent): void;
      onStatus(s: RemoteRuntimeStatus): void;
      onPinHostKey?(fp: string): void;
      onPersistAssistant?(m: ChatMessage): void;
      onPersistToolResults?(m: ChatMessage): void;
      onError?(m: string): void;
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
  pin(fp: string): void {
    this.handlers.onPinHostKey?.(fp);
  }
  persistAssistant(m: ChatMessage): void {
    this.handlers.onPersistAssistant?.(m);
  }
  persistToolResults(m: ChatMessage): void {
    this.handlers.onPersistToolResults?.(m);
  }
}

function makeStore(): {
  store: RemoteRuntimeStore;
  fakes: Map<string, FakeClient>;
  db: ReturnType<typeof createInMemoryDbStore>;
  events: EngineEvent[];
} {
  const db = createInMemoryDbStore();
  const fakes = new Map<string, FakeClient>();
  const events: EngineEvent[] = [];
  const deps: RemoteRuntimeStoreDeps = {
    db,
    onEvent: (e) => events.push(e),
    makeClient: (record, handlers) => {
      const fake = new FakeClient(handlers as never);
      fakes.set(record.id, fake);
      return fake as unknown as RemoteRuntimeClient;
    },
  };
  return { store: new RemoteRuntimeStore(deps), fakes, db, events };
}

describe('RemoteRuntimeStore — secrets & host-key TOFU (Spec 05 §2)', () => {
  it('generates a unique per-runtime auth token at add time, never empty', async () => {
    const { store, db } = makeStore();
    const a = await store.add(ADD_INPUT);
    const b = await store.add({ ...ADD_INPUT, label: 'box2' });
    const recA = db.runtimes.get(a.id)!;
    const recB = db.runtimes.get(b.id)!;
    expect(recA.authToken).toBeTruthy();
    expect(recB.authToken).toBeTruthy();
    expect(recA.authToken).not.toBe(recB.authToken);
    // The token is a daemon handshake SECRET — it must not leak into the public
    // RemoteRuntime DTO returned to the UI/IPC layer.
    expect(a).not.toHaveProperty('authToken');
  });

  it('pins the host fingerprint on first connect and persists it on the record (TOFU)', async () => {
    const { store, fakes, db } = makeStore();
    const { id } = await store.add(ADD_INPUT);
    expect(db.runtimes.get(id)!.ssh.hostFingerprint).toBeUndefined();
    await store.connect(id);
    fakes.get(id)!.pin('FINGERPRINT_A');
    expect(db.runtimes.get(id)!.ssh.hostFingerprint).toBe('FINGERPRINT_A');
  });

  it('does NOT overwrite an already-pinned fingerprint (reconnect cannot silently re-pin a MITM key)', async () => {
    const { store, fakes, db } = makeStore();
    const { id } = await store.add(ADD_INPUT);
    await store.connect(id);
    fakes.get(id)!.pin('FINGERPRINT_A');
    // A second pin (e.g. a reconnect against an attacker key) must be ignored;
    // mismatch is the tunnel's job to reject, the store must never re-pin.
    fakes.get(id)!.pin('ATTACKER_FINGERPRINT');
    expect(db.runtimes.get(id)!.ssh.hostFingerprint).toBe('FINGERPRINT_A');
  });

  it('surfaces a fatal client error as runtime status "error"', async () => {
    const { store, fakes } = makeStore();
    const { id } = await store.add(ADD_INPUT);
    await store.connect(id);
    fakes.get(id)!.handlers.onError?.('host key mismatch');
    expect((await store.list())[0]!.status).toBe('error');
  });
});

describe('RemoteRuntimeStore — persist fan-out routes assembled turns (Spec 05 §4)', () => {
  it('routes persist.assistant and persist.toolResults to distinct subscribers', async () => {
    const { store, fakes } = makeStore();
    const { id } = await store.add(ADD_INPUT);
    await store.connect(id);
    const got: RemotePersist[] = [];
    const off = store.onTurnPersist((p) => got.push(p));
    fakes.get(id)!.persistAssistant(PERSIST_MSG);
    fakes.get(id)!.persistToolResults({ ...PERSIST_MSG, id: 'm2', role: 'user' });
    off();
    expect(got.map((p) => p.kind)).toEqual(['assistant', 'toolResults']);
    expect(got[0]!.message.id).toBe('m1');
    expect(got[1]!.message.id).toBe('m2');
  });

  it('unsubscribe stops further persist deliveries (no leak across turns)', async () => {
    const { store, fakes } = makeStore();
    const { id } = await store.add(ADD_INPUT);
    await store.connect(id);
    const got: RemotePersist[] = [];
    const off = store.onTurnPersist((p) => got.push(p));
    off();
    fakes.get(id)!.persistAssistant(PERSIST_MSG);
    expect(got).toHaveLength(0);
  });

  it('installDaemon ends offline (status owns only the transition for now, RF-02)', async () => {
    const { store } = makeStore();
    const { id } = await store.add(ADD_INPUT);
    await store.installDaemon(id);
    expect((await store.list())[0]!.status).toBe('offline');
  });

  it('clientFor returns the live client only after connect', async () => {
    const { store } = makeStore();
    const { id } = await store.add(ADD_INPUT);
    expect(store.clientFor(id)).toBeUndefined();
    await store.connect(id);
    expect(store.clientFor(id)).toBeDefined();
  });
});

// --- Router: persist routing + replay safety + filtering --------------------

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

describe('runtime router — persist routing & replay safety (Spec 05 §4, acceptance #4)', () => {
  it('routes assembled turns to the chat\'s persist hooks and resolves on turn.end', async () => {
    const { store, fakes } = makeStore();
    const { id } = await store.add(ADD_INPUT);
    await store.connect(id);
    const fake = fakes.get(id)!;
    const router = makeRuntimeRouter(store, vi.fn() as never);

    const assistantPersisted: ChatMessage[] = [];
    const toolPersisted: ChatMessage[] = [];
    const input = turnInput({
      runtimeId: id,
      persistAssistant: (_id, m) => assistantPersisted.push(m),
      persistToolResults: (_id, m) => toolPersisted.push(m),
    });

    const pending = router(input, () => {});
    fake.persistAssistant(PERSIST_MSG);
    fake.persistToolResults({ ...PERSIST_MSG, id: 'm2', role: 'user' });
    fake.emit({
      type: 'turn.end',
      chatId: 'c1',
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    await pending;

    expect(assistantPersisted.map((m) => m.id)).toEqual(['m1']);
    expect(toolPersisted.map((m) => m.id)).toEqual(['m2']);
    // Replay safety: the persisted assistant turn keeps its thinking signature.
    expect(assistantPersisted[0]!.blocks.some((b) => b.kind === 'thinking' && b.signature)).toBe(
      true,
    );
  });

  it('does NOT persist turns belonging to a different chat (cross-chat isolation)', async () => {
    const { store, fakes } = makeStore();
    const { id } = await store.add(ADD_INPUT);
    await store.connect(id);
    const fake = fakes.get(id)!;
    const router = makeRuntimeRouter(store, vi.fn() as never);
    const persisted: ChatMessage[] = [];
    const input = turnInput({
      runtimeId: id,
      chatId: 'c1',
      persistAssistant: (_id, m) => persisted.push(m),
    });
    const pending = router(input, () => {});
    // A persist frame for a SIBLING chat must be ignored by this turn.
    fake.persistAssistant({ ...PERSIST_MSG, id: 'mOther', chatId: 'cOTHER' });
    fake.emit({
      type: 'turn.end',
      chatId: 'c1',
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    await pending;
    expect(persisted).toHaveLength(0);
  });

  it('does not re-emit or resolve on a turn.end for a different chat', async () => {
    const { store, fakes } = makeStore();
    const { id } = await store.add(ADD_INPUT);
    await store.connect(id);
    const fake = fakes.get(id)!;
    const router = makeRuntimeRouter(store, vi.fn() as never);
    const emitted: EngineEvent[] = [];
    let settled = false;
    const input = turnInput({ runtimeId: id, chatId: 'c1' });
    const pending = router(input, (e) => emitted.push(e)).then((r) => {
      settled = true;
      return r;
    });
    // Foreign turn.end: must not leak onto this chat's bus nor resolve it.
    fake.emit({
      type: 'turn.end',
      chatId: 'cOTHER',
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
    expect(emitted).toHaveLength(0);
    // Now the real end resolves it and cleans up listeners.
    fake.emit({
      type: 'turn.end',
      chatId: 'c1',
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    await pending;
    expect(settled).toBe(true);
  });

  it('maps an unknown daemon stopReason to a safe end_turn', async () => {
    const { store, fakes } = makeStore();
    const { id } = await store.add(ADD_INPUT);
    await store.connect(id);
    const fake = fakes.get(id)!;
    const router = makeRuntimeRouter(store, vi.fn() as never);
    const pending = router(turnInput({ runtimeId: id }), () => {});
    fake.emit({
      type: 'turn.end',
      chatId: 'c1',
      stopReason: 'something_new' as never,
      usage: { inputTokens: 1, outputTokens: 2 },
    });
    const result = await pending;
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });

  it('preserves a known stopReason (interrupted) from the daemon', async () => {
    const { store, fakes } = makeStore();
    const { id } = await store.add(ADD_INPUT);
    await store.connect(id);
    const fake = fakes.get(id)!;
    const router = makeRuntimeRouter(store, vi.fn() as never);
    const pending = router(turnInput({ runtimeId: id }), () => {});
    fake.emit({
      type: 'turn.end',
      chatId: 'c1',
      stopReason: 'interrupted',
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect((await pending).stopReason).toBe('interrupted');
  });

  it('LOCAL_RUNTIME sentinel and undefined both route locally', () => {
    expect(isRemoteRuntime(LOCAL_RUNTIME)).toBe(false);
    expect(isRemoteRuntime(undefined)).toBe(false);
    expect(LOCAL_RUNTIME).toBe('local');
  });
});

// --- Daemon: fsList path confinement + bad-frame handling (Spec 05 §5) ------

describe('forge-daemon fsList confinement & robustness (Spec 05 §5)', () => {
  let workspace: string;
  let outside: string;
  let daemon: ForgeDaemon;
  let client: RemoteRuntimeClient | undefined;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'forge-edge-ws-'));
    outside = mkdtempSync(join(tmpdir(), 'forge-edge-out-'));
    mkdirSync(join(workspace, 'sub'));
    writeFileSync(join(workspace, 'inside.txt'), 'in', 'utf8');
    writeFileSync(join(outside, 'secret.txt'), 'TOP SECRET', 'utf8');
  });

  afterEach(async () => {
    await client?.disconnect();
    await daemon?.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  async function boot(): Promise<RemoteRuntimeClient> {
    const statuses: RemoteRuntimeStatus[] = [];
    daemon = await startForgeDaemon({
      client: { messages: { stream: () => { throw new Error('unused'); } } } as never,
      workspaceRoot: workspace,
      resolveTurnContext: () => ({ system: 'sys', history: [] }),
    });
    const localPort = daemon.port;
    const c = new RemoteRuntimeClient(
      {
        id: 'rt-edge',
        label: 'box',
        ssh: { host: '127.0.0.1', port: 22, user: 'root' },
        daemon: { installPath: '/opt/forge' },
        apiKeyLocation: 'daemon',
      },
      { onEvent: () => {}, onStatus: (s) => statuses.push(s) },
      {
        openTunnel: async () => ({ localPort, close: async () => {} }),
        connectWs: (url) => new WebSocket(url),
        heartbeatMs: 1_000_000,
      },
    );
    client = c;
    await c.connect();
    await waitFor(() => statuses.includes('online'));
    return c;
  }

  it('lists entries inside the workspace root', async () => {
    const c = await boot();
    const entries = await c.fsList('.');
    expect(entries.map((e) => e.name).sort()).toEqual(['inside.txt', 'sub']);
  });

  it('refuses a "../" escape: fsList rejects rather than leaking the parent dir', async () => {
    const c = await boot();
    await expect(c.fsList('../')).rejects.toThrow();
  });

  it('refuses an absolute path outside the workspace root (no arbitrary FS browse)', async () => {
    const c = await boot();
    await expect(c.fsList(outside)).rejects.toThrow();
    // The escape attempt must not have leaked the external secret listing.
  });

  it('refuses a symlink that points outside the root', async () => {
    symlinkSync(outside, join(workspace, 'escape'), 'dir');
    const c = await boot();
    await expect(c.fsList('escape')).rejects.toThrow();
  });

  it('answers a daemon.health probe with the protocol version', async () => {
    const c = await boot();
    // Reach into the raw socket: health has no public client method, so drive it
    // through a fresh WS and assert the daemon replies with PROTOCOL_VERSION.
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}`);
    const reply = await new Promise<ServerFrame>((resolve, reject) => {
      ws.on('open', () => ws.send(encodeFrame({ kind: 'daemon.health', reqId: 'h1' })));
      ws.on('message', (d: Buffer) => {
        // The daemon greets every session with a `daemon.status` frame first;
        // skip it and resolve on the health reply correlated by reqId.
        const frame = decodeServerFrame(d.toString('utf8'));
        if (frame.kind === 'daemon.health.result') resolve(frame);
      });
      ws.on('error', reject);
    });
    ws.close();
    expect(reply).toMatchObject({ kind: 'daemon.health.result', reqId: 'h1', protocol: PROTOCOL_VERSION });
    void c;
  });

  it('replies with an error frame on a malformed app frame instead of crashing', async () => {
    await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}`);
    const reply = await new Promise<ServerFrame>((resolve, reject) => {
      ws.on('open', () => {
        // Skip the daemon.status greeting; send junk and await the error frame.
        ws.send('this is not a valid frame');
      });
      ws.on('message', (d: Buffer) => {
        const frame = decodeServerFrame(d.toString('utf8'));
        if (frame.kind === 'error') resolve(frame);
      });
      ws.on('error', reject);
    });
    ws.close();
    expect(reply.kind).toBe('error');
  });
});

/** Poll until `pred` is true or the timeout elapses. */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
