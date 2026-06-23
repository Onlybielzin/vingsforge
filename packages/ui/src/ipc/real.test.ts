/**
 * Tests for the real WebSocket-backed IpcClient (Spec 06 §7). Uses an in-process
 * fake WebSocket (no DOM) that records sent frames and lets the test push server
 * frames back, exercising:
 *  - RPC id correlation: rpc.ok resolves, rpc.err rejects with an Error;
 *  - the engine event stream feeds onEvent listeners (and unsubscribe stops it);
 *  - engine.send ships a {kind:'command'} frame (interrupt / permission resolve);
 *  - frames issued before the socket opens queue and flush on open.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineEvent, ServerMsg } from '@vingsforge/shared';
import { createRealIpcClient } from './real.js';

/** Minimal fake of the browser WebSocket the client drives. */
class FakeWebSocket {
  static CONNECTING = 0 as const;
  static OPEN = 1 as const;
  static CLOSING = 2 as const;
  static CLOSED = 3 as const;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState: number = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(frame: string): void {
    this.sent.push(frame);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  // --- test helpers ---
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  server(msg: ServerMsg): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  parsedSent(): Array<Record<string, unknown>> {
    return this.sent.map((f) => JSON.parse(f) as Record<string, unknown>);
  }
}

afterEach(() => {
  FakeWebSocket.instances = [];
});

function makeClient(): {
  client: ReturnType<typeof createRealIpcClient>;
  ws: () => FakeWebSocket;
} {
  const client = createRealIpcClient({
    url: 'ws://127.0.0.1:8731',
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
  });
  return { client, ws: () => FakeWebSocket.instances.at(-1)! };
}

describe('real IpcClient — RPC correlation', () => {
  it('queues an RPC before open, flushes on open, resolves on rpc.ok', async () => {
    const { client, ws } = makeClient();
    const sock = ws();

    // Issued while CONNECTING: nothing on the wire yet.
    const p = client.projects.list();
    expect(sock.sent).toHaveLength(0);

    sock.open();
    const frames = sock.parsedSent();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: 'rpc', api: 'projects', method: 'list', args: [] });

    const id = frames[0]!['id'] as string;
    sock.server({ kind: 'rpc.ok', id, result: [{ id: 'p-1' }] });
    await expect(p).resolves.toEqual([{ id: 'p-1' }]);
  });

  it('rejects with an Error carrying the host message on rpc.err', async () => {
    const { client, ws } = makeClient();
    const sock = ws();
    sock.open();

    const p = client.projects.open('nope');
    const frame = sock.parsedSent().at(-1)!;
    expect(frame).toMatchObject({ api: 'projects', method: 'open', args: ['nope'] });

    sock.server({ kind: 'rpc.err', id: frame['id'] as string, error: { message: 'Unknown project nope' } });
    await expect(p).rejects.toThrow(/Unknown project nope/);
  });

  it('forwards method args verbatim (chats.send)', async () => {
    const { client, ws } = makeClient();
    const sock = ws();
    sock.open();

    const p = client.chats.send('c-1', 'hello', { autoApprove: true });
    const frame = sock.parsedSent().at(-1)!;
    expect(frame).toMatchObject({
      kind: 'rpc',
      api: 'chats',
      method: 'send',
      args: ['c-1', 'hello', { autoApprove: true }],
    });
    sock.server({ kind: 'rpc.ok', id: frame['id'] as string, result: undefined });
    await expect(p).resolves.toBeUndefined();
  });
});

describe('real IpcClient — engine channel', () => {
  it('delivers pushed events to listeners until unsubscribe', () => {
    const { client, ws } = makeClient();
    const sock = ws();
    sock.open();

    const seen: EngineEvent[] = [];
    const unsub = client.engine.onEvent((e) => seen.push(e));

    const evt: EngineEvent = { type: 'message.delta', chatId: 'c-1', text: 'hi' };
    sock.server({ kind: 'event', event: evt });
    expect(seen).toEqual([evt]);

    unsub();
    sock.server({ kind: 'event', event: { type: 'message.delta', chatId: 'c-1', text: 'more' } });
    expect(seen).toHaveLength(1);
  });

  it('engine.send pushes a command frame (interrupt)', async () => {
    const { client, ws } = makeClient();
    const sock = ws();
    sock.open();

    await client.engine.send({ type: 'engine.interrupt', chatId: 'c-1' });
    const frame = sock.parsedSent().at(-1)!;
    expect(frame).toMatchObject({
      kind: 'command',
      command: { type: 'engine.interrupt', chatId: 'c-1' },
    });
  });

  it('engine.send pushes a permission resolution command', async () => {
    const { client, ws } = makeClient();
    const sock = ws();
    sock.open();

    await client.engine.send({
      type: 'tool.permission.resolve',
      chatId: 'c-1',
      callId: 'k1',
      decision: 'allow',
      remember: true,
    });
    const frame = sock.parsedSent().at(-1)!;
    expect(frame).toMatchObject({
      kind: 'command',
      command: { type: 'tool.permission.resolve', callId: 'k1', decision: 'allow', remember: true },
    });
  });

  it('ignores a hello frame without erroring', () => {
    const { client, ws } = makeClient();
    const sock = ws();
    sock.open();
    const seen: EngineEvent[] = [];
    client.engine.onEvent((e) => seen.push(e));
    sock.server({ kind: 'hello', protocol: 1 });
    expect(seen).toHaveLength(0);
  });
});

describe('real IpcClient — lifecycle', () => {
  it('reconnects with backoff after the socket closes', () => {
    vi.useFakeTimers();
    try {
      makeClient();
      const first = FakeWebSocket.instances.length;
      const sock = FakeWebSocket.instances.at(-1)!;
      sock.open();
      sock.onclose?.({});
      // Backoff is 250ms for the first retry.
      vi.advanceTimersByTime(300);
      expect(FakeWebSocket.instances.length).toBe(first + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('close() rejects in-flight RPCs', async () => {
    const { client, ws } = makeClient();
    ws().open();
    const p = client.projects.list();
    client.close();
    await expect(p).rejects.toThrow(/closed/i);
  });
});
