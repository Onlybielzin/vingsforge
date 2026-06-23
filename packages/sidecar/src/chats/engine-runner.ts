/**
 * Adapter binding the agentic {@link Engine} (Spec 03) to the ChatStore's
 * {@link EngineTurnInput} contract (Spec 02 §4): it wires the per-turn persist
 * hooks and controller through to a fresh Engine and maps the result.
 */
import type { EngineEvent } from '@vingsforge/shared';
import {
  Engine,
  type EngineDeps,
  type RunTurnParams,
  type TurnResult,
} from '../engine/engine.js';
import type { EngineTurnInput } from './store.js';

/**
 * Engine collaborators that are stable per turn but independent of the chat's
 * history/system prompt: the injected Anthropic client, the permission gate and
 * the tool executor (Spec 03/04). Persistence is supplied per turn by the store.
 */
export type TurnEngineDeps = Pick<EngineDeps, 'client' | 'gate' | 'executeTool'>;

/**
 * Build a `runEngineTurn` function for {@link ChatStoreDeps}. `resolveEngineDeps`
 * yields the client/gate/executor for the turn's runtime (local sidecar or a
 * remote daemon — Spec 05), so a single store can drive either transport.
 */
export function makeEngineRunner(
  resolveEngineDeps: (input: EngineTurnInput) => TurnEngineDeps | Promise<TurnEngineDeps>,
): (input: EngineTurnInput, emit: (event: EngineEvent) => void) => Promise<TurnResult> {
  return async (input, emit) => {
    const base = await resolveEngineDeps(input);
    const deps: EngineDeps = {
      client: base.client,
      gate: base.gate,
      executeTool: base.executeTool,
      persistAssistant: input.persistAssistant,
      persistToolResults: input.persistToolResults,
    };
    const engine = new Engine(deps);

    const params: RunTurnParams = {
      chatId: input.chatId,
      system: input.system,
      history: input.history,
      userText: input.userText,
      controller: input.controller,
    };
    if (input.model !== undefined) params.model = input.model;
    if (input.effort !== undefined) params.effort = input.effort;
    if (input.maxTokens !== undefined) params.maxTokens = input.maxTokens;
    if (input.volatileContext !== undefined) params.volatileContext = input.volatileContext;

    return engine.runTurn(params, emit);
  };
}
