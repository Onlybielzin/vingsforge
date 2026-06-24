/**
 * Conversation view-model + reducer (Spec 06 §4). Folds the EngineEvent stream
 * and persisted ChatMessage history into renderable turns, tool cards with
 * lifecycle states, collapsible reasoning and the active permission gate.
 */
import type {
  Block,
  ChatMessage,
  EngineEvent,
  Usage,
} from '@vingsforge/shared';

/** Lifecycle of a tool card (Spec 06 §4 "Estados"). */
export type ToolState =
  | 'pending'
  | 'awaiting-permission'
  | 'running'
  | 'ok'
  | 'error';

export interface ToolCard {
  callId: string;
  tool: string;
  input: unknown;
  state: ToolState;
  output?: unknown;
  isError?: boolean;
}

/** A renderable item within a turn, in stream order. */
export type TurnItem =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; card: ToolCard };

export interface Turn {
  id: string;
  role: 'user' | 'assistant';
  items: TurnItem[];
  usage?: Usage;
  /** Assistant turn is still streaming (no turn.end yet). */
  streaming?: boolean;
}

/** A permission request currently blocking the flow (Spec 06 §4, Spec 04 §3.1). */
export interface PendingPermission {
  callId: string;
  tool: string;
  input: unknown;
}

export interface ConversationState {
  chatId: string | null;
  turns: Turn[];
  /** True between engine.send and turn.end. */
  streaming: boolean;
  pendingPermission: PendingPermission | null;
  error: string | null;
  /** Tokens accumulated across the open chat (Spec 06 §4 rodapé). */
  sessionUsage: Usage;
}

export function emptyConversation(chatId: string | null = null): ConversationState {
  return {
    chatId,
    turns: [],
    streaming: false,
    pendingPermission: null,
    error: null,
    sessionUsage: { inputTokens: 0, outputTokens: 0 },
  };
}

function blockToItem(block: Block): TurnItem | null {
  switch (block.kind) {
    case 'text':
      return { kind: 'text', text: block.text };
    case 'thinking':
      return { kind: 'thinking', text: block.text };
    case 'tool_use':
      return {
        kind: 'tool',
        card: { callId: block.callId, tool: block.tool, input: block.input, state: 'pending' },
      };
    case 'tool_result':
      return null; // merged into its tool_use card below
  }
}

/** Builds initial turns from persisted history (Spec 02 §3 blocks). */
export function hydrateHistory(chatId: string, messages: ChatMessage[]): ConversationState {
  const state = emptyConversation(chatId);
  for (const msg of messages) {
    const items: TurnItem[] = [];
    for (const block of msg.blocks) {
      const item = blockToItem(block);
      if (item) items.push(item);
      if (block.kind === 'tool_result') {
        // The matching tool_use lives in an EARLIER message (assistant turn),
        // not in this user turn's items — so search the whole state too, else no
        // historical tool ever resolves and they all read as "running".
        const card = findCardAcrossTurns(state, block.callId) ?? findCard(items, block.callId);
        if (card) {
          card.state = block.isError ? 'error' : 'ok';
          card.output = block.output;
          card.isError = block.isError;
        }
      }
    }
    state.turns.push({ id: msg.id, role: msg.role, items, ...(msg.usage ? { usage: msg.usage } : {}) });
    if (msg.usage) state.sessionUsage = addUsage(state.sessionUsage, msg.usage);
  }
  // History is static — every turn already ended. Any tool still in a
  // non-terminal state is orphaned (its result was never persisted, e.g. an
  // interrupted turn); mark it terminal so it doesn't show as "running" forever
  // (and the Agents panel doesn't count it as live with a runaway timer).
  for (const turn of state.turns) {
    for (const it of turn.items) {
      if (it.kind === 'tool' && (it.card.state === 'pending' || it.card.state === 'running' || it.card.state === 'awaiting-permission')) {
        it.card.state = 'ok';
      }
    }
  }
  return state;
}

function findCard(items: TurnItem[], callId: string): ToolCard | undefined {
  for (const it of items) if (it.kind === 'tool' && it.card.callId === callId) return it.card;
  return undefined;
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.estimatedCostUsd != null || b.estimatedCostUsd != null
      ? { estimatedCostUsd: (a.estimatedCostUsd ?? 0) + (b.estimatedCostUsd ?? 0) }
      : {}),
  };
}

/** Returns the last assistant turn, creating one if the last is a user turn. */
function lastAssistantTurn(state: ConversationState): Turn {
  const last = state.turns[state.turns.length - 1];
  if (last && last.role === 'assistant' && last.streaming) return last;
  const turn: Turn = { id: `t-${Date.now()}-${state.turns.length}`, role: 'assistant', items: [], streaming: true };
  state.turns.push(turn);
  return turn;
}

function appendText(turn: Turn, kind: 'text' | 'thinking', text: string): void {
  const last = turn.items[turn.items.length - 1];
  if (last && last.kind === kind) last.text += text;
  else turn.items.push({ kind, text } as TurnItem);
}

/**
 * Appends a locally-issued user message (optimistic, before the engine streams
 * back). Returns a new state object.
 */
export function appendUserMessage(state: ConversationState, text: string): ConversationState {
  const next = clone(state);
  next.turns.push({ id: `u-${Date.now()}`, role: 'user', items: [{ kind: 'text', text }] });
  next.streaming = true;
  next.error = null;
  return next;
}

function clone(state: ConversationState): ConversationState {
  return {
    ...state,
    turns: state.turns.map((t) => ({ ...t, items: t.items.map((i) => (i.kind === 'tool' ? { ...i, card: { ...i.card } } : { ...i })) })),
    sessionUsage: { ...state.sessionUsage },
  };
}

/** Folds a single EngineEvent into the conversation state (pure, returns new state). */
export function reduceEvent(state: ConversationState, event: EngineEvent): ConversationState {
  if ('chatId' in event && state.chatId && event.chatId !== state.chatId) return state;
  const next = clone(state);

  switch (event.type) {
    case 'message.delta': {
      appendText(lastAssistantTurn(next), 'text', event.text);
      next.streaming = true;
      return next;
    }
    case 'thinking.delta': {
      appendText(lastAssistantTurn(next), 'thinking', event.text);
      next.streaming = true;
      return next;
    }
    case 'tool.start': {
      const turn = lastAssistantTurn(next);
      const existing = findCard(turn.items, event.callId);
      if (existing) existing.state = 'running';
      else
        turn.items.push({
          kind: 'tool',
          card: { callId: event.callId, tool: event.tool, input: event.input, state: 'running' },
        });
      return next;
    }
    case 'tool.permission': {
      const turn = lastAssistantTurn(next);
      const card = findCard(turn.items, event.callId);
      if (card) card.state = 'awaiting-permission';
      next.pendingPermission = { callId: event.callId, tool: event.tool, input: event.input };
      return next;
    }
    case 'tool.result': {
      const card = findCardAcrossTurns(next, event.callId);
      if (card) {
        card.state = event.isError ? 'error' : 'ok';
        card.output = event.output;
        card.isError = event.isError;
      }
      if (next.pendingPermission?.callId === event.callId) next.pendingPermission = null;
      return next;
    }
    case 'turn.end': {
      const turn = next.turns[next.turns.length - 1];
      if (turn && turn.role === 'assistant') {
        turn.streaming = false;
        turn.usage = event.usage;
      }
      next.streaming = false;
      next.sessionUsage = addUsage(next.sessionUsage, event.usage);
      return next;
    }
    case 'error': {
      next.error = event.message;
      next.streaming = false;
      return next;
    }
    default:
      // update.log / update.done ride the same channel but carry no chatId and
      // are consumed by the updater UI, not the conversation reducer.
      return state;
  }
}

function findCardAcrossTurns(state: ConversationState, callId: string): ToolCard | undefined {
  for (let i = state.turns.length - 1; i >= 0; i--) {
    const turn = state.turns[i];
    if (!turn) continue;
    const card = findCard(turn.items, callId);
    if (card) return card;
  }
  return undefined;
}
