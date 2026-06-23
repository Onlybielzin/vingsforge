/**
 * Tests for the conversation view-model + reducer (Spec 06 §4).
 *
 * Covers:
 *  - happy path: folding a full streaming turn (thinking -> text -> tool ->
 *    permission -> result -> turn.end) into renderable turns/cards;
 *  - replay / hydration of persisted history into the same shape;
 *  - chatId confinement: events addressed to a different chat are ignored
 *    (no cross-chat bleed of deltas / tool results / errors);
 *  - usage accumulation and cost folding;
 *  - edge cases: late/duplicate tool.start, results with no matching card,
 *    permission clearing on result, immutability of the input state.
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage, EngineEvent } from '@vingsforge/shared';
import {
  appendUserMessage,
  emptyConversation,
  hydrateHistory,
  reduceEvent,
  type ConversationState,
  type ToolCard,
} from './conversation.js';

const CHAT = 'c-1';

/** Folds a list of events left-to-right, like the real subscription would. */
function fold(start: ConversationState, events: EngineEvent[]): ConversationState {
  return events.reduce(reduceEvent, start);
}

/** Flattens all tool cards across all turns. */
function cards(state: ConversationState): ToolCard[] {
  return state.turns.flatMap((t) => t.items.filter((i) => i.kind === 'tool').map((i) => (i as { card: ToolCard }).card));
}

describe('emptyConversation', () => {
  it('starts with zeroed usage and no turns/permission/error', () => {
    const s = emptyConversation(CHAT);
    expect(s.chatId).toBe(CHAT);
    expect(s.turns).toEqual([]);
    expect(s.streaming).toBe(false);
    expect(s.pendingPermission).toBeNull();
    expect(s.error).toBeNull();
    expect(s.sessionUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('reduceEvent — happy path streaming turn', () => {
  it('folds thinking/text/tool/permission/result/turn.end into one assistant turn', () => {
    const events: EngineEvent[] = [
      { type: 'thinking.delta', chatId: CHAT, text: 'Plan. ' },
      { type: 'thinking.delta', chatId: CHAT, text: 'More plan.' },
      { type: 'message.delta', chatId: CHAT, text: 'Let me ' },
      { type: 'message.delta', chatId: CHAT, text: 'look.' },
      { type: 'tool.start', chatId: CHAT, tool: 'bash', input: { command: 'ls' }, callId: 'k1' },
      { type: 'tool.permission', chatId: CHAT, callId: 'k1', tool: 'bash', input: { command: 'ls' } },
      { type: 'tool.result', chatId: CHAT, callId: 'k1', output: 'README.md', isError: false },
      { type: 'message.delta', chatId: CHAT, text: 'Done.' },
      {
        type: 'turn.end',
        chatId: CHAT,
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.01 },
      },
    ];
    const s = fold(emptyConversation(CHAT), events);

    expect(s.turns).toHaveLength(1);
    const turn = s.turns[0]!;
    expect(turn.role).toBe('assistant');
    expect(turn.streaming).toBe(false);

    // Adjacent deltas of the same kind are coalesced.
    const thinking = turn.items.filter((i) => i.kind === 'thinking');
    expect(thinking).toHaveLength(1);
    expect((thinking[0] as { text: string }).text).toBe('Plan. More plan.');

    // The tool card resolved to ok with output; permission cleared.
    const [card] = cards(s);
    expect(card?.state).toBe('ok');
    expect(card?.output).toBe('README.md');
    expect(card?.isError).toBe(false);
    expect(s.pendingPermission).toBeNull();
    expect(s.streaming).toBe(false);
    expect(s.sessionUsage).toEqual({ inputTokens: 100, outputTokens: 20, estimatedCostUsd: 0.01 });
  });

  it('message.delta before any tool creates a streaming assistant turn', () => {
    const s = reduceEvent(emptyConversation(CHAT), { type: 'message.delta', chatId: CHAT, text: 'hi' });
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]!.role).toBe('assistant');
    expect(s.turns[0]!.streaming).toBe(true);
    expect(s.streaming).toBe(true);
  });

  it('tool.start without a prior card adds a running card', () => {
    const s = reduceEvent(emptyConversation(CHAT), {
      type: 'tool.start',
      chatId: CHAT,
      tool: 'read_file',
      input: { path: 'a.ts' },
      callId: 'r1',
    });
    expect(cards(s)).toHaveLength(1);
    expect(cards(s)[0]!.state).toBe('running');
  });

  it('a second tool.start for the same callId flips the existing card to running (idempotent)', () => {
    const s = fold(emptyConversation(CHAT), [
      { type: 'tool.start', chatId: CHAT, tool: 'bash', input: {}, callId: 'k1' },
      { type: 'tool.permission', chatId: CHAT, callId: 'k1', tool: 'bash', input: {} },
      { type: 'tool.start', chatId: CHAT, tool: 'bash', input: {}, callId: 'k1' },
    ]);
    // Still a single card, now running again (not duplicated).
    expect(cards(s)).toHaveLength(1);
    expect(cards(s)[0]!.state).toBe('running');
  });
});

describe('reduceEvent — permission gate', () => {
  it('sets pendingPermission and marks the card awaiting-permission', () => {
    const s = fold(emptyConversation(CHAT), [
      { type: 'tool.start', chatId: CHAT, tool: 'bash', input: { command: 'rm -rf' }, callId: 'k1' },
      { type: 'tool.permission', chatId: CHAT, callId: 'k1', tool: 'bash', input: { command: 'rm -rf' } },
    ]);
    expect(s.pendingPermission).toEqual({ callId: 'k1', tool: 'bash', input: { command: 'rm -rf' } });
    expect(cards(s)[0]!.state).toBe('awaiting-permission');
  });

  it('clears the matching pendingPermission when its result arrives, error->error state', () => {
    const s = fold(emptyConversation(CHAT), [
      { type: 'tool.start', chatId: CHAT, tool: 'bash', input: {}, callId: 'k1' },
      { type: 'tool.permission', chatId: CHAT, callId: 'k1', tool: 'bash', input: {} },
      { type: 'tool.result', chatId: CHAT, callId: 'k1', output: 'Denied by user.', isError: true },
    ]);
    expect(s.pendingPermission).toBeNull();
    expect(cards(s)[0]!.state).toBe('error');
    expect(cards(s)[0]!.isError).toBe(true);
  });

  it('does NOT clear a pendingPermission when a DIFFERENT call resolves', () => {
    const s = fold(emptyConversation(CHAT), [
      { type: 'tool.start', chatId: CHAT, tool: 'bash', input: {}, callId: 'k1' },
      { type: 'tool.start', chatId: CHAT, tool: 'read_file', input: {}, callId: 'k2' },
      { type: 'tool.permission', chatId: CHAT, callId: 'k1', tool: 'bash', input: {} },
      { type: 'tool.result', chatId: CHAT, callId: 'k2', output: 'ok', isError: false },
    ]);
    // k1 is still gating the flow; k2's result must not unblock it.
    expect(s.pendingPermission?.callId).toBe('k1');
  });
});

describe('reduceEvent — chatId confinement (Spec 06 §6 / security)', () => {
  it('ignores events addressed to a different chat', () => {
    const base = emptyConversation(CHAT);
    const other: EngineEvent = { type: 'message.delta', chatId: 'c-OTHER', text: 'leak' };
    const s = reduceEvent(base, other);
    // Unchanged AND same reference (early return, no clone).
    expect(s).toBe(base);
    expect(s.turns).toHaveLength(0);
  });

  it('does not leak tool results from another chat into this conversation', () => {
    const s = fold(emptyConversation(CHAT), [
      { type: 'tool.start', chatId: CHAT, tool: 'bash', input: {}, callId: 'k1' },
      // A result for the SAME callId but a different chat must be ignored.
      { type: 'tool.result', chatId: 'c-OTHER', callId: 'k1', output: 'pwned', isError: false },
    ]);
    expect(cards(s)[0]!.state).toBe('running');
    expect(cards(s)[0]!.output).toBeUndefined();
  });

  it('does not surface errors from another chat', () => {
    const s = reduceEvent(emptyConversation(CHAT), { type: 'error', chatId: 'c-OTHER', message: 'boom' });
    expect(s.error).toBeNull();
  });

  it('a null-chat conversation accepts events from any chat (pre-selection state)', () => {
    const s = reduceEvent(emptyConversation(null), { type: 'message.delta', chatId: 'whatever', text: 'x' });
    expect(s.turns).toHaveLength(1);
  });
});

describe('reduceEvent — errors and interrupts', () => {
  it('records error message and stops streaming', () => {
    const s = fold(emptyConversation(CHAT), [
      { type: 'message.delta', chatId: CHAT, text: 'partial' },
      { type: 'error', chatId: CHAT, message: 'API key invalid' },
    ]);
    expect(s.error).toBe('API key invalid');
    expect(s.streaming).toBe(false);
  });

  it('turn.end after interrupt stops streaming and folds (zero) usage', () => {
    const s = fold(emptyConversation(CHAT), [
      { type: 'message.delta', chatId: CHAT, text: 'partial' },
      { type: 'turn.end', chatId: CHAT, stopReason: 'interrupted', usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    expect(s.streaming).toBe(false);
    expect(s.turns[0]!.streaming).toBe(false);
    expect(s.sessionUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('reduceEvent — usage accumulation across turns', () => {
  it('sums tokens and cost over multiple turns', () => {
    const s = fold(emptyConversation(CHAT), [
      { type: 'message.delta', chatId: CHAT, text: 'a' },
      { type: 'turn.end', chatId: CHAT, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, estimatedCostUsd: 0.001 } },
      { type: 'message.delta', chatId: CHAT, text: 'b' },
      { type: 'turn.end', chatId: CHAT, stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 7, estimatedCostUsd: 0.002 } },
    ]);
    expect(s.sessionUsage.inputTokens).toBe(30);
    expect(s.sessionUsage.outputTokens).toBe(12);
    expect(s.sessionUsage.estimatedCostUsd).toBeCloseTo(0.003, 6);
  });

  it('omits estimatedCostUsd when no turn reported a cost', () => {
    const s = fold(emptyConversation(CHAT), [
      { type: 'message.delta', chatId: CHAT, text: 'a' },
      { type: 'turn.end', chatId: CHAT, stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
    expect('estimatedCostUsd' in s.sessionUsage).toBe(false);
  });
});

describe('reduceEvent — immutability', () => {
  it('does not mutate the previous state object', () => {
    const prev = emptyConversation(CHAT);
    const snapshot = JSON.parse(JSON.stringify(prev));
    const next = reduceEvent(prev, { type: 'message.delta', chatId: CHAT, text: 'hi' });
    expect(prev).toEqual(snapshot); // untouched
    expect(next).not.toBe(prev);
    expect(next.turns).not.toBe(prev.turns);
  });

  it('does not mutate cards of the previous state when resolving a result', () => {
    const withCard = reduceEvent(emptyConversation(CHAT), {
      type: 'tool.start',
      chatId: CHAT,
      tool: 'bash',
      input: {},
      callId: 'k1',
    });
    const before = cards(withCard)[0]!.state;
    const after = reduceEvent(withCard, { type: 'tool.result', chatId: CHAT, callId: 'k1', output: 'x', isError: false });
    expect(before).toBe('running'); // original card unchanged
    expect(cards(withCard)[0]!.state).toBe('running');
    expect(cards(after)[0]!.state).toBe('ok');
  });
});

describe('appendUserMessage', () => {
  it('optimistically appends a user turn and marks streaming, clearing prior error', () => {
    const prev = { ...emptyConversation(CHAT), error: 'old error' };
    const s = appendUserMessage(prev, 'hello');
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]!.role).toBe('user');
    expect((s.turns[0]!.items[0] as { text: string }).text).toBe('hello');
    expect(s.streaming).toBe(true);
    expect(s.error).toBeNull();
    expect(prev.turns).toHaveLength(0); // immutable
  });
});

describe('hydrateHistory — replay of persisted blocks (Spec 02 §3 / Spec 08 §4)', () => {
  const history: ChatMessage[] = [
    {
      id: 'm-1',
      chatId: CHAT,
      role: 'user',
      blocks: [{ kind: 'text', text: 'Read the file.' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'm-2',
      chatId: CHAT,
      role: 'assistant',
      model: 'claude-opus-4-8',
      blocks: [
        { kind: 'thinking', text: 'mixes concerns', signature: 'sig-abc' },
        { kind: 'text', text: 'Reading.' },
        { kind: 'tool_use', callId: 't-1', tool: 'read_file', input: { path: 'a.ts' } },
        { kind: 'tool_result', callId: 't-1', isError: false, output: 'contents' },
        { kind: 'text', text: 'Suggest extracting.' },
      ],
      usage: { inputTokens: 1820, outputTokens: 410, estimatedCostUsd: 0.014 },
      createdAt: '2026-01-01T00:00:01.000Z',
    },
  ];

  it('builds turns preserving order and merges tool_result into its tool_use card', () => {
    const s = hydrateHistory(CHAT, history);
    expect(s.chatId).toBe(CHAT);
    expect(s.turns).toHaveLength(2);
    expect(s.turns[0]!.role).toBe('user');

    const asst = s.turns[1]!;
    // thinking, text, tool, text — tool_result is folded into the card, not a separate item.
    expect(asst.items.map((i) => i.kind)).toEqual(['thinking', 'text', 'tool', 'text']);
    const card = (asst.items[2] as { card: ToolCard }).card;
    expect(card.state).toBe('ok');
    expect(card.output).toBe('contents');
    expect(card.isError).toBe(false);
    expect(asst.usage).toEqual({ inputTokens: 1820, outputTokens: 410, estimatedCostUsd: 0.014 });
  });

  it('accumulates sessionUsage from persisted assistant turns', () => {
    const s = hydrateHistory(CHAT, history);
    expect(s.sessionUsage).toEqual({ inputTokens: 1820, outputTokens: 410, estimatedCostUsd: 0.014 });
  });

  it('marks a tool_result with isError as an error card', () => {
    const s = hydrateHistory(CHAT, [
      {
        id: 'm',
        chatId: CHAT,
        role: 'assistant',
        blocks: [
          { kind: 'tool_use', callId: 't', tool: 'bash', input: {} },
          { kind: 'tool_result', callId: 't', isError: true, output: 'denied' },
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const card = cards(s)[0]!;
    expect(card.state).toBe('error');
    expect(card.isError).toBe(true);
  });

  it('tolerates an orphan tool_result with no matching tool_use', () => {
    const s = hydrateHistory(CHAT, [
      {
        id: 'm',
        chatId: CHAT,
        role: 'assistant',
        blocks: [{ kind: 'tool_result', callId: 'nope', isError: false, output: 'x' }],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    expect(cards(s)).toHaveLength(0);
    expect(s.turns).toHaveLength(1);
  });

  it('hydrated history then live events fold together (replay continuity)', () => {
    const hydrated = hydrateHistory(CHAT, history);
    const s = fold(hydrated, [
      { type: 'message.delta', chatId: CHAT, text: 'follow-up' },
      { type: 'turn.end', chatId: CHAT, stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } },
    ]);
    // 2 persisted turns + 1 new assistant turn.
    expect(s.turns).toHaveLength(3);
    expect(s.sessionUsage.inputTokens).toBe(1825);
    expect(s.sessionUsage.outputTokens).toBe(413);
  });

  it('hydrating empty history yields an empty conversation bound to the chat', () => {
    const s = hydrateHistory('c-2', []);
    expect(s.chatId).toBe('c-2');
    expect(s.turns).toEqual([]);
  });
});
