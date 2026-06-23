/**
 * Local UI <-> sidecar WebSocket protocol (loopback only).
 *
 * The desktop app already has a full TypeScript engine in the sidecar; instead of
 * spawning the `claude` CLI we run a LOCAL WebSocket on 127.0.0.1 and speak this
 * tiny JSON protocol. It carries three things over one socket:
 *
 *  - RPC calls onto the four request/response APIs (projects/chats/runtimes/settings),
 *  - a push stream of {@link EngineEvent}s from the engine to the UI, and
 *  - a push channel of {@link EngineCommand}s from the UI to the engine
 *    (engine.interrupt + tool.permission.resolve — turn `send` goes via the chats RPC).
 *
 * The contracts mirror the same {@link EngineEvent}/{@link EngineCommand} shapes the
 * rest of the app uses, so a transport adapter on the UI side can present the exact
 * {@link IpcClient} interface without leaking the socket.
 */
import type { EngineCommand, EngineEvent } from './engine.js';

/** Default loopback port the host binds (override via the PORT env var). */
export const DEFAULT_SIDECAR_PORT = 8731;

/**
 * WS subprotocol scheme carrying the per-launch shared secret on the handshake.
 *
 * Loopback binding only stops off-box attackers — ANY local process (a malicious
 * npm dependency in another app, a browser tab opening `ws://127.0.0.1:<port>`,
 * etc.) can otherwise reach the host and drive the engine (read/write/bash in any
 * workspace, set/clear the API key, observe every chat's events). So the host
 * requires a random token, generated at launch and handed to the WebView out of
 * band, presented as `Sec-WebSocket-Protocol: ['vingsforge.local.v1', '<token>']`.
 * The host rejects the upgrade (401) before `connection` fires if it is absent or
 * wrong, and rejects any request that carries an `Origin` header (a native WebView
 * sends none; browsers always do) to block DNS-rebinding / web-page attacks.
 */
export const LOCAL_AUTH_SUBPROTOCOL = 'vingsforge.local.v1';

/**
 * Name of the env var the host reads its per-launch token from (the Tauri shell
 * generates it, passes it here, and injects the same value into the WebView).
 */
export const LOCAL_AUTH_TOKEN_ENV = 'VINGSFORGE_LOCAL_TOKEN';

/**
 * Global the Tauri shell injects into the WebView so the UI can present the token
 * on the WS handshake. Read it off `globalThis` (it is set before app scripts run).
 */
export const LOCAL_AUTH_TOKEN_GLOBAL = '__VINGSFORGE_LOCAL_TOKEN__';

/** Bumped on any breaking change to the frames below. */
export const LOCAL_PROTOCOL_VERSION = 1 as const;

/** The four request/response APIs reachable over RPC. */
export type LocalApi = 'projects' | 'chats' | 'runtimes' | 'settings';

/** An RPC error surfaced back to the caller (never carries secrets). */
export interface LocalRpcError {
  message: string;
  name?: string;
}

// --- UI -> sidecar (ClientMsg) ---------------------------------------------

/**
 * Invoke `api[method](...args)` on the host. `id` correlates the matching
 * {@link RpcOkMsg}/{@link RpcErrMsg}; the host serializes the resolved value as
 * `result` (or the rejection as `error`).
 */
export interface RpcRequestMsg {
  kind: 'rpc';
  id: string;
  api: LocalApi;
  method: string;
  args: unknown[];
}

/**
 * Push a command to the engine. Only `engine.interrupt` and
 * `tool.permission.resolve` travel here — a new turn is started via the
 * `chats.send` RPC, which already persists the user turn and streams events.
 */
export interface CommandMsg {
  kind: 'command';
  command: EngineCommand;
}

/** Everything the UI may send to the host. */
export type ClientMsg = RpcRequestMsg | CommandMsg;

// --- sidecar -> UI (ServerMsg) ---------------------------------------------

/** First frame on every connection; lets the UI assert protocol compatibility. */
export interface HelloMsg {
  kind: 'hello';
  protocol: typeof LOCAL_PROTOCOL_VERSION;
}

/** Successful RPC reply correlated by `id`. */
export interface RpcOkMsg {
  kind: 'rpc.ok';
  id: string;
  result: unknown;
}

/** Failed RPC reply correlated by `id`. */
export interface RpcErrMsg {
  kind: 'rpc.err';
  id: string;
  error: LocalRpcError;
}

/** A pushed engine event (the unified stream the UI renders). */
export interface EventMsg {
  kind: 'event';
  event: EngineEvent;
}

/** Everything the host may send to the UI. */
export type ServerMsg = HelloMsg | RpcOkMsg | RpcErrMsg | EventMsg;
