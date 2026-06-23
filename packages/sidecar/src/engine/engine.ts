/**
 * Agentic engine (Spec 03): a manual streaming loop over the injected Anthropic
 * client. Emits EngineEvents, gates tools for permission, re-attaches the full
 * assistant content to history, batches all tool_results into one user message,
 * and supports AbortController interruption plus refusal/pause_turn handling.
 */
import type {
  Block,
  ChatMessage,
  EngineEvent,
  EngineStopReason,
  Effort,
  ModelId,
  Usage,
} from '@vingsforge/shared';
import type {
  Message,
  ContentBlock,
  MessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages';
import type { AnthropicLike } from './client.js';
import { buildRequest, type PromptInput } from './prompt.js';

/** Result of executing a single tool call (mirrors the sidecar ToolExecResult). */
export interface ToolOutcome {
  output: unknown;
  isError: boolean;
}

/** Permission decision returned by the host's gate (Spec 04 §3). */
export type GateDecision = { allow: true } | { allow: false; reason: string };

/** One tool_use the engine is about to run. */
export interface ToolCall {
  callId: string;
  tool: string;
  input: unknown;
}

/** Host-supplied collaborators the engine depends on (all injectable for tests). */
export interface EngineDeps {
  /** Injected Anthropic client (real SDK in prod, mock in tests — Spec 03 §2). */
  client: AnthropicLike;
  /**
   * Permission gate (Spec 04). Returns allow/deny; may block on human approval.
   * `signal` lets a pending approval be cancelled by an interrupt.
   */
  gate(call: ToolCall, signal: AbortSignal): Promise<GateDecision>;
  /** Run an allowed tool against the active runtime (local or remote — Spec 03 §6). */
  executeTool(call: ToolCall, signal: AbortSignal): Promise<ToolOutcome>;
  /** Persist a completed assistant turn (Spec 02). Optional. */
  persistAssistant?(chatId: string, message: ChatMessage): void;
  /**
   * Persist the user turn carrying the batched tool_results (Spec 02). Optional.
   * Must be called for every tool_use turn so the persisted history pairs each
   * tool_use with its tool_result — otherwise the next request 400s, since the
   * Anthropic API requires every tool_use to be followed by a tool_result.
   */
  persistToolResults?(chatId: string, message: ChatMessage): void;
}

/** Per-run parameters for a single `runTurn` invocation. */
export interface RunTurnParams {
  chatId: string;
  /** Frozen system prompt (app + project). */
  system: string;
  /** Persisted prior turns, oldest first. */
  history: ChatMessage[];
  /** New user text. */
  userText: string;
  /** Volatile context appended as a trailing role:'system' message. */
  volatileContext?: string;
  model?: ModelId;
  effort?: Effort;
  maxTokens?: number;
  /** Caller-owned controller; abort to interrupt the turn (Spec 03 §5). */
  controller?: AbortController;
}

/** Summary of a finished turn. */
export interface TurnResult {
  stopReason: EngineStopReason;
  usage: Usage;
}

/** Hard cap on agentic iterations to prevent runaway loops. */
const MAX_ITERATIONS = 100;

/**
 * The engine. Holds its dependencies; `runTurn` executes one user turn through
 * the agentic loop until the model ends the turn, refuses, is interrupted, or
 * the iteration cap is hit.
 */
export class Engine {
  constructor(private readonly deps: EngineDeps) {}

  async runTurn(
    params: RunTurnParams,
    emit: (event: EngineEvent) => void,
  ): Promise<TurnResult> {
    const controller = params.controller ?? new AbortController();
    const { signal } = controller;
    const chatId = params.chatId;

    // Base prompt input shared across iterations; optional fields are only set
    // when present (exactOptionalPropertyTypes). The growing tool/assistant
    // turns are appended to `history` per iteration so the cached prefix holds.
    const promptInput: PromptInput = {
      system: params.system,
      history: params.history,
      userText: params.userText,
    };
    if (params.model !== undefined) promptInput.model = params.model;
    if (params.effort !== undefined) promptInput.effort = params.effort;
    if (params.maxTokens !== undefined) promptInput.maxTokens = params.maxTokens;
    if (params.volatileContext !== undefined) {
      promptInput.volatileContext = params.volatileContext;
    }

    // We rebuild the request fresh from a growing `extraMessages` list so the
    // cached prefix (tools + system + history) is preserved across iterations.
    const extraTurns: ChatMessage[] = [];
    let usage: Usage = emptyUsage();

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration += 1) {
      if (signal.aborted) {
        return finishInterrupted(chatId, usage, emit);
      }

      const request = buildRequest({
        ...promptInput,
        history: [...params.history, ...extraTurns],
      });

      const stream = this.deps.client.messages.stream(request);

      // Abort the stream when the caller's controller fires (Spec 03 §5).
      const onAbort = (): void => stream.abort();
      signal.addEventListener('abort', onAbort, { once: true });

      let finalMessage: Message;
      try {
        await drainStream(stream, chatId, emit);
        finalMessage = await stream.finalMessage();
      } catch (err) {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted || isAbortError(err)) {
          return finishInterrupted(chatId, usage, emit);
        }
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: 'error', chatId, message });
        return { stopReason: 'end_turn', usage };
      } finally {
        signal.removeEventListener('abort', onAbort);
      }

      usage = addUsage(usage, mapUsage(finalMessage.usage));

      // Re-attach the FULL assistant content (incl. thinking + tool_use) to
      // history before processing tools (Spec 03 §4).
      const assistantTurn = messageToTurn(chatId, finalMessage, params.model);
      extraTurns.push(assistantTurn);
      this.deps.persistAssistant?.(chatId, assistantTurn);

      // Refusal must be checked BEFORE reading content for tools (Spec 03 §4).
      if (finalMessage.stop_reason === 'refusal') {
        emit({ type: 'turn.end', chatId, stopReason: 'refusal', usage });
        return { stopReason: 'refusal', usage };
      }

      // pause_turn (server-side tools): re-send to continue, no "Continue." text.
      if (finalMessage.stop_reason === 'pause_turn') {
        continue;
      }

      if (finalMessage.stop_reason !== 'tool_use') {
        const stopReason = mapStopReason(finalMessage.stop_reason);
        emit({ type: 'turn.end', chatId, stopReason, usage });
        return { stopReason, usage };
      }

      // Execute every tool_use block, collecting all results into ONE user msg.
      const toolUses = finalMessage.content.filter(
        (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
      );
      const resultBlocks: Block[] = [];

      for (let i = 0; i < toolUses.length; i += 1) {
        const block = toolUses[i]!;
        if (signal.aborted) {
          // Interrupted mid-loop: close EVERY tool_use in this assistant turn so
          // the persisted history stays API-valid and continuable (Spec 03 §5,
          // acceptance #3). Already-run calls keep their outcome above; the
          // current and remaining calls get a synthesized is_error result.
          for (const pending of toolUses.slice(i)) {
            resultBlocks.push({
              kind: 'tool_result',
              callId: pending.id,
              output: { error: 'interrupted' },
              isError: true,
            });
          }
          return this.finishInterruptedWithResults(chatId, resultBlocks, extraTurns, usage, emit);
        }
        const call: ToolCall = { callId: block.id, tool: block.name, input: block.input };
        emit({ type: 'tool.start', chatId, tool: call.tool, input: call.input, callId: call.callId });

        const outcome = await this.runOneTool(call, signal);
        emit({
          type: 'tool.result',
          chatId,
          callId: call.callId,
          output: outcome.output,
          isError: outcome.isError,
        });
        resultBlocks.push({
          kind: 'tool_result',
          callId: call.callId,
          output: outcome.output,
          isError: outcome.isError,
        });
      }

      // All tool_results in ONE user message (Spec 03 §4). Persist it too, so
      // the stored history keeps each tool_use paired with its tool_result and
      // stays API-valid / continuable on the user's next turn.
      const resultTurn = makeUserResultTurn(chatId, resultBlocks);
      extraTurns.push(resultTurn);
      this.deps.persistToolResults?.(chatId, resultTurn);
    }

    // Iteration cap reached: end cleanly rather than loop forever.
    emit({ type: 'turn.end', chatId, stopReason: 'end_turn', usage });
    return { stopReason: 'end_turn', usage };
  }

  /**
   * Close an interrupted tool loop: emit the batched tool_result turn (so every
   * tool_use in the current assistant message is paired), persist it, then return
   * `interrupted`. Keeps the stored thread API-valid / continuable (Spec 03 §5).
   */
  private finishInterruptedWithResults(
    chatId: string,
    resultBlocks: Block[],
    extraTurns: ChatMessage[],
    usage: Usage,
    emit: (event: EngineEvent) => void,
  ): TurnResult {
    const resultTurn = makeUserResultTurn(chatId, resultBlocks);
    extraTurns.push(resultTurn);
    this.deps.persistToolResults?.(chatId, resultTurn);
    return finishInterrupted(chatId, usage, emit);
  }

  /** Gate then execute a single tool; a denied call yields an is_error result. */
  private async runOneTool(call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> {
    let decision: GateDecision;
    try {
      decision = await this.deps.gate(call, signal);
    } catch (err) {
      if (signal.aborted || isAbortError(err)) {
        return { output: { error: 'interrupted' }, isError: true };
      }
      const reason = err instanceof Error ? err.message : String(err);
      return { output: { error: reason }, isError: true };
    }

    if (!decision.allow) {
      return { output: { error: decision.reason, denied: true }, isError: true };
    }

    if (signal.aborted) {
      return { output: { error: 'interrupted' }, isError: true };
    }

    try {
      // Output stays structured here; it is serialized when rebuilt into the
      // prompt (see buildMessages → serializeToolOutput).
      return await this.deps.executeTool(call, signal);
    } catch (err) {
      if (signal.aborted || isAbortError(err)) {
        return { output: { error: 'interrupted' }, isError: true };
      }
      const reason = err instanceof Error ? err.message : String(err);
      return { output: { error: reason }, isError: true };
    }
  }
}

/** Stream the deltas, emitting message/thinking events as they arrive (Spec 03 §4). */
async function drainStream(
  stream: AsyncIterable<MessageStreamEvent>,
  chatId: string,
  emit: (event: EngineEvent) => void,
): Promise<void> {
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta') {
      if (ev.delta.type === 'thinking_delta') {
        emit({ type: 'thinking.delta', chatId, text: ev.delta.thinking });
      } else if (ev.delta.type === 'text_delta') {
        emit({ type: 'message.delta', chatId, text: ev.delta.text });
      }
    }
  }
}

/** Emit turn.end with `interrupted` and return (Spec 03 §5). */
function finishInterrupted(
  chatId: string,
  usage: Usage,
  emit: (event: EngineEvent) => void,
): TurnResult {
  emit({ type: 'turn.end', chatId, stopReason: 'interrupted', usage });
  return { stopReason: 'interrupted', usage };
}

/** Convert a finished SDK Message to a persisted assistant turn (Spec 02). */
function messageToTurn(chatId: string, message: Message, model?: ModelId): ChatMessage {
  const blocks: Block[] = [];
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        blocks.push({ kind: 'text', text: block.text });
        break;
      case 'thinking':
        blocks.push({ kind: 'thinking', text: block.thinking, signature: block.signature });
        break;
      case 'tool_use':
        blocks.push({ kind: 'tool_use', callId: block.id, tool: block.name, input: block.input });
        break;
      default:
        // redacted_thinking / server tool blocks are not persisted in v1.
        break;
    }
  }
  const turn: ChatMessage = {
    id: message.id,
    chatId,
    role: 'assistant',
    blocks,
    usage: mapUsage(message.usage),
    createdAt: new Date().toISOString(),
  };
  const resolvedModel = model ?? message.model;
  if (resolvedModel) turn.model = resolvedModel;
  return turn;
}

/** Wrap collected tool_result blocks into a single user turn. */
function makeUserResultTurn(chatId: string, blocks: Block[]): ChatMessage {
  return {
    id: `tool-results-${Date.now()}`,
    chatId,
    role: 'user',
    blocks,
    createdAt: new Date().toISOString(),
  };
}

/** Map the SDK stop_reason to the engine's surface (Spec 03 §4). */
function mapStopReason(reason: Message['stop_reason']): EngineStopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'pause_turn':
      return 'pause_turn';
    case 'refusal':
      return 'refusal';
    case 'max_tokens':
      return 'max_tokens';
    default:
      return 'end_turn';
  }
}

/** Map the SDK Usage to the shared Usage shape (Spec 02 RF-10). */
function mapUsage(u: Message['usage']): Usage {
  const usage: Usage = {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
  };
  if (u.cache_creation_input_tokens !== null) {
    usage.cacheCreationInputTokens = u.cache_creation_input_tokens;
  }
  if (u.cache_read_input_tokens !== null) {
    usage.cacheReadInputTokens = u.cache_read_input_tokens;
  }
  return usage;
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0 };
}

/** Accumulate usage across iterations of a multi-step turn. */
function addUsage(a: Usage, b: Usage): Usage {
  const sum: Usage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
  const cacheCreation =
    (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0);
  const cacheRead = (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0);
  if (cacheCreation > 0) sum.cacheCreationInputTokens = cacheCreation;
  if (cacheRead > 0) sum.cacheReadInputTokens = cacheRead;
  return sum;
}

/** Recognise the SDK's user-abort error without importing its class at runtime. */
function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === 'AbortError' || err.name === 'APIUserAbortError';
  }
  return false;
}
