/**
 * Local-vs-remote turn routing (Spec 05 §4/RF-05/RF-06). Wraps a local
 * `runEngineTurn` with a remote path: when a chat's runtime is a VPS, the turn
 * is driven by that runtime's daemon — the app ships `engine.send`, forwards the
 * app-side permission decision down, and resolves when the daemon's `turn.end`
 * (or `error`) arrives. Permission gating stays in the app (Spec 05 §5).
 */
import type { EngineEvent, EngineSendContext } from '@vingsforge/shared';
import type { EngineTurnInput, TurnResult } from '../chats/store.js';
import type { RemoteRuntimeStore } from './runtimes.js';

/** Signature of the chat store's per-turn runner. */
export type RunEngineTurn = (
  input: EngineTurnInput,
  emit: (event: EngineEvent) => void,
) => Promise<TurnResult>;

/** The sentinel runtime id meaning "run locally" (mirrors the store guard). */
export const LOCAL_RUNTIME = 'local';

/** True when a runtimeId routes the turn to a remote daemon (Spec 05 RF-05). */
export function isRemoteRuntime(runtimeId: string | undefined): boolean {
  return runtimeId !== undefined && runtimeId !== LOCAL_RUNTIME;
}

/**
 * Build a `runEngineTurn` that dispatches per chat runtime: local turns go to
 * `runLocal` (the in-process Engine); remote turns are driven by the daemon via
 * the runtime's connected {@link RemoteRuntimeClient}. The returned function has
 * the exact {@link RunEngineTurn} shape the ChatStore expects.
 */
export function makeRuntimeRouter(
  runtimes: RemoteRuntimeStore,
  runLocal: RunEngineTurn,
): RunEngineTurn {
  return (input, emit) => {
    if (!isRemoteRuntime(input.runtimeId)) return runLocal(input, emit);
    return runRemoteTurn(runtimes, input, emit);
  };
}

/** Usage value used when a turn ends without the daemon reporting any. */
const ZERO_USAGE = { inputTokens: 0, outputTokens: 0 } as const;

/**
 * Drive a single turn on a remote daemon. The app stays the source of truth for
 * history (Spec 05 §4): the daemon is stateless, so the per-turn context —
 * system + history + model/effort/maxTokens + volatileContext + the effective
 * permission policy/modes — travels from the app on the `engine.send` command
 * itself. Without this the daemon would run with empty history and gate against
 * an ask-everything fallback (Spec 05 §4/§5, acceptance #2). We then subscribe
 * to the runtime store's remote event fan-out (already deduped by the client),
 * filter to this chat, re-emit on the chat bus, and resolve on `turn.end`.
 *
 * Crucially we ALSO subscribe to the persist fan-out: the daemon streams back
 * each fully-assembled turn (assistant text + thinking{signature} + tool_use,
 * and the batched tool_result user turn), and we route those to the store's
 * `persistAssistant` / `persistToolResults` hooks. The `*.delta` events alone
 * are lossy (no signatures, no tool_use/tool_result pairing), so without this
 * the stored history would 400 on replay (Spec 05 §4 / acceptance #4).
 */
function runRemoteTurn(
  runtimes: RemoteRuntimeStore,
  input: EngineTurnInput,
  emit: (event: EngineEvent) => void,
): Promise<TurnResult> {
  const runtimeId = input.runtimeId as string;
  const client = runtimes.clientFor(runtimeId);
  if (!client) {
    const message = `remote runtime '${runtimeId}' is not connected`;
    emit({ type: 'error', chatId: input.chatId, message });
    return Promise.resolve({ stopReason: 'end_turn', usage: { ...ZERO_USAGE } });
  }

  return new Promise<TurnResult>((resolve) => {
    let settled = false;
    let unsubscribe = (): void => {};
    let unsubscribePersist = (): void => {};

    const finish = (result: TurnResult): void => {
      if (settled) return;
      settled = true;
      input.controller.signal.removeEventListener('abort', onAbort);
      unsubscribe();
      unsubscribePersist();
      resolve(result);
    };

    const onAbort = (): void => {
      client.sendCommand({ type: 'engine.interrupt', chatId: input.chatId });
    };

    // Bridge this chat's daemon events to the chat bus and detect turn end. The
    // client already deduped by seq, so re-emit verbatim.
    unsubscribe = runtimes.onTurnEvent((event) => {
      // update.* events ride the same bus but carry no chatId — never a turn event.
      if (!('chatId' in event) || event.chatId !== input.chatId) return;
      emit(event);
      if (event.type === 'turn.end') {
        finish({ stopReason: stopReasonOf(event.stopReason), usage: event.usage });
      }
    });

    // Persist the assembled turns the daemon streams back, so the app (the
    // source of truth — Spec 05 §4) stores an API-valid, replayable history with
    // thinking signatures and paired tool_use/tool_result blocks intact. Filter
    // to this chat; the client already deduped by seq.
    unsubscribePersist = runtimes.onTurnPersist((persist) => {
      if (persist.message.chatId !== input.chatId) return;
      if (persist.kind === 'assistant') {
        input.persistAssistant(input.chatId, persist.message);
      } else {
        input.persistToolResults(input.chatId, persist.message);
      }
    });

    input.controller.signal.addEventListener('abort', onAbort, { once: true });
    client.sendCommand({
      type: 'engine.send',
      chatId: input.chatId,
      text: input.userText,
      context: sendContextOf(input),
    });
  });
}

/**
 * Assemble the per-turn {@link EngineSendContext} the stateless daemon needs from
 * the store-resolved {@link EngineTurnInput} (Spec 05 §4). Only set the optional
 * fields that are present so we don't widen them to `undefined` (exact-optional).
 */
function sendContextOf(input: EngineTurnInput): EngineSendContext {
  const context: EngineSendContext = { system: input.system, history: input.history };
  if (input.model !== undefined) context.model = input.model;
  if (input.effort !== undefined) context.effort = input.effort;
  if (input.maxTokens !== undefined) context.maxTokens = input.maxTokens;
  if (input.volatileContext !== undefined) context.volatileContext = input.volatileContext;
  if (input.policy !== undefined) context.policy = input.policy;
  if (input.modes !== undefined) context.modes = input.modes;
  return context;
}

/** Map the daemon's stopReason string back to the engine's union. */
function stopReasonOf(reason: string): TurnResult['stopReason'] {
  switch (reason) {
    case 'end_turn':
    case 'tool_use':
    case 'pause_turn':
    case 'refusal':
    case 'max_tokens':
    case 'interrupted':
      return reason;
    default:
      return 'end_turn';
  }
}
