/**
 * Local protocol (loopback UI <-> sidecar) encode/decode roundtrip tests.
 *
 * The local host (server.ts) and the UI real client (ui/src/ipc/real.ts) both
 * serialize the {@link ClientMsg}/{@link ServerMsg} frames from
 * `@vingsforge/shared` with `JSON.stringify` and parse them back with
 * `JSON.parse`. These tests pin that the JSON wire form is lossless for every
 * frame variant and every {@link EngineCommand}/{@link EngineEvent} payload it
 * carries — i.e. `decode(encode(frame))` is deep-equal to `frame`, the
 * discriminants survive, and nothing on the structurally-typed payloads is
 * silently dropped. NO socket and NO Anthropic call are involved.
 */
import { describe, expect, it } from 'vitest';
import {
  LOCAL_PROTOCOL_VERSION,
  type ChatMessage,
  type ClientMsg,
  type EngineCommand,
  type EngineEvent,
  type ServerMsg,
} from '@vingsforge/shared';

/** The exact pair the transports use: `JSON.stringify` then `JSON.parse`. */
function roundtripClient(frame: ClientMsg): ClientMsg {
  return JSON.parse(JSON.stringify(frame)) as ClientMsg;
}
function roundtripServer(frame: ServerMsg): ServerMsg {
  return JSON.parse(JSON.stringify(frame)) as ServerMsg;
}

describe('localproto roundtrip — ClientMsg (UI -> sidecar)', () => {
  it('rpc request preserves id, api, method and args verbatim', () => {
    const frame: ClientMsg = {
      kind: 'rpc',
      id: '42',
      api: 'chats',
      method: 'send',
      // Heterogeneous args incl. nested object, null, boolean — the host spreads
      // these straight into `api[method](...args)`, so order/shape must survive.
      args: ['chat-1', 'hello world', { autoApprove: true, readOnly: false }],
    };
    const back = roundtripClient(frame);
    expect(back).toEqual(frame);
    expect(back.kind).toBe('rpc');
  });

  it('rpc request with empty args survives', () => {
    const frame: ClientMsg = {
      kind: 'rpc',
      id: '1',
      api: 'projects',
      method: 'list',
      args: [],
    };
    expect(roundtripClient(frame)).toEqual(frame);
  });

  it.each<{ name: string; command: EngineCommand }>([
    {
      name: 'engine.interrupt',
      command: { type: 'engine.interrupt', chatId: 'chat-9' },
    },
    {
      name: 'tool.permission.resolve (allow + remember)',
      command: {
        type: 'tool.permission.resolve',
        chatId: 'chat-1',
        callId: 'call_1',
        decision: 'allow',
        remember: true,
      },
    },
    {
      name: 'tool.permission.resolve (deny + reason)',
      command: {
        type: 'tool.permission.resolve',
        chatId: 'chat-1',
        callId: 'call_2',
        decision: 'deny',
        reason: 'user rejected rm -rf',
      },
    },
    {
      name: 'engine.send with full context',
      command: {
        type: 'engine.send',
        chatId: 'chat-1',
        text: 'do the thing',
        context: {
          system: 'You are a test agent.',
          history: [],
          model: 'claude-opus-4-8',
          effort: 'high',
          maxTokens: 4096,
          volatileContext: 'Current date: 2026-06-23.',
          policy: { defaults: { bash: 'ask' } },
          modes: { autoApprove: true },
        },
      },
    },
  ])('command frame roundtrips: $name', ({ command }) => {
    const frame: ClientMsg = { kind: 'command', command };
    const back = roundtripClient(frame);
    expect(back).toEqual(frame);
    // Discriminant on the nested command must survive too.
    expect((back as Extract<ClientMsg, { kind: 'command' }>).command.type).toBe(
      command.type,
    );
  });
});

describe('localproto roundtrip — ServerMsg (sidecar -> UI)', () => {
  it('hello carries the current protocol version', () => {
    const frame: ServerMsg = { kind: 'hello', protocol: LOCAL_PROTOCOL_VERSION };
    const back = roundtripServer(frame);
    expect(back).toEqual(frame);
    expect((back as Extract<ServerMsg, { kind: 'hello' }>).protocol).toBe(1);
  });

  it('rpc.ok preserves an arbitrary serializable result', () => {
    const frame: ServerMsg = {
      kind: 'rpc.ok',
      id: '7',
      result: { id: 'p-1', chats: [{ id: 'c-1', title: 'New chat' }], nested: { a: [1, 2, 3] } },
    };
    expect(roundtripServer(frame)).toEqual(frame);
  });

  it('rpc.ok with an undefined result becomes a key-absent payload (void RPCs)', () => {
    // chats.send / rename resolve to undefined. JSON drops `result`, and the
    // client treats the missing key as undefined — assert that round-trip.
    const frame: ServerMsg = { kind: 'rpc.ok', id: '8', result: undefined };
    const back = roundtripServer(frame);
    expect(back).toMatchObject({ kind: 'rpc.ok', id: '8' });
    expect((back as Extract<ServerMsg, { kind: 'rpc.ok' }>).result).toBeUndefined();
  });

  it('rpc.err preserves the message and optional name (no secrets, just text)', () => {
    const frame: ServerMsg = {
      kind: 'rpc.err',
      id: '9',
      error: { message: 'unknown project nope', name: 'ProjectNotFoundError' },
    };
    expect(roundtripServer(frame)).toEqual(frame);
  });
});

describe('localproto roundtrip — EngineEvent payloads (event frames)', () => {
  const events: EngineEvent[] = [
    { type: 'message.delta', chatId: 'c-1', text: 'Hi there' },
    { type: 'thinking.delta', chatId: 'c-1', text: 'let me think' },
    { type: 'tool.start', chatId: 'c-1', tool: 'read_file', input: { path: 'a.txt' }, callId: 'k1' },
    { type: 'tool.permission', chatId: 'c-1', callId: 'k2', tool: 'bash', input: { command: 'ls' } },
    { type: 'tool.result', chatId: 'c-1', callId: 'k1', output: { content: 'body' }, isError: false },
    { type: 'tool.result', chatId: 'c-1', callId: 'k3', output: { error: 'denied' }, isError: true },
    { type: 'turn.end', chatId: 'c-1', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'error', chatId: 'c-1', message: 'No Anthropic API key configured.' },
  ];

  it.each(events.map((e) => [e.type, e] as const))(
    'event %s survives an event-frame roundtrip',
    (_type, event) => {
      const frame: ServerMsg = { kind: 'event', event };
      const back = roundtripServer(frame);
      expect(back).toEqual(frame);
      expect((back as Extract<ServerMsg, { kind: 'event' }>).event.type).toBe(event.type);
    },
  );

  it('preserves a tool.result whose output is a rich ChatMessage-like object', () => {
    const message: ChatMessage = {
      id: 'm-1',
      chatId: 'c-1',
      role: 'assistant',
      blocks: [
        { kind: 'text', text: 'done' },
        { kind: 'tool_use', callId: 'k1', tool: 'read_file', input: { path: 'a.txt' } },
      ],
      usage: { inputTokens: 1, outputTokens: 2 },
      model: 'claude-opus-4-8',
      createdAt: '2026-06-23T00:00:00.000Z',
    };
    const frame: ServerMsg = {
      kind: 'event',
      event: { type: 'tool.result', chatId: 'c-1', callId: 'k1', output: message, isError: false },
    };
    expect(roundtripServer(frame)).toEqual(frame);
  });
});

describe('localproto roundtrip — unknown-frame robustness', () => {
  it('a malformed (non-JSON) frame is detectable by the parse step', () => {
    // The host wraps JSON.parse in a try/catch and drops bad frames; pin that
    // the encoder/decoder contract is "valid JSON only".
    expect(() => JSON.parse('{not json')).toThrow();
  });
});
