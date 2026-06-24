/**
 * Tests for the pure subagents extractor used by the "Agentes" right-panel tab.
 * Pure module (no DOM) so it runs in the node test environment.
 */
import { describe, expect, it } from 'vitest';
import { emptyConversation, type ConversationState, type Turn } from '../state/conversation.js';
import {
  countRunning,
  extractSubagents,
  isAgentRunning,
  truncateTask,
} from './agentsPanel.js';

function conv(turns: Turn[]): ConversationState {
  return { ...emptyConversation('c1'), turns };
}

describe('extractSubagents', () => {
  it('returns [] for an empty conversation', () => {
    expect(extractSubagents(emptyConversation())).toEqual([]);
  });

  it('picks only subagent (Agent/Task) tool cards, in stream order', () => {
    const state = conv([
      {
        id: 't1',
        role: 'assistant',
        items: [
          { kind: 'text', text: 'hi' },
          { kind: 'tool', card: { callId: 'a', tool: 'Bash', input: {}, state: 'ok' } },
          {
            kind: 'tool',
            card: { callId: 'b', tool: 'Task', input: { description: 'do thing' }, state: 'running' },
          },
        ],
      },
      {
        id: 't2',
        role: 'assistant',
        items: [
          {
            kind: 'tool',
            card: {
              callId: 'c',
              tool: 'agent',
              input: { prompt: 'second' },
              state: 'ok',
              output: 'result text\n<usage>subagent_tokens: 120, tool_uses: 3, duration_ms: 5440</usage>',
            },
          },
        ],
      },
    ]);

    const out = extractSubagents(state);
    expect(out.map((a) => a.callId)).toEqual(['b', 'c']);
    expect(out[0]!.task).toBe('do thing');
    expect(out[0]!.state).toBe('running');
    expect(out[0]!.usage).toBeNull();
    expect(out[1]!.task).toBe('second');
    expect(out[1]!.usage).toEqual({ tokens: 120, tools: 3, durationMs: 5440 });
    expect(out[1]!.outputText).toContain('result text');
  });

  it('falls back across input keys for the task label', () => {
    const state = conv([
      {
        id: 't',
        role: 'assistant',
        items: [
          { kind: 'tool', card: { callId: '1', tool: 'Task', input: { subagent_type: 'reviewer' }, state: 'pending' } },
        ],
      },
    ]);
    expect(extractSubagents(state)[0]!.task).toBe('reviewer');
  });
});

describe('isAgentRunning / countRunning', () => {
  it('treats pending and running as in-flight', () => {
    expect(isAgentRunning({ callId: '1', task: '', state: 'running', outputText: '', usage: null })).toBe(true);
    expect(isAgentRunning({ callId: '2', task: '', state: 'pending', outputText: '', usage: null })).toBe(true);
    expect(isAgentRunning({ callId: '3', task: '', state: 'ok', outputText: '', usage: null })).toBe(false);
  });

  it('counts only running/pending agents', () => {
    const agents = [
      { callId: '1', task: '', state: 'running' as const, outputText: '', usage: null },
      { callId: '2', task: '', state: 'ok' as const, outputText: '', usage: null },
      { callId: '3', task: '', state: 'pending' as const, outputText: '', usage: null },
    ];
    expect(countRunning(agents)).toBe(2);
  });
});

describe('truncateTask', () => {
  it('collapses whitespace and truncates with an ellipsis', () => {
    expect(truncateTask('a   b\n c')).toBe('a b c');
    expect(truncateTask('x'.repeat(200)).endsWith('…')).toBe(true);
    expect(truncateTask('x'.repeat(200)).length).toBe(96);
  });
});
