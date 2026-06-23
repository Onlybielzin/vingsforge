/**
 * Pure stream-json → EngineEvent MAPPER tests.
 *
 * These exercise the parser in isolation: no `claude` binary is spawned, no
 * child process, no readline, no network. We feed example NDJSON lines (the
 * exact shapes the CLI emits — system/init, assistant with text/thinking/
 * tool_use, user with tool_result, result) straight into the pure
 * `mapStreamLines(lines, ctx)` function and assert the emitted EngineEvents, the
 * persisted assistant/tool-result turns, the captured session id, and the
 * aggregated TurnResult/Usage (stopReason + token counts).
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage, EngineEvent } from '@vingsforge/shared';
import { mapStreamLines, type HandleCtx } from './claude-cli-runner.js';

interface Sink {
  ctx: HandleCtx;
  events: EngineEvent[];
  persistedAssistant: ChatMessage[];
  persistedToolResults: ChatMessage[];
  sessions: string[];
  metas: { slashCommands: string[]; skills: string[] }[];
}

/** Build a HandleCtx that records everything the mapper does. */
function makeSink(chatId = 'chat-1'): Sink {
  const events: EngineEvent[] = [];
  const persistedAssistant: ChatMessage[] = [];
  const persistedToolResults: ChatMessage[] = [];
  const sessions: string[] = [];
  const metas: { slashCommands: string[]; skills: string[] }[] = [];
  const ctx: HandleCtx = {
    chatId,
    emit: (e) => events.push(e),
    model: 'claude-opus-4-8',
    persistAssistant: (_id, m) => persistedAssistant.push(m),
    persistToolResults: (_id, m) => persistedToolResults.push(m),
    onSession: (sid) => sessions.push(sid),
    onMeta: (m) => metas.push(m),
  };
  return { ctx, events, persistedAssistant, persistedToolResults, sessions, metas };
}

/** Serialize objects to NDJSON lines, the way the CLI writes them to stdout. */
function ndjson(...objs: object[]): string[] {
  return objs.map((o) => JSON.stringify(o));
}

describe('mapStreamLines (pure stream-json → EngineEvent mapper)', () => {
  it('maps a full system/init → assistant(text) → result stream', () => {
    const s = makeSink();
    const lines = ndjson(
      { type: 'system', subtype: 'init', session_id: 'sess-abc', apiKeySource: 'none' },
      {
        type: 'assistant',
        message: {
          id: 'msg-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi there' }],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 7,
        },
      },
    );

    const out = mapStreamLines(lines, s.ctx);

    // EngineEvents, in order: the text delta then the terminal turn.end.
    expect(s.events).toEqual([
      { type: 'message.delta', chatId: 'chat-1', text: 'Hi there' },
      {
        type: 'turn.end',
        chatId: 'chat-1',
        stopReason: 'end_turn',
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 7,
        },
      },
    ]);

    // session id captured (for --resume) via onSession AND in the aggregate.
    expect(s.sessions).toEqual(['sess-abc']);
    expect(out.sessionId).toBe('sess-abc');

    // aggregated TurnResult / Usage.
    expect(out.sawResult).toBe(true);
    expect(out.stopReason).toBe('end_turn');
    expect(out.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 7,
    });

    // persisted assistant turn (one block, text).
    expect(s.persistedAssistant).toHaveLength(1);
    expect(s.persistedAssistant[0]?.id).toBe('msg-1');
    expect(s.persistedAssistant[0]?.role).toBe('assistant');
    expect(s.persistedAssistant[0]?.model).toBe('claude-opus-4-8');
    expect(s.persistedAssistant[0]?.blocks).toEqual([{ kind: 'text', text: 'Hi there' }]);
    expect(s.persistedToolResults).toHaveLength(0);
  });

  it('maps thinking + tool_use (assistant) and tool_result (user) into paired turns', () => {
    const s = makeSink();
    const lines = ndjson(
      { type: 'system', subtype: 'init', session_id: 's1' },
      {
        type: 'assistant',
        message: {
          id: 'm1',
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'pondering', signature: 'sig-xyz' },
            { type: 'tool_use', id: 'tu-1', name: 'read_file', input: { path: 'a.txt' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'file body', is_error: false },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        stop_reason: 'tool_use',
        usage: { input_tokens: 12, output_tokens: 3 },
      },
    );

    const out = mapStreamLines(lines, s.ctx);

    expect(s.events).toEqual([
      { type: 'thinking.delta', chatId: 'chat-1', text: 'pondering' },
      {
        type: 'tool.start',
        chatId: 'chat-1',
        tool: 'read_file',
        input: { path: 'a.txt' },
        callId: 'tu-1',
      },
      { type: 'tool.result', chatId: 'chat-1', callId: 'tu-1', output: 'file body', isError: false },
      {
        type: 'turn.end',
        chatId: 'chat-1',
        stopReason: 'tool_use',
        usage: { inputTokens: 12, outputTokens: 3 },
      },
    ]);

    // assistant turn: thinking (with signature) + tool_use blocks.
    expect(s.persistedAssistant).toHaveLength(1);
    expect(s.persistedAssistant[0]?.blocks).toEqual([
      { kind: 'thinking', text: 'pondering', signature: 'sig-xyz' },
      { kind: 'tool_use', callId: 'tu-1', tool: 'read_file', input: { path: 'a.txt' } },
    ]);

    // user turn: the batched tool_result block.
    expect(s.persistedToolResults).toHaveLength(1);
    expect(s.persistedToolResults[0]?.role).toBe('user');
    expect(s.persistedToolResults[0]?.blocks).toEqual([
      { kind: 'tool_result', callId: 'tu-1', output: 'file body', isError: false },
    ]);

    expect(out.stopReason).toBe('tool_use');
    expect(out.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(out.sawResult).toBe(true);
  });

  it('marks an errored tool_result with isError true', () => {
    const s = makeSink();
    const lines = ndjson(
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu-9', content: 'bad path', is_error: true },
          ],
        },
      },
      { type: 'result', subtype: 'success', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
    );

    mapStreamLines(lines, s.ctx);

    expect(s.events).toContainEqual({
      type: 'tool.result',
      chatId: 'chat-1',
      callId: 'tu-9',
      output: 'bad path',
      isError: true,
    });
    expect(s.persistedToolResults[0]?.blocks).toEqual([
      { kind: 'tool_result', callId: 'tu-9', output: 'bad path', isError: true },
    ]);
  });

  it('maps a failed result (is_error) to an error event + end_turn and surfaces the message', () => {
    const s = makeSink();
    const lines = ndjson({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'boom',
      usage: { input_tokens: 0, output_tokens: 0 },
    });

    const out = mapStreamLines(lines, s.ctx);

    expect(s.events).toEqual([
      { type: 'error', chatId: 'chat-1', message: 'boom' },
      {
        type: 'turn.end',
        chatId: 'chat-1',
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    ]);
    expect(out.error).toBe('boom');
    expect(out.stopReason).toBe('end_turn');
    expect(out.sawResult).toBe(true);
  });

  it('ignores blank lines, non-JSON banners, and unknown event types', () => {
    const s = makeSink();
    const lines = [
      '',
      '   ',
      'not json at all',
      JSON.stringify({ type: 'rate_limit_event', foo: 'bar' }),
      JSON.stringify({ type: 'system', subtype: 'hook_started' }),
      JSON.stringify({ type: 'totally_unknown', whatever: 1 }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        stop_reason: 'end_turn',
        usage: { input_tokens: 2, output_tokens: 2 },
      }),
    ];

    const out = mapStreamLines(lines, s.ctx);

    // Only the result produced an event (turn.end). Nothing else leaked.
    expect(s.events).toEqual([
      {
        type: 'turn.end',
        chatId: 'chat-1',
        stopReason: 'end_turn',
        usage: { inputTokens: 2, outputTokens: 2 },
      },
    ]);
    expect(s.persistedAssistant).toHaveLength(0);
    expect(s.persistedToolResults).toHaveLength(0);
    expect(s.sessions).toHaveLength(0);
    expect(out.sawResult).toBe(true);
  });

  it('defaults usage to zeros and stopReason to end_turn when result omits them', () => {
    const s = makeSink();
    const out = mapStreamLines(ndjson({ type: 'result', subtype: 'success' }), s.ctx);

    expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(out.stopReason).toBe('end_turn');
    expect(s.events).toEqual([
      {
        type: 'turn.end',
        chatId: 'chat-1',
        stopReason: 'end_turn',
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    ]);
  });

  it('reports sawResult=false and zero usage for a stream that never ends', () => {
    const s = makeSink();
    const out = mapStreamLines(
      ndjson({
        type: 'assistant',
        message: { id: 'm', content: [{ type: 'text', text: 'partial' }] },
      }),
      s.ctx,
    );

    expect(out.sawResult).toBe(false);
    expect(out.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(out.stopReason).toBe('end_turn');
    expect(s.events).toEqual([{ type: 'message.delta', chatId: 'chat-1', text: 'partial' }]);
  });

  it('captures slash_commands / skills from system/init via onMeta + aggregate', () => {
    const s = makeSink();
    const out = mapStreamLines(
      ndjson({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-meta',
        slash_commands: ['code-review', 'init', 'compact', 42, ''],
        skills: ['createmd', 'vault'],
        agents: ['ignored'],
      }),
      s.ctx,
    );

    // Non-strings / empties are dropped; both onMeta and the aggregate get it.
    const expected = {
      slashCommands: ['code-review', 'init', 'compact'],
      skills: ['createmd', 'vault'],
    };
    expect(s.metas).toEqual([expected]);
    expect(out.meta).toEqual(expected);
    expect(out.sessionId).toBe('sess-meta');
  });

  it('does not emit meta for an init event without slash_commands/skills', () => {
    const s = makeSink();
    mapStreamLines(
      ndjson({ type: 'system', subtype: 'init', session_id: 'sess-x' }),
      s.ctx,
    );
    expect(s.metas).toEqual([]);
  });
});
