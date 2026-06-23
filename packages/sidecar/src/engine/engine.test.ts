/**
 * Engine tests (Spec 03). The Anthropic client is fully mocked — NO real API
 * call is made. We script streamed turns and assert on emitted EngineEvents,
 * tool gating/execution, history re-attachment, refusal/pause_turn, and
 * AbortController interruption.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  Message,
  MessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages';
import type { EngineEvent } from '@vingsforge/shared';
import { Engine, type EngineDeps, type ToolCall, type ToolOutcome } from './engine.js';
import type { AnthropicLike, MessageStreamLike, StreamRequest } from './client.js';
import { buildRequest } from './prompt.js';

/** A scripted turn: the deltas to stream, then the final Message it resolves to. */
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

function thinkingDelta(text: string): MessageStreamEvent {
  return {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: text },
  } as MessageStreamEvent;
}

/** Build a mock client that yields the scripted turns in order. Records requests. */
function mockClient(turns: ScriptedTurn[]): {
  client: AnthropicLike;
  requests: StreamRequest[];
  aborted: number;
} {
  const requests: StreamRequest[] = [];
  let cursor = 0;
  const state = { aborted: 0 };

  const client: AnthropicLike = {
    messages: {
      stream(body: StreamRequest): MessageStreamLike {
        requests.push(body);
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
          async finalMessage(): Promise<Message> {
            return makeMessage(turn.final);
          },
          abort(): void {
            didAbort = true;
            state.aborted += 1;
          },
        };
        return stream;
      },
    },
  };
  return { client, requests, aborted: state.aborted };
}

const baseParams = {
  chatId: 'chat-1',
  system: 'You are a test agent.',
  history: [],
  userText: 'hello',
};

function collector(): { events: EngineEvent[]; emit: (e: EngineEvent) => void } {
  const events: EngineEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

const allowGate: EngineDeps['gate'] = async () => ({ allow: true });
const noTools: EngineDeps['executeTool'] = async () => ({ output: '', isError: false });

describe('Engine.runTurn — plain text turn', () => {
  it('streams text + thinking deltas and ends the turn', async () => {
    const { client } = mockClient([
      {
        events: [thinkingDelta('hmm'), textDelta('Hi'), textDelta(' there')],
        final: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi there' }] as Message['content'] },
      },
    ]);
    const engine = new Engine({ client, gate: allowGate, executeTool: noTools });
    const { events, emit } = collector();

    const result = await engine.runTurn(baseParams, emit);

    expect(result.stopReason).toBe('end_turn');
    expect(events).toContainEqual({ type: 'thinking.delta', chatId: 'chat-1', text: 'hmm' });
    expect(events).toContainEqual({ type: 'message.delta', chatId: 'chat-1', text: 'Hi' });
    expect(events).toContainEqual({ type: 'message.delta', chatId: 'chat-1', text: ' there' });
    expect(events.at(-1)).toMatchObject({ type: 'turn.end', stopReason: 'end_turn' });
  });
});

describe('Engine.runTurn — tool loop', () => {
  it('runs a tool, batches the result, and re-attaches assistant content', async () => {
    const toolUse = {
      type: 'tool_use',
      id: 'call_1',
      name: 'read_file',
      input: { path: 'a.txt' },
    };
    const { client, requests } = mockClient([
      {
        events: [],
        final: {
          stop_reason: 'tool_use',
          content: [
            { type: 'thinking', thinking: 'plan', signature: 'sig' },
            toolUse,
          ] as Message['content'],
        },
      },
      {
        events: [textDelta('done')],
        final: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] as Message['content'] },
      },
    ]);

    const executeTool = vi.fn<(call: ToolCall, signal: AbortSignal) => Promise<ToolOutcome>>(async () => ({
      output: { content: 'file body' },
      isError: false,
    }));
    const engine = new Engine({ client, gate: allowGate, executeTool });
    const { events, emit } = collector();

    const result = await engine.runTurn(baseParams, emit);

    expect(result.stopReason).toBe('end_turn');
    expect(executeTool).toHaveBeenCalledOnce();
    expect(executeTool.mock.calls[0]?.[0]).toMatchObject({ callId: 'call_1', tool: 'read_file' });

    // tool.start + tool.result emitted.
    expect(events).toContainEqual({
      type: 'tool.start',
      chatId: 'chat-1',
      tool: 'read_file',
      input: { path: 'a.txt' },
      callId: 'call_1',
    });
    expect(events).toContainEqual({
      type: 'tool.result',
      chatId: 'chat-1',
      callId: 'call_1',
      output: { content: 'file body' },
      isError: false,
    });

    // Second request must include the assistant turn (with thinking + tool_use)
    // and ONE user message carrying the tool_result.
    const secondMessages = (requests[1]?.messages ?? []) as Array<{ role: string; content: unknown[] }>;
    const assistant = secondMessages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toEqual([
      { type: 'thinking', thinking: 'plan', signature: 'sig' },
      { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } },
    ]);
    const toolResultMsgs = secondMessages.filter((m) =>
      (m.content as Array<{ type?: string }>).some((c) => c.type === 'tool_result'),
    );
    expect(toolResultMsgs).toHaveLength(1);
    expect(toolResultMsgs[0]?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: JSON.stringify({ content: 'file body' }),
        is_error: false,
      },
    ]);
  });

  it('persists the assistant tool_use turn immediately followed by the user tool_result turn', async () => {
    const toolUse = { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.txt' } };
    const { client } = mockClient([
      { events: [], final: { stop_reason: 'tool_use', content: [toolUse] as Message['content'] } },
      { events: [textDelta('done')], final: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] as Message['content'] } },
    ]);
    const executeTool = vi.fn<(call: ToolCall, signal: AbortSignal) => Promise<ToolOutcome>>(async () => ({
      output: { content: 'file body' },
      isError: false,
    }));
    const persisted: import('@vingsforge/shared').ChatMessage[] = [];
    const persistAssistant = vi.fn((_chatId: string, m: import('@vingsforge/shared').ChatMessage) => {
      persisted.push(m);
    });
    const persistToolResults = vi.fn((_chatId: string, m: import('@vingsforge/shared').ChatMessage) => {
      persisted.push(m);
    });
    const engine = new Engine({ client, gate: allowGate, executeTool, persistAssistant, persistToolResults });
    const { emit } = collector();

    await engine.runTurn(baseParams, emit);

    // Each tool_use turn must be paired with a persisted tool_result turn.
    expect(persistAssistant).toHaveBeenCalled();
    expect(persistToolResults).toHaveBeenCalledOnce();

    // The persisted sequence must be API-valid: an assistant turn whose blocks
    // include a tool_use, immediately followed by a user turn whose blocks
    // carry the matching tool_result.
    const assistantIdx = persisted.findIndex(
      (m) => m.role === 'assistant' && m.blocks.some((b) => b.kind === 'tool_use' && b.callId === 'call_1'),
    );
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    const next = persisted[assistantIdx + 1];
    expect(next?.role).toBe('user');
    expect(next?.blocks).toEqual([
      { kind: 'tool_result', callId: 'call_1', output: { content: 'file body' }, isError: false },
    ]);
  });

  it('denied tool yields an is_error result without executing', async () => {
    const toolUse = { type: 'tool_use', id: 'call_x', name: 'bash', input: { command: 'rm -rf /' } };
    const { client } = mockClient([
      { events: [], final: { stop_reason: 'tool_use', content: [toolUse] as Message['content'] } },
      { events: [textDelta('ok')], final: { stop_reason: 'end_turn', content: [] } },
    ]);
    const executeTool = vi.fn<(call: ToolCall, signal: AbortSignal) => Promise<ToolOutcome>>();
    const engine = new Engine({
      client,
      gate: async () => ({ allow: false, reason: "policy denied 'bash'" }),
      executeTool,
    });
    const { events, emit } = collector();

    await engine.runTurn(baseParams, emit);

    expect(executeTool).not.toHaveBeenCalled();
    const result = events.find((e) => e.type === 'tool.result');
    expect(result).toMatchObject({ isError: true });
    expect((result as Extract<EngineEvent, { type: 'tool.result' }>).output).toMatchObject({
      denied: true,
    });
  });
});

describe('Engine.runTurn — stop reasons', () => {
  it('handles refusal before reading content', async () => {
    const { client } = mockClient([
      { events: [], final: { stop_reason: 'refusal', content: [] } },
    ]);
    const engine = new Engine({ client, gate: allowGate, executeTool: noTools });
    const { events, emit } = collector();

    const result = await engine.runTurn(baseParams, emit);

    expect(result.stopReason).toBe('refusal');
    expect(events.at(-1)).toMatchObject({ type: 'turn.end', stopReason: 'refusal' });
  });

  it('resends on pause_turn without injecting a "Continue." message', async () => {
    const { client, requests } = mockClient([
      { events: [], final: { stop_reason: 'pause_turn', content: [] } },
      { events: [textDelta('resumed')], final: { stop_reason: 'end_turn', content: [] } },
    ]);
    const engine = new Engine({ client, gate: allowGate, executeTool: noTools });
    const { emit } = collector();

    const result = await engine.runTurn(baseParams, emit);

    expect(result.stopReason).toBe('end_turn');
    expect(requests).toHaveLength(2);
    // No synthetic user "Continue." text in the resent prompt.
    const secondMessages = (requests[1]?.messages ?? []) as Array<{ content: Array<{ text?: string }> }>;
    const texts = secondMessages.flatMap((m) => m.content.map((c) => c.text));
    expect(texts).not.toContain('Continue.');
  });

  it('accumulates usage across iterations', async () => {
    const toolUse = { type: 'tool_use', id: 'c1', name: 'glob', input: {} };
    const { client } = mockClient([
      { events: [], final: { stop_reason: 'tool_use', content: [toolUse] as Message['content'] } },
      { events: [], final: { stop_reason: 'end_turn', content: [] } },
    ]);
    const engine = new Engine({ client, gate: allowGate, executeTool: noTools });
    const { emit } = collector();

    const result = await engine.runTurn(baseParams, emit);
    // Two turns, each 10 in / 5 out.
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
  });
});

describe('Engine.runTurn — interruption', () => {
  it('aborts the stream and emits turn.end interrupted', async () => {
    const controller = new AbortController();
    const { client } = mockClient([
      { events: [textDelta('partial')], final: { stop_reason: 'end_turn', content: [] } },
    ]);
    // Abort before the turn starts.
    controller.abort();
    const engine = new Engine({ client, gate: allowGate, executeTool: noTools });
    const { events, emit } = collector();

    const result = await engine.runTurn({ ...baseParams, controller }, emit);

    expect(result.stopReason).toBe('interrupted');
    expect(events.at(-1)).toMatchObject({ type: 'turn.end', stopReason: 'interrupted' });
  });

  it('interrupts between tool calls', async () => {
    const controller = new AbortController();
    const toolUse = { type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'sleep 1' } };
    const { client } = mockClient([
      { events: [], final: { stop_reason: 'tool_use', content: [toolUse] as Message['content'] } },
    ]);
    const gate: EngineDeps['gate'] = async () => {
      controller.abort(); // user interrupts while awaiting approval
      return { allow: true };
    };
    const executeTool = vi.fn<(call: ToolCall, signal: AbortSignal) => Promise<ToolOutcome>>(async () => ({
      output: 'should not run',
      isError: false,
    }));
    const engine = new Engine({ client, gate, executeTool });
    const { events, emit } = collector();

    const result = await engine.runTurn({ ...baseParams, controller }, emit);

    expect(result.stopReason).toBe('interrupted');
    expect(events.at(-1)).toMatchObject({ type: 'turn.end', stopReason: 'interrupted' });
  });

  it('persists a tool_result turn closing every tool_use when interrupted mid-loop', async () => {
    const controller = new AbortController();
    // Two tool_use blocks: interrupt fires during the first gate, so neither
    // runs and BOTH must be closed with a synthesized is_error result.
    const toolUseA = { type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'sleep 1' } };
    const toolUseB = { type: 'tool_use', id: 'c2', name: 'read_file', input: { path: 'a.txt' } };
    const { client } = mockClient([
      {
        events: [],
        final: { stop_reason: 'tool_use', content: [toolUseA, toolUseB] as Message['content'] },
      },
    ]);
    const gate: EngineDeps['gate'] = async () => {
      controller.abort(); // user interrupts while awaiting approval of the first call
      return { allow: true };
    };
    const executeTool = vi.fn<(call: ToolCall, signal: AbortSignal) => Promise<ToolOutcome>>(
      async () => ({ output: 'should not run', isError: false }),
    );
    const persisted: import('@vingsforge/shared').ChatMessage[] = [];
    const persistAssistant = vi.fn((_chatId: string, m: import('@vingsforge/shared').ChatMessage) => {
      persisted.push(m);
    });
    const persistToolResults = vi.fn((_chatId: string, m: import('@vingsforge/shared').ChatMessage) => {
      persisted.push(m);
    });
    const engine = new Engine({ client, gate, executeTool, persistAssistant, persistToolResults });
    const { events, emit } = collector();

    const result = await engine.runTurn({ ...baseParams, controller }, emit);

    expect(result.stopReason).toBe('interrupted');
    expect(executeTool).not.toHaveBeenCalled();
    expect(persistToolResults).toHaveBeenCalledOnce();

    // The final persisted turn is the user tool_result turn, and it closes every
    // tool_use id from the assistant message — keeping the thread continuable.
    const lastTurn = persisted.at(-1)!;
    expect(lastTurn.role).toBe('user');
    const closedIds = lastTurn.blocks
      .filter((b) => b.kind === 'tool_result')
      .map((b) => (b as { callId: string }).callId);
    expect(closedIds).toEqual(['c1', 'c2']);
    for (const b of lastTurn.blocks) {
      expect(b).toMatchObject({ kind: 'tool_result', isError: true, output: { error: 'interrupted' } });
    }
    expect(events.at(-1)).toMatchObject({ type: 'turn.end', stopReason: 'interrupted' });
  });
});

describe('buildRequest — prompt assembly', () => {
  it('renders tools, frozen cached system, and adaptive thinking', () => {
    const req = buildRequest({ system: 'sys', history: [], userText: 'hi' });
    expect(req.model).toBe('claude-opus-4-8');
    expect(req.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(req.output_config).toEqual({ effort: 'high' });
    const system = req.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(Array.isArray(req.tools)).toBe(true);
  });

  it('appends volatile context as a trailing role:system message', () => {
    const req = buildRequest({
      system: 'sys',
      history: [],
      userText: 'hi',
      volatileContext: 'Today is 2026-06-22.',
    });
    const messages = req.messages as Array<{ role: string; content: Array<{ text: string }> }>;
    expect(messages.at(-1)?.role).toBe('system');
    expect(messages.at(-1)?.content[0]?.text).toBe('Today is 2026-06-22.');
  });
});
