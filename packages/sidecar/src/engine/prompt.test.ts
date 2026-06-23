/**
 * Prompt-assembly tests (Spec 03). Focus: thinking-block replay across a model
 * switch. Thinking (and its signature) only validates on a same-model replay, so
 * a turn produced by a different model must drop its thinking blocks rather than
 * re-send them — otherwise the API 400s and the whole turn breaks (Spec 03 §2/§4,
 * Spec 08 §4; Chat.modelOverride switch).
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@vingsforge/shared';
import { buildMessages } from './prompt.js';

function assistantTurn(model: ChatMessage['model'], signature = 'sig-abc'): ChatMessage {
  const turn: ChatMessage = {
    id: 'a1',
    chatId: 'c1',
    role: 'assistant',
    blocks: [
      { kind: 'thinking', text: 'reasoning', signature },
      { kind: 'text', text: 'hello' },
    ],
    createdAt: '2025-01-01T00:00:00.000Z',
  };
  if (model !== undefined) turn.model = model;
  return turn;
}

const base = {
  system: 'sys',
  userText: 'hi again',
} as const;

function thinkingBlocks(content: unknown): Array<Record<string, unknown>> {
  return ((content ?? []) as Array<Record<string, unknown>>).filter(
    (b) => b.type === 'thinking',
  );
}

describe('buildMessages thinking replay', () => {
  it('keeps thinking verbatim when the turn model matches the request model', () => {
    const messages = buildMessages({
      ...base,
      model: 'claude-opus-4-8',
      history: [assistantTurn('claude-opus-4-8')],
    });
    const thinking = thinkingBlocks(messages[0]?.content);
    expect(thinking).toEqual([
      { type: 'thinking', thinking: 'reasoning', signature: 'sig-abc' },
    ]);
    // text survives regardless.
    expect(messages[0]?.content).toContainEqual({ type: 'text', text: 'hello' });
  });

  it('drops thinking when the turn was produced by a different model', () => {
    const messages = buildMessages({
      ...base,
      model: 'claude-opus-4-8',
      history: [assistantTurn('claude-opus-4-7')],
    });
    expect(thinkingBlocks(messages[0]?.content)).toEqual([]);
    // non-thinking content is preserved so the turn still replays.
    expect(messages[0]?.content).toContainEqual({ type: 'text', text: 'hello' });
  });

  it('drops thinking when the turn model is unknown', () => {
    const messages = buildMessages({
      ...base,
      model: 'claude-opus-4-8',
      history: [assistantTurn(undefined)],
    });
    expect(thinkingBlocks(messages[0]?.content)).toEqual([]);
    expect(messages[0]?.content).toContainEqual({ type: 'text', text: 'hello' });
  });
});
