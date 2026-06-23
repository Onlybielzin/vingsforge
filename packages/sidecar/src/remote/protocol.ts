/**
 * forge-daemon WebSocket wire protocol (Spec 05 §4/§7/§8): framed, id-tagged
 * envelopes carrying the SAME EngineCommand/EngineEvent contract as the local
 * engine, plus fs/health/daemon-status frames and request/response correlation.
 */
import { z } from 'zod';
import type {
  ChatMessage,
  DirEntry,
  EngineCommand,
  EngineEvent,
  RemoteRuntimeStatus,
} from '@vingsforge/shared';

/** Current protocol version; bumped on any breaking frame change (Spec 05 §4). */
export const PROTOCOL_VERSION = 1 as const;

/**
 * App → daemon frames. Engine commands reuse the shared {@link EngineCommand}
 * contract verbatim; `fs.list`/`daemon.health` are request frames correlated by
 * `reqId` so the app can await a single reply (Spec 05 §4).
 */
export type ClientFrame =
  | { kind: 'command'; command: EngineCommand }
  | { kind: 'fs.list'; reqId: string; path: string }
  | { kind: 'daemon.health'; reqId: string }
  | { kind: 'ping'; ts: number };

/**
 * Daemon → app frames. Every engine event is tagged with a monotonic, per-
 * connection `seq` so the app can DEDUPE on reconnect and detect gaps without a
 * native WS replay (Spec 05 §8). Replies are correlated by `reqId`.
 *
 * `persist.assistant` / `persist.toolResults` carry the FULLY-ASSEMBLED turn
 * (text + `thinking{signature}` + `tool_use` / `tool_result` blocks), not the
 * lossy `*.delta` events: the app is the source of truth for history (Spec 05
 * §4), so the daemon streams each completed {@link ChatMessage} back for the app
 * to persist. Without these, thinking signatures and tool_use/tool_result
 * pairing are lost and replay 400s on the next turn (Spec 05 acceptance #4).
 * Both are `seq`-tagged so reconnect dedupe applies exactly as for events.
 */
export type ServerFrame =
  | { kind: 'event'; seq: number; event: EngineEvent }
  | { kind: 'persist.assistant'; seq: number; message: ChatMessage }
  | { kind: 'persist.toolResults'; seq: number; message: ChatMessage }
  | { kind: 'daemon.status'; seq: number; status: RemoteRuntimeStatus; message?: string }
  | { kind: 'fs.list.result'; reqId: string; entries: DirEntry[] }
  | { kind: 'fs.list.error'; reqId: string; message: string }
  | { kind: 'daemon.health.result'; reqId: string; version?: string; protocol: number }
  | { kind: 'error'; reqId?: string; message: string }
  | { kind: 'pong'; ts: number };

// --- Zod validators (every frame crossing the socket is untrusted) ----------

const dirEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  kind: z.enum(['file', 'dir', 'symlink']),
  size: z.number().optional(),
});

/** Token usage / cost accounting carried on `turn.end` and persisted turns. */
const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number().optional(),
  cacheReadInputTokens: z.number().optional(),
  estimatedCostUsd: z.number().optional(),
});

/**
 * A persisted content block (Spec 02 §3). `thinking` keeps its `signature` and
 * `tool_use`/`tool_result` keep their pairing — exactly the fields the lossy
 * `*.delta` events drop — so the app can store an API-valid, replayable turn.
 */
const blockSchema = z.union([
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('thinking'), text: z.string(), signature: z.string().optional() }),
  z.object({
    kind: z.literal('tool_use'),
    callId: z.string(),
    tool: z.string(),
    input: z.unknown(),
  }),
  z.object({
    kind: z.literal('tool_result'),
    callId: z.string(),
    output: z.unknown(),
    isError: z.boolean(),
  }),
]);

/** A fully-assembled turn the daemon streams back for the app to persist. */
const chatMessageSchema = z.object({
  id: z.string().min(1),
  chatId: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  blocks: z.array(blockSchema),
  usage: usageSchema.optional(),
  model: z.string().optional(),
  createdAt: z.string(),
});

const decisionSchema = z.enum(['allow', 'ask', 'deny']);

/** The chat's effective permission policy (Spec 04 §3), shipped per turn. */
const permissionPolicySchema = z.object({
  defaults: z.record(z.string(), decisionSchema),
  rules: z
    .array(
      z.object({
        tool: z.string(),
        match: z
          .object({
            pathGlob: z.string().optional(),
            commandRegex: z.string().optional(),
          })
          .optional(),
        decision: decisionSchema,
      }),
    )
    .optional(),
  rememberedAllows: z.array(z.string()).optional(),
});

/** Quick modes (read-only / auto-approve) shipped per turn (Spec 04 §3.2). */
const permissionModesSchema = z.object({
  autoApprove: z.boolean().optional(),
  readOnly: z.boolean().optional(),
});

/**
 * The stateless daemon's per-turn context (Spec 05 §4): the history/system/policy
 * the app ships on every `engine.send` so the daemon runs with real context and
 * gates server-side (Spec 05 §5) instead of an empty/ask-everything fallback.
 */
const engineSendContextSchema = z.object({
  system: z.string(),
  history: z.array(chatMessageSchema),
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  maxTokens: z.number().optional(),
  volatileContext: z.string().optional(),
  policy: permissionPolicySchema.optional(),
  modes: permissionModesSchema.optional(),
});

const engineCommandSchema = z.union([
  z.object({
    type: z.literal('engine.send'),
    chatId: z.string().min(1),
    text: z.string(),
    context: engineSendContextSchema.optional(),
  }),
  z.object({ type: z.literal('engine.interrupt'), chatId: z.string().min(1) }),
  z.object({
    type: z.literal('tool.permission.resolve'),
    chatId: z.string().min(1),
    callId: z.string().min(1),
    decision: z.enum(['allow', 'deny']),
    reason: z.string().optional(),
    remember: z.boolean().optional(),
  }),
]);

/** Validates an app→daemon frame received by the daemon. */
export const clientFrameSchema = z.union([
  z.object({ kind: z.literal('command'), command: engineCommandSchema }),
  z.object({ kind: z.literal('fs.list'), reqId: z.string().min(1), path: z.string().min(1) }),
  z.object({ kind: z.literal('daemon.health'), reqId: z.string().min(1) }),
  z.object({ kind: z.literal('ping'), ts: z.number() }),
]);

const engineEventSchema = z.union([
  z.object({ type: z.literal('message.delta'), chatId: z.string(), text: z.string() }),
  z.object({ type: z.literal('thinking.delta'), chatId: z.string(), text: z.string() }),
  z.object({
    type: z.literal('tool.start'),
    chatId: z.string(),
    tool: z.string(),
    input: z.unknown(),
    callId: z.string(),
  }),
  z.object({
    type: z.literal('tool.permission'),
    chatId: z.string(),
    callId: z.string(),
    tool: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('tool.result'),
    chatId: z.string(),
    callId: z.string(),
    output: z.unknown(),
    isError: z.boolean(),
  }),
  z.object({
    type: z.literal('turn.end'),
    chatId: z.string(),
    stopReason: z.string(),
    usage: usageSchema,
  }),
  z.object({ type: z.literal('error'), chatId: z.string(), message: z.string() }),
]);

/** Validates a daemon→app frame received by the app client. */
export const serverFrameSchema = z.union([
  z.object({ kind: z.literal('event'), seq: z.number(), event: engineEventSchema }),
  z.object({ kind: z.literal('persist.assistant'), seq: z.number(), message: chatMessageSchema }),
  z.object({ kind: z.literal('persist.toolResults'), seq: z.number(), message: chatMessageSchema }),
  z.object({
    kind: z.literal('daemon.status'),
    seq: z.number(),
    status: z.enum(['offline', 'connecting', 'online', 'installing', 'error']),
    message: z.string().optional(),
  }),
  z.object({
    kind: z.literal('fs.list.result'),
    reqId: z.string(),
    entries: z.array(dirEntrySchema),
  }),
  z.object({ kind: z.literal('fs.list.error'), reqId: z.string(), message: z.string() }),
  z.object({
    kind: z.literal('daemon.health.result'),
    reqId: z.string(),
    version: z.string().optional(),
    protocol: z.number(),
  }),
  z.object({ kind: z.literal('error'), reqId: z.string().optional(), message: z.string() }),
  z.object({ kind: z.literal('pong'), ts: z.number() }),
]);

/** Serialize a frame for the socket. */
export function encodeFrame(frame: ClientFrame | ServerFrame): string {
  return JSON.stringify(frame);
}

/**
 * Parse + validate a raw app→daemon frame (throws on malformed input). The cast
 * bridges Zod's `| undefined` optionals to the contract's exact-optional shape;
 * the values are structurally identical (validated above).
 */
export function decodeClientFrame(raw: string): ClientFrame {
  return clientFrameSchema.parse(JSON.parse(raw)) as ClientFrame;
}

/** Parse + validate a raw daemon→app frame (throws on malformed input). */
export function decodeServerFrame(raw: string): ServerFrame {
  return serverFrameSchema.parse(JSON.parse(raw)) as ServerFrame;
}
