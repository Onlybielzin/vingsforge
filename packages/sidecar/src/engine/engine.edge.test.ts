/**
 * Engine edge/safety tests (Spec 03). Complements engine.test.ts by exercising
 * the branches the happy-path suite leaves uncovered: the runaway-loop cap, a
 * mid-stream (non-abort) API error, tool/gate executors that throw, multi-tool
 * batching into ONE user message, max_tokens surfacing, cache-token usage
 * accumulation, partial interruption that preserves already-run outcomes, and
 * prompt-assembly safety (tool_result serialization, deterministic tool order,
 * empty-turn dropping, circular-output fallback). The Anthropic client is fully
 * mocked — NO real API call is made.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  Message,
  MessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages';
import type { ChatMessage, EngineEvent } from '@vingsforge/shared';
import { Engine, type EngineDeps, type ToolCall, type ToolOutcome } from './engine.js';
import type { AnthropicLike, MessageStreamLike, StreamRequest } from './client.js';
import { buildMessages, buildRequest, buildTools, serializeToolOutput } from './prompt.js';

// ---------------------------------------------------------------------------
// Shared mock scaffolding (mirrors engine.test.ts conventions).
// ---------------------------------------------------------------------------

interface ScriptedTurn {
  events: MessageStreamEvent[];
  final: Partial<Message> & Pick<Message, 'stop_reason'>;
  /** When set, the stream throws this instead of resolving finalMessage(). */
  throws?: unknown;
}

function usage(over: Partial<Message['usage']> = {}): Message['usage'] {
  return {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    cache_creation: null,
    server_tool_use: null,
    service_tier: null,
    ...over,
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

function mockClient(turns: ScriptedTurn[]): {
  client: AnthropicLike;
  requests: StreamRequest[];
} {
  const requests: StreamRequest[] = [];
  let cursor = 0;
  const client: AnthropicLike = {
    messages: {
      stream(body: StreamRequest): MessageStreamLike {
        requests.push(body);
        const turn = turns[cursor];
        cursor += 1;
        if (turn === undefined) throw new Error('mock: no more scripted turns');
        let didAbort = false;
        return {
          // eslint-disable-next-line @typescript-eslint/require-await
          async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
            for (const ev of turn.events) {
              if (didAbort) return;
              yield ev;
            }
          },
          async finalMessage(): Promise<Message> {
            if (turn.throws !== undefined) throw turn.throws;
            return makeMessage(turn.final);
          },
          abort(): void {
            didAbort = true;
          },
        };
      },
    },
  };
  return { client, requests };
}

/** A client that always returns a fresh tool_use turn (to exercise the cap). */
function infiniteToolClient(): { client: AnthropicLike; calls: () => number } {
  let n = 0;
  const client: AnthropicLike = {
    messages: {
      stream(): MessageStreamLike {
        n += 1;
        const id = `call_${n}`;
        return {
          // eslint-disable-next-line @typescript-eslint/require-await
          async *[Symbol.asyncIterator](): AsyncIterator<MessageStreamEvent> {
            // no deltas
          },
          async finalMessage(): Promise<Message> {
            return makeMessage({
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id, name: 'glob', input: {} }] as Message['content'],
            });
          },
          abort(): void {},
        };
      },
    },
  };
  return { client, calls: () => n };
}

const baseParams = {
  chatId: 'chat-1',
  system: 'You are a test agent.',
  history: [] as ChatMessage[],
  userText: 'hello',
};

function collector(): { events: EngineEvent[]; emit: (e: EngineEvent) => void } {
  const events: EngineEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

const allowGate: EngineDeps['gate'] = async () => ({ allow: true });
const noTools: EngineDeps['executeTool'] = async () => ({ output: '', isError: false });

// ---------------------------------------------------------------------------
// Runaway-loop safety.
// ---------------------------------------------------------------------------

describe('Engine.runTurn — runaway loop cap', () => {
  it('stops after the iteration cap even if the model never ends the turn', async () => {
    const { client, calls } = infiniteToolClient();
    const engine = new Engine({ client, gate: allowGate, executeTool: noTools });
    const { events, emit } = collector();

    const result = await engine.runTurn(baseParams, emit);

    expect(result.stopReason).toBe('end_turn');
    // The cap is 100 iterations — it must terminate, not loop forever.
    expect(calls()).toBeLessThanOrEqual(100);
    expect(calls()).toBeGreaterThan(1);
    expect(events.at(-1)).toMatchObject({ type: 'turn.end', stopReason: 'end_turn' });
  });
});

// ---------------------------------------------------------------------------
// Stream / API error handling (non-abort).
// ---------------------------------------------------------------------------

describe('Engine.runTurn — stream errors', () => {
  it('emits an error event and ends the turn when the stream throws (non-abort)', async () => {
    const { client } = mockClient([
      { events: [], final: { stop_reason: 'end_turn' }, throws: new Error('overloaded_error') },
    ]);
    const engine = new Engine({ client, gate: allowGate, executeTool: noTools });
    const { events, emit } = collector();

    const result = await engine.runTurn(baseParams, emit);

    expect(result.stopReason).toBe('end_turn');
    const err = events.find((e) => e.type === 'error');
    expect(err).toMatchObject({ type: 'error', chatId: 'chat-1', message: 'overloaded_error' });
    // No turn.end is emitted on a hard error — the error event is terminal.
    expect(events.some((e) => e.type === 'turn.end')).toBe(false);
  });

  it('stringifies a non-Error thrown value in the error event', async () => {
    const { client } = mockClient([
      { events: [], final: { stop_reason: 'end_turn' }, throws: 'boom-string' },
    ]);
    const engine = new Engine({ client, gate: allowGate, executeTool: noTools });
    const { events, emit } = collector();

    await engine.runTurn(baseParams, emit);

    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: 'boom-string' });
  });
});

// ---------------------------------------------------------------------------
// Tool / gate executor failures (non-abort) become is_error results, not crashes.
// ---------------------------------------------------------------------------

describe('Engine.runTurn — tool execution failures', () => {
  function oneToolThen(final2: ScriptedTurn['final']): ScriptedTurn[] {
    return [
      {
        events: [],
        final: {
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'x' } }] as Message['content'],
        },
      },
      { events: [], final: final2 },
    ];
  }

  it('a thrown executeTool yields an is_error tool_result carrying the message', async () => {
    const { client } = mockClient(oneToolThen({ stop_reason: 'end_turn' }));
    const executeTool: EngineDeps['executeTool'] = async () => {
      throw new Error('disk full');
    };
    const engine = new Engine({ client, gate: allowGate, executeTool });
    const { events, emit } = collector();

    const result = await engine.runTurn(baseParams, emit);

    expect(result.stopReason).toBe('end_turn');
    const toolResult = events.find((e) => e.type === 'tool.result');
    expect(toolResult).toMatchObject({ isError: true });
    expect((toolResult as Extract<EngineEvent, { type: 'tool.result' }>).output).toMatchObject({
      error: 'disk full',
    });
  });

  it('a thrown gate (non-abort) yields an is_error tool_result and never executes', async () => {
    const { client } = mockClient(oneToolThen({ stop_reason: 'end_turn' }));
    const executeTool = vi.fn<(c: ToolCall, s: AbortSignal) => Promise<ToolOutcome>>();
    const gate: EngineDeps['gate'] = async () => {
      throw new Error('gate exploded');
    };
    const engine = new Engine({ client, gate, executeTool });
    const { events, emit } = collector();

    await engine.runTurn(baseParams, emit);

    expect(executeTool).not.toHaveBeenCalled();
    const toolResult = events.find((e) => e.type === 'tool.result');
    expect((toolResult as Extract<EngineEvent, { type: 'tool.result' }>).output).toMatchObject({
      error: 'gate exploded',
    });
  });
});

// ---------------------------------------------------------------------------
// Multiple tool_use blocks → one batched user message.
// ---------------------------------------------------------------------------

describe('Engine.runTurn — multi-tool batching', () => {
  it('runs every tool_use in a turn and batches all results into ONE user message', async () => {
    const toolA = { type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'a.txt' } };
    const toolB = { type: 'tool_use', id: 'b', name: 'read_file', input: { path: 'b.txt' } };
    const { client, requests } = mockClient([
      { events: [], final: { stop_reason: 'tool_use', content: [toolA, toolB] as Message['content'] } },
      { events: [textDelta('ok')], final: { stop_reason: 'end_turn', content: [] } },
    ]);
    const executeTool = vi.fn<(c: ToolCall, s: AbortSignal) => Promise<ToolOutcome>>(
      async (call) => ({ output: { read: (call.input as { path: string }).path }, isError: false }),
    );
    const engine = new Engine({ client, gate: allowGate, executeTool });
    const { emit } = collector();

    await engine.runTurn(baseParams, emit);

    expect(executeTool).toHaveBeenCalledTimes(2);

    const second = (requests[1]?.messages ?? []) as Array<{ role: string; content: Array<{ type?: string; tool_use_id?: string }> }>;
    const resultMsgs = second.filter((m) => m.content.some((c) => c.type === 'tool_result'));
    // BOTH results in a single user message (Spec 03 §4).
    expect(resultMsgs).toHaveLength(1);
    const ids = resultMsgs[0]!.content.map((c) => c.tool_use_id);
    expect(ids).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// Stop-reason surfacing + usage accumulation with cache tokens.
// ---------------------------------------------------------------------------

describe('Engine.runTurn — stop reasons & usage', () => {
  it('surfaces max_tokens as the turn.end stop reason', async () => {
    const { client } = mockClient([
      { events: [textDelta('truncat')], final: { stop_reason: 'max_tokens', content: [] } },
    ]);
    const engine = new Engine({ client, gate: allowGate, executeTool: noTools });
    const { events, emit } = collector();

    const result = await engine.runTurn(baseParams, emit);

    expect(result.stopReason).toBe('max_tokens');
    expect(events.at(-1)).toMatchObject({ type: 'turn.end', stopReason: 'max_tokens' });
  });

  it('maps an unknown stop_reason to end_turn defensively', async () => {
    const { client } = mockClient([
      { events: [], final: { stop_reason: 'something_new' as Message['stop_reason'], content: [] } },
    ]);
    const engine = new Engine({ client, gate: allowGate, executeTool: noTools });
    const { emit } = collector();

    const result = await engine.runTurn(baseParams, emit);
    expect(result.stopReason).toBe('end_turn');
  });

  it('accumulates cache-creation and cache-read tokens across iterations', async () => {
    const toolUse = { type: 'tool_use', id: 'c1', name: 'glob', input: {} };
    const { client } = mockClient([
      {
        events: [],
        final: {
          stop_reason: 'tool_use',
          content: [toolUse] as Message['content'],
          usage: usage({ input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 80, cache_read_input_tokens: 0 }),
        },
      },
      {
        events: [],
        final: {
          stop_reason: 'end_turn',
          content: [],
          usage: usage({ input_tokens: 30, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 180 }),
        },
      },
    ]);
    const engine = new Engine({ client, gate: allowGate, executeTool: noTools });
    const { emit } = collector();

    const result = await engine.runTurn(baseParams, emit);

    expect(result.usage).toEqual({
      inputTokens: 130,
      outputTokens: 30,
      cacheCreationInputTokens: 80,
      cacheReadInputTokens: 180,
    });
  });
});

// ---------------------------------------------------------------------------
// Partial interruption: outcomes of already-run tools survive.
// ---------------------------------------------------------------------------

describe('Engine.runTurn — partial interruption', () => {
  it('keeps the first tool outcome and synthesizes interrupted for the rest', async () => {
    const controller = new AbortController();
    const toolA = { type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'a.txt' } };
    const toolB = { type: 'tool_use', id: 'b', name: 'bash', input: { command: 'x' } };
    const { client } = mockClient([
      { events: [], final: { stop_reason: 'tool_use', content: [toolA, toolB] as Message['content'] } },
    ]);
    // First tool runs fine; after it completes we abort, so the loop closes B
    // with a synthesized interrupted result before running it.
    const executeTool = vi.fn<(c: ToolCall, s: AbortSignal) => Promise<ToolOutcome>>(async (call) => {
      if (call.callId === 'a') {
        controller.abort();
        return { output: { content: 'A ran' }, isError: false };
      }
      return { output: 'B should not run', isError: false };
    });
    const persisted: ChatMessage[] = [];
    const engine = new Engine({
      client,
      gate: allowGate,
      executeTool,
      persistAssistant: (_c, m) => persisted.push(m),
      persistToolResults: (_c, m) => persisted.push(m),
    });
    const { events, emit } = collector();

    const result = await engine.runTurn({ ...baseParams, controller }, emit);

    expect(result.stopReason).toBe('interrupted');
    // A executed; B was never invoked.
    expect(executeTool).toHaveBeenCalledTimes(1);

    const last = persisted.at(-1)!;
    expect(last.role).toBe('user');
    const byId = Object.fromEntries(
      last.blocks
        .filter((b) => b.kind === 'tool_result')
        .map((b) => [(b as { callId: string }).callId, b]),
    );
    // A's real outcome is preserved; B is closed as interrupted.
    expect(byId['a']).toMatchObject({ output: { content: 'A ran' }, isError: false });
    expect(byId['b']).toMatchObject({ output: { error: 'interrupted' }, isError: true });
    expect(events.at(-1)).toMatchObject({ type: 'turn.end', stopReason: 'interrupted' });
  });
});

// ---------------------------------------------------------------------------
// Prompt assembly safety.
// ---------------------------------------------------------------------------

describe('prompt — tool_result serialization & history shaping', () => {
  it('serializes a tool_result block: string passthrough, object JSON-encoded', () => {
    const history: ChatMessage[] = [
      {
        id: 'u1',
        chatId: 'c1',
        role: 'user',
        blocks: [
          { kind: 'tool_result', callId: 'r1', output: 'plain text', isError: false },
          { kind: 'tool_result', callId: 'r2', output: { ok: true, n: 3 }, isError: true },
        ],
        createdAt: '2025-01-01T00:00:00.000Z',
      },
    ];
    const messages = buildMessages({ system: 'sys', userText: 'next', history });
    const blocks = messages[0]!.content as Array<{ type: string; tool_use_id: string; content: string; is_error: boolean }>;
    expect(blocks[0]).toEqual({ type: 'tool_result', tool_use_id: 'r1', content: 'plain text', is_error: false });
    expect(blocks[1]).toEqual({
      type: 'tool_result',
      tool_use_id: 'r2',
      content: JSON.stringify({ ok: true, n: 3 }),
      is_error: true,
    });
  });

  it('drops a turn whose blocks all map to nothing (empty content not sent)', () => {
    // A turn carrying only thinking, produced by a different model, collapses to
    // empty content and must NOT be pushed (the API rejects empty messages).
    const history: ChatMessage[] = [
      {
        id: 'a1',
        chatId: 'c1',
        role: 'assistant',
        model: 'claude-opus-4-7',
        blocks: [{ kind: 'thinking', text: 'dropped', signature: 'sig' }],
        createdAt: '2025-01-01T00:00:00.000Z',
      },
    ];
    const messages = buildMessages({ system: 'sys', userText: 'hi', model: 'claude-opus-4-8', history });
    // Only the new user text remains; the empty assistant turn was dropped.
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user' });
  });

  it('does not append an empty volatile context message', () => {
    const req = buildRequest({ system: 'sys', history: [], userText: 'hi', volatileContext: '' });
    const messages = req.messages as Array<{ role: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
  });
});

describe('prompt — deterministic tool order', () => {
  it('emits tools sorted by name (cache-stable prefix)', () => {
    const names = buildTools().map((t) => (t as { name: string }).name);
    expect(names).toEqual([...names].sort());
    // sanity: the known built-ins are present and alphabetized.
    expect(names[0]).toBe('bash');
    expect(names).toContain('write_file');
  });
});

describe('serializeToolOutput — fallback', () => {
  it('returns strings unchanged', () => {
    expect(serializeToolOutput('hello')).toBe('hello');
  });

  it('falls back to String() when JSON.stringify throws (circular ref)', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const out = serializeToolOutput(circular);
    // Must not throw; produces some string representation.
    expect(typeof out).toBe('string');
    expect(out).toContain('object');
  });
});
