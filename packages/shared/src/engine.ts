/**
 * Engine event contract — the unified stream every runtime (local or remote)
 * emits to the UI. Spec 00 §5, Spec 03 §8.
 */
import type { Effort, ModelId, Usage } from './common.js';
import type { ChatMessage } from './chat.js';
import type { PermissionModes, PermissionPolicy } from './permissions.js';

export type EngineEvent =
  | { type: 'message.delta'; chatId: string; text: string }
  | { type: 'thinking.delta'; chatId: string; text: string }
  | {
      type: 'tool.start';
      chatId: string;
      tool: string;
      input: unknown;
      callId: string;
    }
  | {
      type: 'tool.permission';
      chatId: string;
      callId: string;
      tool: string;
      input: unknown;
    }
  | {
      type: 'tool.result';
      chatId: string;
      callId: string;
      output: unknown;
      isError: boolean;
    }
  | { type: 'turn.end'; chatId: string; stopReason: string; usage: Usage }
  | { type: 'error'; chatId: string; message: string };

/** Stop reasons the engine surfaces in turn.end (Spec 03 §4-§5). */
export type EngineStopReason =
  | 'end_turn'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'
  | 'max_tokens'
  | 'interrupted';

/**
 * Per-turn context the app ships to the stateless remote daemon (Spec 05 §4:
 * "histórico viaja do app para o daemon a cada engine.send"). The daemon keeps
 * NO history/system/policy of its own — everything it needs to run and gate the
 * turn travels on the `engine.send` command:
 *
 * - `system` + `history` + `volatileContext` reconstruct the prompt the local
 *   engine would have built (Spec 05 §4);
 * - `model`/`effort`/`maxTokens` carry the resolved engine knobs;
 * - `policy`/`modes` carry the chat's effective permission policy so the daemon
 *   enforces deny rules / per-tool defaults server-side (Spec 05 §5) instead of
 *   falling back to ask-everything.
 *
 * Optional only for trusted/test setups (stdio local engine, or a daemon test
 * stub) where the receiver resolves context another way.
 */
export interface EngineSendContext {
  /** Frozen system prompt (app + project instructions). */
  system: string;
  /** Persisted prior turns, oldest first. */
  history: ChatMessage[];
  /** Resolved model (chat override > project default > engine default). */
  model?: ModelId;
  effort?: Effort;
  maxTokens?: number;
  /** Volatile context appended as a trailing system message. */
  volatileContext?: string;
  /** The chat's effective permission policy (Spec 04 §3 / Spec 05 §5). */
  policy?: PermissionPolicy;
  /** Quick modes (read-only / auto-approve) for the turn (Spec 04 §3.2). */
  modes?: PermissionModes;
}

/**
 * Input commands accepted by the engine (Spec 03, Spec 05 §4).
 * The same shape is used over stdio (local sidecar) and WebSocket (remote daemon).
 */
export type EngineCommand =
  | { type: 'engine.send'; chatId: string; text: string; context?: EngineSendContext }
  | { type: 'engine.interrupt'; chatId: string }
  | {
      type: 'tool.permission.resolve';
      chatId: string;
      callId: string;
      decision: 'allow' | 'deny';
      /** Optional reason shown to the agent when denied (Spec 04 §3.1). */
      reason?: string;
      /** "Always allow" for this scope (session/project) (Spec 04 §3.1). */
      remember?: boolean;
    };
