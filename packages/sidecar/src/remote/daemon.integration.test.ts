/**
 * forge-daemon <-> client integration (Spec 05 §4/§5/§8). Real `ws` over
 * loopback (the SSH tunnel is bypassed with an injected opener); the Anthropic
 * client is mocked — NO real API call. We assert the end-to-end stream, app-side
 * permission gating of a remote tool, a real tool executing on the VPS-side FS,
 * fsList, and event dedupe by seq.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type {
  Message,
  MessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages';
import type { EngineEvent, RemoteRuntimeStatus } from '@vingsforge/shared';
import type { AnthropicLike, MessageStreamLike, StreamRequest } from '../engine/client.js';
import { AUTH_SUBPROTOCOL, startForgeDaemon, type ForgeDaemon } from './daemon.js';
import { RemoteRuntimeClient } from './client.js';
import type { RuntimeRecord } from '@vingsforge/persistence';

function usage(): Message['usage'] {
  return {
    input_tokens: 4,
    output_tokens: 2,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    cache_creation: null,
    server_tool_use: null,
    service_tier: null,
  };
}

function msg(partial: Partial<Message> & Pick<Message, 'stop_reason'>): Message {
  return {
    id: partial.id ?? 'm1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-8',
    content: partial.content ?? [],
    stop_reason: partial.stop_reason,
    stop_sequence: null,
    usage: partial.usage ?? usage(),
  } as Message;
}

/**
 * Mock client: turn 1 issues one tool_use; turn 2 ends the turn. The tool name
 * is parameterized so a test can exercise a read-only tool (auto-runs, no
 * prompt) vs. a gated tool (bash → `ask`/`deny` per policy).
 */
function toolThenEndClient(
  tool: { name: string; input: Record<string, unknown> } = {
    name: 'bash',
    input: { command: 'cat hello.txt' },
  },
): AnthropicLike {
  const turns: Message[] = [
    msg({
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'call-1', name: tool.name, input: tool.input },
      ] as Message['content'],
    }),
    msg({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'done' }] as Message['content'],
    }),
  ];
  let cursor = 0;
  return {
    messages: {
      stream(_body: StreamRequest): MessageStreamLike {
        const final = turns[cursor];
        cursor += 1;
        return {
          // eslint-disable-next-line @typescript-eslint/require-await
          async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
            // no deltas needed for this assertion
          },
          async finalMessage(): Promise<Message> {
            if (!final) throw new Error('no more turns');
            return final;
          },
          abort(): void {},
        };
      },
    },
  };
}

/** Mock client that ends every turn with a plain text reply (no tools). */
function endTurnClient(): AnthropicLike {
  return {
    messages: {
      stream(_body: StreamRequest): MessageStreamLike {
        return {
          // eslint-disable-next-line @typescript-eslint/require-await
          async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
            // no deltas needed for this assertion
          },
          async finalMessage(): Promise<Message> {
            return msg({
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'ok' }] as Message['content'],
            });
          },
          abort(): void {},
        };
      },
    },
  };
}

const RECORD: RuntimeRecord = {
  id: 'rt-1',
  label: 'box',
  ssh: { host: '127.0.0.1', port: 22, user: 'root' },
  daemon: { installPath: '/opt/forge' },
  apiKeyLocation: 'daemon',
};

describe('forge-daemon integration (Spec 05)', () => {
  let workspace: string;
  let daemon: ForgeDaemon;
  let client: RemoteRuntimeClient | undefined;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'forge-remote-'));
    writeFileSync(join(workspace, 'hello.txt'), 'remote file body', 'utf8');
  });

  afterEach(async () => {
    await client?.disconnect();
    await daemon?.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  async function bootClient(
    events: EngineEvent[],
    statuses: RemoteRuntimeStatus[],
    opts: {
      client?: AnthropicLike;
      context?: () => import('./daemon.js').DaemonTurnContext;
    } = {},
  ): Promise<RemoteRuntimeClient> {
    daemon = await startForgeDaemon({
      client: opts.client ?? toolThenEndClient(),
      workspaceRoot: workspace,
      resolveTurnContext: opts.context ?? (() => ({ system: 'sys', history: [] })),
    });
    const localPort = daemon.port;
    const c = new RemoteRuntimeClient(
      RECORD,
      { onEvent: (e) => events.push(e), onStatus: (s) => statuses.push(s) },
      {
        // Bypass the SSH tunnel: forward straight to the daemon's loopback port.
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

  it('streams a remote turn with app-side permission gating of a genuine ask', async () => {
    const events: EngineEvent[] = [];
    const statuses: RemoteRuntimeStatus[] = [];
    // Default policy: `bash` resolves to the global `ask` default, so the daemon
    // forwards it to the app instead of running or refusing it server-side.
    const c = await bootClient(events, statuses);

    c.sendCommand({ type: 'engine.send', chatId: 'c1', text: 'read it' });

    // The daemon emits tool.permission and blocks; the app approves it.
    await waitFor(() => events.some((e) => e.type === 'tool.permission'));
    const perm = events.find((e) => e.type === 'tool.permission')!;
    expect(perm.type).toBe('tool.permission');
    c.resolvePermission('c1', 'call-1', 'allow');

    await waitFor(() => events.some((e) => e.type === 'turn.end'));
    const result = events.find((e) => e.type === 'tool.result');
    expect(result?.type).toBe('tool.result');
    // The tool actually ran on the VPS-side FS and returned the file body.
    expect(JSON.stringify(result)).toContain('remote file body');
  });

  it('auto-runs read-only tools on the daemon without prompting (Spec 04 §2)', async () => {
    const events: EngineEvent[] = [];
    const statuses: RemoteRuntimeStatus[] = [];
    const c = await bootClient(events, statuses, {
      client: toolThenEndClient({ name: 'read_file', input: { path: 'hello.txt' } }),
    });

    c.sendCommand({ type: 'engine.send', chatId: 'c1', text: 'read it' });

    // No permission prompt: the read runs and the turn ends on its own.
    await waitFor(() => events.some((e) => e.type === 'turn.end'));
    expect(events.some((e) => e.type === 'tool.permission')).toBe(false);
    const result = events.find((e) => e.type === 'tool.result');
    expect(JSON.stringify(result)).toContain('remote file body');
  });

  it('enforces a deny rule server-side: the daemon never prompts nor runs the tool', async () => {
    const events: EngineEvent[] = [];
    const statuses: RemoteRuntimeStatus[] = [];
    // Policy denies bash; the daemon must refuse it itself (Spec 05 §5) — no
    // tool.permission reaches the app, and the tool never executes.
    const c = await bootClient(events, statuses, {
      context: () => ({
        system: 'sys',
        history: [],
        policy: { defaults: {}, rules: [{ tool: 'bash', decision: 'deny' }] },
      }),
    });

    c.sendCommand({ type: 'engine.send', chatId: 'c1', text: 'run it' });

    await waitFor(() => events.some((e) => e.type === 'turn.end'));
    expect(events.some((e) => e.type === 'tool.permission')).toBe(false);
    const result = events.find((e) => e.type === 'tool.result');
    // The agent gets a denied tool_result instead of command output.
    expect(JSON.stringify(result)).toContain('denied');
  });

  it('honors the per-turn context shipped on engine.send: history reaches the model, policy gates server-side (Spec 05 §4/§5)', async () => {
    // The daemon is stateless: when the app ships context on `engine.send`, the
    // daemon must use it and NOT call resolveTurnContext. Prove that by making
    // resolveTurnContext throw — the turn must still run from shipped context.
    const events: EngineEvent[] = [];
    const statuses: RemoteRuntimeStatus[] = [];
    const bodies: StreamRequest[] = [];
    const capturingClient: AnthropicLike = {
      messages: {
        stream(body: StreamRequest): MessageStreamLike {
          bodies.push(body);
          return {
            // eslint-disable-next-line @typescript-eslint/require-await
            async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
              // turn 1 issues a bash tool_use; nothing to stream.
            },
            finalMessage(): Promise<Message> {
              // First turn: a gated tool. Subsequent turns: end.
              const first = bodies.length === 1;
              return Promise.resolve(
                first
                  ? msg({
                      stop_reason: 'tool_use',
                      content: [
                        { type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'rm -rf /' } },
                      ] as Message['content'],
                    })
                  : msg({
                      stop_reason: 'end_turn',
                      content: [{ type: 'text', text: 'done' }] as Message['content'],
                    }),
              );
            },
            abort(): void {},
          };
        },
      },
    };

    daemon = await startForgeDaemon({
      client: capturingClient,
      workspaceRoot: workspace,
      resolveTurnContext: () => {
        throw new Error('resolveTurnContext must not be called when context is shipped');
      },
    });
    const localPort = daemon.port;
    const c = new RemoteRuntimeClient(
      RECORD,
      { onEvent: (e) => events.push(e), onStatus: (s) => statuses.push(s) },
      {
        openTunnel: async () => ({ localPort, close: async () => {} }),
        connectWs: (url) => new WebSocket(url),
        heartbeatMs: 1_000_000,
      },
    );
    client = c;
    await c.connect();
    await waitFor(() => statuses.includes('online'));

    const history: import('@vingsforge/shared').ChatMessage[] = [
      {
        id: 'm0',
        chatId: 'c1',
        role: 'user',
        blocks: [{ kind: 'text', text: 'prior turn from the app' }],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    c.sendCommand({
      type: 'engine.send',
      chatId: 'c1',
      text: 'do it',
      context: {
        system: 'shipped system prompt',
        history,
        policy: { defaults: {}, rules: [{ tool: 'bash', decision: 'deny' }] },
      },
    });

    await waitFor(() => events.some((e) => e.type === 'turn.end'));

    // Policy shipped on the command was enforced ON THE DAEMON: bash was denied,
    // never prompted to the app and never executed.
    expect(events.some((e) => e.type === 'tool.permission')).toBe(false);
    const result = events.find((e) => e.type === 'tool.result');
    expect(JSON.stringify(result)).toContain('denied');

    // The shipped history + system reached the model body (not an empty context).
    const body = bodies[0]!;
    expect(JSON.stringify(body.system)).toContain('shipped system prompt');
    expect(JSON.stringify(body.messages)).toContain('prior turn from the app');
  });

  it('lists a directory on the VPS via fsList', async () => {
    const events: EngineEvent[] = [];
    const statuses: RemoteRuntimeStatus[] = [];
    const c = await bootClient(events, statuses);
    const entries = await c.fsList('.');
    expect(entries.map((e) => e.name)).toContain('hello.txt');
  });

  it('rejects a WS connection that does not present the daemon auth token', async () => {
    // Spec 05 §2: loopback is not a trust boundary on a shared host — the daemon
    // must refuse any handshake without the per-runtime bearer token.
    daemon = await startForgeDaemon({
      client: toolThenEndClient(),
      workspaceRoot: workspace,
      resolveTurnContext: () => ({ system: 'sys', history: [] }),
      authToken: 'secret-token',
    });
    const url = `ws://127.0.0.1:${daemon.port}`;

    // No subprotocol/token: the upgrade is rejected before any session runs.
    const unauth = new WebSocket(url);
    const unauthFailed = await new Promise<boolean>((resolve) => {
      unauth.on('open', () => resolve(false));
      unauth.on('error', () => resolve(true));
    });
    expect(unauthFailed).toBe(true);

    // A matching token completes the handshake.
    const authed = new WebSocket(url, [AUTH_SUBPROTOCOL, 'secret-token']);
    const opened = await new Promise<boolean>((resolve) => {
      authed.on('open', () => resolve(true));
      authed.on('error', () => resolve(false));
    });
    expect(opened).toBe(true);
    authed.close();
  });

  it('keeps delivering events after a drop+reconnect (seq resets server-side, Spec 05 §8)', async () => {
    // Regression: the daemon's seq is per-DaemonSession and restarts at 0 on a
    // new connection, so the client's dedupe cursor MUST reset per-connection.
    // Otherwise the first reconnect's low-seq frames are all dropped and the
    // remote turn produces no UI events (defeats acceptance #4).
    const events: EngineEvent[] = [];
    const statuses: RemoteRuntimeStatus[] = [];
    daemon = await startForgeDaemon({
      // Plain assistant turn (no tool) on every `engine.send`, so a turn can run
      // both before and after the reconnect.
      client: endTurnClient(),
      workspaceRoot: workspace,
      resolveTurnContext: () => ({ system: 'sys', history: [] }),
    });
    const localPort = daemon.port;
    const c = new RemoteRuntimeClient(
      RECORD,
      { onEvent: (e) => events.push(e), onStatus: (s) => statuses.push(s) },
      {
        openTunnel: async () => ({ localPort, close: async () => {} }),
        connectWs: (url) => new WebSocket(url),
        heartbeatMs: 1_000_000,
        baseBackoffMs: 5,
      },
    );
    client = c;
    await c.connect();
    await waitFor(() => statuses.includes('online'));

    // First turn streams fine on the initial session.
    c.sendCommand({ type: 'engine.send', chatId: 'c1', text: 'one' });
    await waitFor(() => events.some((e) => e.type === 'turn.end'));
    const beforeDrop = events.length;
    expect(beforeDrop).toBeGreaterThan(0);

    // Simulate a transport drop: terminate the daemon-side socket so the client
    // sees a close and reconnects with a brand-new DaemonSession (seq back to 0).
    daemon.dropConnections();
    await waitFor(() => statuses.lastIndexOf('online') > statuses.indexOf('online'));

    // The post-reconnect turn must still surface events, even though its frames
    // carry low seq values that a stale cursor would have suppressed.
    c.sendCommand({ type: 'engine.send', chatId: 'c2', text: 'two' });
    await waitFor(() => events.some((e) => e.type === 'turn.end' && e.chatId === 'c2'));
    expect(events.length).toBeGreaterThan(beforeDrop);
    expect(events.some((e) => e.type === 'turn.end' && e.chatId === 'c2')).toBe(true);
  });

  it('connects through the client when the runtime carries the matching token', async () => {
    daemon = await startForgeDaemon({
      client: toolThenEndClient(),
      workspaceRoot: workspace,
      resolveTurnContext: () => ({ system: 'sys', history: [] }),
      authToken: 'secret-token',
    });
    const localPort = daemon.port;
    const statuses: RemoteRuntimeStatus[] = [];
    const c = new RemoteRuntimeClient(
      { ...RECORD, authToken: 'secret-token' },
      { onEvent: () => {}, onStatus: (s) => statuses.push(s) },
      {
        openTunnel: async () => ({ localPort, close: async () => {} }),
        connectWs: (u, p) => new WebSocket(u, p),
        heartbeatMs: 1_000_000,
      },
    );
    client = c;
    await c.connect();
    await waitFor(() => statuses.includes('online'));
    expect(c.currentStatus).toBe('online');
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
