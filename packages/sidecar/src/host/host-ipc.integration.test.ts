/**
 * End-to-end local IPC integration: the REAL UI client (ui/src/ipc/real.ts) talks
 * to a fake in-memory host over the loopback {@link ClientMsg}/{@link ServerMsg}
 * protocol — no real WebSocket, no real Anthropic API.
 *
 * What is REAL here:
 *  - `createRealIpcClient` from `@vingsforge/ui` (the production transport adapter),
 *  - the real {@link ChatStore} + {@link Engine} via {@link makeEngineRunner},
 *  - the real permission gate ({@link maybeAskPermission}) and {@link PendingPermissions},
 *  - the real {@link ToolExecutor}/{@link Workspace} executing `read_file` against a
 *    real temp directory,
 *  - the real in-memory persistence ({@link createInMemoryDbStore}).
 *
 * What is FAKED:
 *  - the WebSocket pair (an in-process channel that JSON-serializes frames exactly
 *    like the real host/client, so the wire protocol is still exercised),
 *  - the Anthropic client (a scripted stub — NEVER a real network call).
 *
 * This mirrors the host wiring in `host.ts`/`server.ts` (RPC dispatch onto the four
 * APIs, event fan-out, command application) without binding a TCP socket, so the
 * client ⇄ host roundtrip can be asserted deterministically.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Message,
  MessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages';
import {
  LOCAL_PROTOCOL_VERSION,
  type ClientMsg,
  type EngineCommand,
  type EngineEvent,
  type LocalApi,
  type PermissionModes,
  type PermissionPolicy,
  type ServerMsg,
} from '@vingsforge/shared';
import { createInMemoryDbStore, type DbStore } from '@vingsforge/persistence';
import { createRealIpcClient, type RealIpcClient } from '@vingsforge/ui/ipc';
import type { AnthropicLike, MessageStreamLike, StreamRequest } from '../engine/client.js';
import {
  ChatStore,
  type ChatContext,
  type EngineTurnInput,
} from '../chats/store.js';
import { makeEngineRunner } from '../chats/engine-runner.js';
import type { GateDecision, ToolCall, ToolOutcome } from '../engine/engine.js';
import { ToolExecutor } from '../tools/executors.js';
import { Workspace } from '../tools/workspace.js';
import type { LocalToolName } from '../tools/schemas.js';
import {
  maybeAskPermission,
  rememberAllow,
} from '../permissions/policy.js';
import {
  PendingPermissions,
  toGateDecision,
  type HostApis,
} from './server.js';

// --- mock Anthropic ---------------------------------------------------------

/** A scripted turn: deltas to stream, then the final Message it resolves to. */
interface ScriptedTurn {
  events: MessageStreamEvent[];
  final: Partial<Message> & Pick<Message, 'stop_reason'>;
}

function usage(): Message['usage'] {
  return {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    cache_creation: null,
    server_tool_use: null,
    service_tier: null,
  };
}

function makeMessage(partial: Partial<Message> & Pick<Message, 'stop_reason'>): Message {
  return {
    id: partial.id ?? 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-8',
    content: partial.content ?? [],
    stop_reason: partial.stop_reason,
    stop_sequence: null,
    usage: partial.usage ?? usage(),
  } as Message;
}

function textDelta(text: string): MessageStreamEvent {
  return {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  } as MessageStreamEvent;
}

/** Build a mock Anthropic client that yields the scripted turns in order. */
function mockAnthropic(turns: ScriptedTurn[]): AnthropicLike {
  let cursor = 0;
  return {
    messages: {
      stream(_body: StreamRequest): MessageStreamLike {
        const turn = turns[cursor];
        cursor += 1;
        if (turn === undefined) throw new Error('mock: no more scripted turns');
        let didAbort = false;
        const stream: MessageStreamLike = {
          // eslint-disable-next-line @typescript-eslint/require-await
          async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
            for (const ev of turn.events) {
              if (didAbort) return;
              yield ev;
            }
          },
          finalMessage(): Promise<Message> {
            return Promise.resolve(makeMessage(turn.final));
          },
          abort(): void {
            didAbort = true;
          },
        };
        return stream;
      },
    },
  };
}

// --- in-memory transport (a fake WebSocket pair) ----------------------------

/**
 * One in-process socket the real client constructs (via `WebSocketImpl`) and
 * drives. Carries the same static `OPEN`/`readyState` the real client checks
 * (`this.WS.OPEN`) so its outbox flushes; `send()` hands the frame to the host's
 * attached handler, and the host pushes frames back via {@link deliver}.
 * Implements just enough of the browser `WebSocket` surface that `real.ts` uses.
 */
class MemorySocket {
  static CONNECTING = 0 as const;
  static OPEN = 1 as const;
  static CLOSING = 2 as const;
  static CLOSED = 3 as const;
  /** The instance the real client just constructed — handed to the host. */
  static last: MemorySocket | null = null;

  readyState: number = MemorySocket.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  /** Host-supplied handler for a client->host frame (attached after construction). */
  onClientFrame: ((raw: string) => void) | null = null;

  constructor(public url: string, public protocols?: string | string[]) {
    MemorySocket.last = this;
  }

  /** Client -> host. */
  send(frame: string): void {
    this.onClientFrame?.(frame);
  }

  /** Host -> client. */
  deliver(frame: string): void {
    this.onmessage?.({ data: frame });
  }

  /** Complete the (synchronous) handshake. */
  open(): void {
    this.readyState = MemorySocket.OPEN;
    this.onopen?.({});
  }

  close(): void {
    this.readyState = MemorySocket.CLOSED;
    this.onclose?.({});
  }
}

/** Bind every prototype method of an API instance for dynamic RPC dispatch. */
function bindApi(instance: object): Record<string, (...a: unknown[]) => unknown> {
  const out: Record<string, (...a: unknown[]) => unknown> = Object.create(null);
  let proto: object | null = instance;
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const value = (instance as Record<string, unknown>)[name];
      if (typeof value === 'function' && !Object.prototype.hasOwnProperty.call(out, name)) {
        out[name] = (value as (...a: unknown[]) => unknown).bind(instance);
      }
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return out;
}

/** Resolve a bound API map by its protocol name (mirrors server.ts). */
function resolveApi(apis: HostApis, name: LocalApi): Record<string, (...a: unknown[]) => unknown> {
  switch (name) {
    case 'projects':
      return apis.projects;
    case 'chats':
      return apis.chats;
    case 'runtimes':
      return apis.runtimes;
    case 'settings':
      return apis.settings;
    default: {
      const exhaustive: never = name;
      throw new Error(`unknown api: ${String(exhaustive)}`);
    }
  }
}

/**
 * A fake host: applies the SAME RPC dispatch + command handling as server.ts/host.ts
 * onto the supplied APIs and command handler, over an in-memory socket. It is the
 * test double for the loopback host; the engine/store/tools behind it are real.
 */
function attachFakeHost(
  socket: MemorySocket,
  deps: {
    apis: HostApis;
    applyCommand: (command: EngineCommand) => void;
    onEngineEvent: (listener: (event: EngineEvent) => void) => () => void;
  },
): { close: () => void } {
  async function handleRpc(msg: Extract<ClientMsg, { kind: 'rpc' }>): Promise<void> {
    try {
      const api = resolveApi(deps.apis, msg.api);
      if (!Object.prototype.hasOwnProperty.call(api, msg.method)) {
        throw new Error(`unknown method: ${msg.api}.${msg.method}`);
      }
      const fn = api[msg.method];
      if (typeof fn !== 'function') throw new Error(`unknown method: ${msg.api}.${msg.method}`);
      const result = await fn(...msg.args);
      const frame: ServerMsg = { kind: 'rpc.ok', id: msg.id, result };
      socket.deliver(JSON.stringify(frame));
    } catch (err) {
      const error = err instanceof Error ? { message: err.message, name: err.name } : { message: String(err) };
      const frame: ServerMsg = { kind: 'rpc.err', id: msg.id, error };
      socket.deliver(JSON.stringify(frame));
    }
  }

  socket.onClientFrame = (raw: string): void => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw) as ClientMsg;
    } catch {
      return;
    }
    if (msg.kind === 'command') {
      deps.applyCommand(msg.command);
      return;
    }
    if (msg.kind === 'rpc') {
      void handleRpc(msg);
    }
  };

  // Fan engine events out to the one connected client.
  const unsubscribe = deps.onEngineEvent((event) => {
    const frame: ServerMsg = { kind: 'event', event };
    socket.deliver(JSON.stringify(frame));
  });

  // Open asynchronously, then greet with `hello` — exactly the host's order.
  queueMicrotask(() => {
    socket.open();
    socket.deliver(JSON.stringify({ kind: 'hello', protocol: LOCAL_PROTOCOL_VERSION } satisfies ServerMsg));
  });

  return { close: () => unsubscribe() };
}

// --- the real host backend (DB + stores + engine), Anthropic mocked ---------

const LOCAL_TOOLS = new Set<LocalToolName>([
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'write_file',
  'edit_file',
  'bash',
]);

interface Backend {
  client: RealIpcClient;
  db: DbStore;
  close: () => void;
}

/**
 * Wire the whole real backend (ChatStore + engine-runner + tools + gate) behind a
 * fake host, then connect the real UI client over the in-memory socket. The
 * Anthropic client is the supplied scripted mock; the workspace is `workspaceRoot`.
 */
function makeBackend(opts: {
  turns: ScriptedTurn[];
  workspaceRoot: string;
  policy?: PermissionPolicy;
  modes?: PermissionModes;
}): Backend {
  const db = createInMemoryDbStore();

  const pending = new PendingPermissions();
  const remembered = new Map<string, Set<string>>();
  const listeners = new Set<(event: EngineEvent) => void>();
  const emitEvent = (event: EngineEvent): void => {
    for (const l of listeners) l(event);
  };

  function withRemembered(chatId: string, policy: PermissionPolicy): PermissionPolicy {
    let effective = policy;
    for (const tool of remembered.get(chatId) ?? []) effective = rememberAllow(effective, tool);
    return effective;
  }

  function resolveContext(): ChatContext {
    return {
      system: 'You are a test agent.',
      model: 'claude-opus-4-8',
      policy: opts.policy ?? { defaults: {} },
      modes: opts.modes ?? {},
    };
  }

  const runEngineTurn = makeEngineRunner((input: EngineTurnInput) => {
    const policy = withRemembered(input.chatId, input.policy ?? { defaults: {} });
    const modes: PermissionModes = input.modes ?? {};
    const workspace = new Workspace(opts.workspaceRoot);
    const executor = new ToolExecutor(workspace);

    const gate = (call: ToolCall, signal: AbortSignal): Promise<GateDecision> => {
      if (signal.aborted) return Promise.resolve({ allow: false, reason: 'interrupted' });
      const outcome = maybeAskPermission({
        policy,
        chatId: input.chatId,
        callId: call.callId,
        tool: call.tool,
        input: call.input,
        modes,
        workspace,
      });
      if (outcome.kind === 'allow') return Promise.resolve({ allow: true });
      if (outcome.kind === 'deny') return Promise.resolve({ allow: false, reason: outcome.reason });
      emitEvent(outcome.event);
      return pending.await(input.chatId, call.callId, signal).then((resolution) => {
        if (resolution.decision === 'allow' && resolution.remember) {
          const set = remembered.get(input.chatId) ?? new Set<string>();
          set.add(call.tool);
          remembered.set(input.chatId, set);
        }
        return toGateDecision(resolution);
      });
    };

    const executeTool = async (call: ToolCall): Promise<ToolOutcome> => {
      if (!LOCAL_TOOLS.has(call.tool as LocalToolName)) {
        return { output: { error: `unknown tool: ${call.tool}` }, isError: true };
      }
      const result = await executor.execute(call.tool as LocalToolName, call.input);
      return { output: result.output, isError: result.isError };
    };

    return { client: mockAnthropic(opts.turns), gate, executeTool };
  });

  const chatStore = new ChatStore({ db, resolveContext, runEngineTurn });
  chatStore.onEvent(emitEvent);

  function applyCommand(command: EngineCommand): void {
    switch (command.type) {
      case 'engine.interrupt':
        void chatStore.interrupt(command.chatId);
        return;
      case 'tool.permission.resolve':
        pending.resolve(command.chatId, command.callId, {
          decision: command.decision,
          ...(command.reason !== undefined ? { reason: command.reason } : {}),
          ...(command.remember !== undefined ? { remember: command.remember } : {}),
        });
        return;
      case 'engine.send':
        return;
      default: {
        const exhaustive: never = command;
        void exhaustive;
      }
    }
  }

  const apis: HostApis = {
    projects: bindApi({ list: () => db.projects.list() }),
    chats: bindApi(chatStore),
    runtimes: bindApi({ list: () => [] }),
    settings: bindApi({}),
  };

  // The real client constructs the socket via WebSocketImpl; we grab that exact
  // instance (MemorySocket.last) and attach the fake host onto it.
  MemorySocket.last = null;
  const client = createRealIpcClient({
    url: 'ws://127.0.0.1:0',
    WebSocketImpl: MemorySocket as unknown as typeof WebSocket,
  });
  const socket = MemorySocket.last;
  if (socket === null) throw new Error('client did not construct a socket');

  const host = attachFakeHost(socket, {
    apis,
    applyCommand,
    onEngineEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });

  return { client, db, close: () => { host.close(); client.close(); } };
}

/** Collect engine events for a chat until a matching predicate fires. */
function waitForEvent(
  client: RealIpcClient,
  predicate: (e: EngineEvent) => boolean,
  timeoutMs = 2000,
): Promise<EngineEvent> {
  return new Promise<EngineEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error('timed out waiting for engine event'));
    }, timeoutMs);
    const unsub = client.engine.onEvent((e) => {
      if (predicate(e)) {
        clearTimeout(timer);
        unsub();
        resolve(e);
      }
    });
  });
}

// --- tests ------------------------------------------------------------------

describe('real IPC client ⇄ fake in-memory host (Anthropic mocked)', () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'vingsforge-ipc-'));
  });
  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('RPC: chats.create then chats.history flow over the socket', async () => {
    const backend = makeBackend({ turns: [], workspaceRoot });
    try {
      const projectRow = backend.db.projects.create({
        name: 'p',
        workspace: { kind: 'local', path: workspaceRoot },
      });

      const chat = await backend.client.chats.create(projectRow.id);
      expect(chat.projectId).toBe(projectRow.id);

      const history = await backend.client.chats.history(chat.id);
      expect(history).toEqual([]);
    } finally {
      backend.close();
    }
  });

  it('RPC error: an unknown chat id rejects with the host error message', async () => {
    const backend = makeBackend({ turns: [], workspaceRoot });
    try {
      await expect(backend.client.chats.history('ghost')).rejects.toThrow(/chat not found/i);
    } finally {
      backend.close();
    }
  });

  it('streams a plain-text turn end to end (message.delta + turn.end)', async () => {
    const backend = makeBackend({
      turns: [
        {
          events: [textDelta('Hello'), textDelta(' world')],
          final: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hello world' }] as Message['content'] },
        },
      ],
      workspaceRoot,
    });
    try {
      const project = backend.db.projects.create({
        name: 'p',
        workspace: { kind: 'local', path: workspaceRoot },
      });
      const chat = await backend.client.chats.create(project.id);

      const deltas: string[] = [];
      backend.client.engine.onEvent((e) => {
        if (e.type === 'message.delta' && e.chatId === chat.id) deltas.push(e.text);
      });
      const ended = waitForEvent(
        backend.client,
        (e) => e.type === 'turn.end' && e.chatId === chat.id,
      );

      await backend.client.chats.send(chat.id, 'hi');
      const end = await ended;

      expect(deltas.join('')).toBe('Hello world');
      expect(end).toMatchObject({ type: 'turn.end', stopReason: 'end_turn' });

      // The turn was persisted: user + assistant turns are in history.
      const history = await backend.client.chats.history(chat.id);
      expect(history.map((m) => m.role)).toContain('user');
      expect(history.map((m) => m.role)).toContain('assistant');
    } finally {
      backend.close();
    }
  });

  it('runs a real tool (read_file) when the chat auto-approves, and streams tool.result', async () => {
    writeFileSync(join(workspaceRoot, 'note.txt'), 'file body from disk', 'utf8');

    const toolUse = { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'note.txt' } };
    const backend = makeBackend({
      turns: [
        { events: [], final: { stop_reason: 'tool_use', content: [toolUse] as Message['content'] } },
        { events: [textDelta('read it')], final: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'read it' }] as Message['content'] } },
      ],
      workspaceRoot,
      modes: { autoApprove: true },
    });
    try {
      const project = backend.db.projects.create({
        name: 'p',
        workspace: { kind: 'local', path: workspaceRoot },
      });
      const chat = await backend.client.chats.create(project.id);

      const toolResult = waitForEvent(
        backend.client,
        (e) => e.type === 'tool.result' && e.callId === 'call_1',
      );
      const ended = waitForEvent(
        backend.client,
        (e) => e.type === 'turn.end' && e.chatId === chat.id,
      );

      await backend.client.chats.send(chat.id, 'read note.txt');

      const result = (await toolResult) as Extract<EngineEvent, { type: 'tool.result' }>;
      expect(result.isError).toBe(false);
      // The REAL ToolExecutor read the REAL file off disk.
      expect(result.output).toMatchObject({ content: 'file body from disk' });
      await ended;
    } finally {
      backend.close();
    }
  });

  it('gates a tool through the UI: tool.permission event, then a resolve command runs it', async () => {
    // `bash` is gated (read-only tools auto-run); a default policy of `ask` makes
    // the gate round-trip to the UI as a `tool.permission` event.
    const toolUse = { type: 'tool_use', id: 'call_g', name: 'bash', input: { command: 'echo gated-ok' } };
    const backend = makeBackend({
      turns: [
        { events: [], final: { stop_reason: 'tool_use', content: [toolUse] as Message['content'] } },
        { events: [textDelta('ok')], final: { stop_reason: 'end_turn', content: [] } },
      ],
      workspaceRoot,
      policy: { defaults: { bash: 'ask' } },
    });
    try {
      const project = backend.db.projects.create({
        name: 'p',
        workspace: { kind: 'local', path: workspaceRoot },
      });
      const chat = await backend.client.chats.create(project.id);

      const permissionAsk = waitForEvent(
        backend.client,
        (e) => e.type === 'tool.permission' && e.callId === 'call_g',
      );
      const toolResult = waitForEvent(
        backend.client,
        (e) => e.type === 'tool.result' && e.callId === 'call_g',
      );

      const sendDone = backend.client.chats.send(chat.id, 'run echo please');

      // The engine blocks on a permission prompt and pushes it to the UI.
      const ask = (await permissionAsk) as Extract<EngineEvent, { type: 'tool.permission' }>;
      expect(ask).toMatchObject({ tool: 'bash', callId: 'call_g' });

      // The UI approves via a command frame (the real client serializes it).
      await backend.client.engine.send({
        type: 'tool.permission.resolve',
        chatId: chat.id,
        callId: 'call_g',
        decision: 'allow',
      });

      const result = (await toolResult) as Extract<EngineEvent, { type: 'tool.result' }>;
      expect(result.isError).toBe(false);
      // The REAL bash tool ran in the workspace and produced stdout.
      expect((result.output as { stdout: string }).stdout).toContain('gated-ok');
      await sendDone;
    } finally {
      backend.close();
    }
  });

  it('read-only mode denies a write tool without executing it', async () => {
    const toolUse = { type: 'tool_use', id: 'call_w', name: 'write_file', input: { path: 'out.txt', content: 'nope' } };
    const backend = makeBackend({
      turns: [
        { events: [], final: { stop_reason: 'tool_use', content: [toolUse] as Message['content'] } },
        { events: [textDelta('blocked')], final: { stop_reason: 'end_turn', content: [] } },
      ],
      workspaceRoot,
      modes: { readOnly: true },
    });
    try {
      const project = backend.db.projects.create({
        name: 'p',
        workspace: { kind: 'local', path: workspaceRoot },
      });
      const chat = await backend.client.chats.create(project.id);

      const toolResult = waitForEvent(
        backend.client,
        (e) => e.type === 'tool.result' && e.callId === 'call_w',
      );

      await backend.client.chats.send(chat.id, 'write a file');
      const result = (await toolResult) as Extract<EngineEvent, { type: 'tool.result' }>;
      expect(result.isError).toBe(true);
    } finally {
      backend.close();
    }
  });
});
