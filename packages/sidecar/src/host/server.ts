/**
 * Local WebSocket host: binds 127.0.0.1 only and bridges the UI to the real
 * engine over the {@link localproto} frames. It routes RPC calls onto the four
 * APIs, forwards every {@link EngineEvent} onto connected clients, and applies
 * UI {@link EngineCommand}s (engine.interrupt + tool.permission.resolve).
 *
 * Permission gating: the engine's gate blocks on a human decision. We keep a
 * registry of pending gates keyed by `${chatId}:${callId}`; the gate registers a
 * resolver and emits `tool.permission`, and a `tool.permission.resolve` command
 * settles it (allow/deny, with optional remember).
 */
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type {
  ClientMsg,
  EngineCommand,
  EngineEvent,
  LocalApi,
  ServerMsg,
} from '@vingsforge/shared';
import {
  LOCAL_AUTH_SUBPROTOCOL,
  LOCAL_PROTOCOL_VERSION,
} from '@vingsforge/shared';
import type { GateDecision } from '../engine/engine.js';

/** Loopback address — the host is never reachable off-box (Spec 05 §5 intent). */
const LOOPBACK = '127.0.0.1';

/**
 * Constant-time compare of the presented token against the expected one. Returns
 * false on any mismatch (including a missing token or a length difference).
 */
function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Read the bearer token off the handshake's `Sec-WebSocket-Protocol` header. The
 * UI offers `['vingsforge.local.v1', '<token>']`; we return the token (the entry
 * right after the scheme), or undefined if the scheme is absent.
 */
function tokenFromHeader(header: string | string[] | undefined): string | undefined {
  if (header === undefined) return undefined;
  const raw = Array.isArray(header) ? header.join(',') : header;
  const parts = raw.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  const schemeAt = parts.indexOf(LOCAL_AUTH_SUBPROTOCOL);
  if (schemeAt === -1) return undefined;
  return parts[schemeAt + 1];
}

/** Settlement of a pending permission gate plus its remember flag. */
export interface GateResolution {
  decision: 'allow' | 'deny';
  reason?: string;
  remember?: boolean;
}

/** The four APIs the host routes RPC onto (method dispatch is dynamic). */
export interface HostApis {
  projects: Record<string, (...args: unknown[]) => unknown>;
  chats: Record<string, (...args: unknown[]) => unknown>;
  runtimes: Record<string, (...args: unknown[]) => unknown>;
  settings: Record<string, (...args: unknown[]) => unknown>;
}

/**
 * Tracks gates awaiting a UI decision. The engine's gate calls {@link await} to
 * block; the command channel calls {@link resolve} when a `tool.permission.resolve`
 * arrives. Keyed by chat+call so two chats can gate concurrently.
 */
export class PendingPermissions {
  private readonly pending = new Map<string, (r: GateResolution) => void>();

  private key(chatId: string, callId: string): string {
    return `${chatId}:${callId}`;
  }

  /** Block until the UI resolves this gate, or `signal` aborts it (interrupt). */
  await(chatId: string, callId: string, signal: AbortSignal): Promise<GateResolution> {
    return new Promise<GateResolution>((resolve) => {
      const k = this.key(chatId, callId);
      if (signal.aborted) {
        resolve({ decision: 'deny', reason: 'interrupted' });
        return;
      }
      this.pending.set(k, resolve);
      const onAbort = (): void => {
        if (this.pending.delete(k)) resolve({ decision: 'deny', reason: 'interrupted' });
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Settle a pending gate. No-op if it already resolved (abort/duplicate). */
  resolve(chatId: string, callId: string, resolution: GateResolution): void {
    const k = this.key(chatId, callId);
    const settle = this.pending.get(k);
    if (settle) {
      this.pending.delete(k);
      settle(resolution);
    }
  }
}

/** Map a {@link GateResolution} to the engine's {@link GateDecision}. */
export function toGateDecision(r: GateResolution): GateDecision {
  return r.decision === 'allow'
    ? { allow: true }
    : { allow: false, reason: r.reason ?? 'denied by user' };
}

/** Collaborators the server needs from the host wiring. */
export interface HostServerDeps {
  /**
   * Per-launch shared secret. Every connection MUST present it on the WS handshake
   * subprotocol (`['vingsforge.local.v1', '<token>']`); unauthenticated upgrades
   * are 401'd before `connection` fires. Binding to loopback only blocks off-box
   * attackers, NOT other local processes / browser tabs, so this is the real
   * access control. Omitting it (legacy/tests) disables auth — never do so in prod.
   */
  authToken?: string;
  apis: HostApis;
  /**
   * Subscribe to engine events; returns an unsubscribe. The server forwards each
   * event to every connected client (the UI filters by chatId).
   */
  onEngineEvent(listener: (event: EngineEvent) => void): () => void;
  /** Apply a UI command (interrupt / permission resolution). */
  applyCommand(command: EngineCommand): void;
  /** Structured logger (stderr only; never logs secrets). */
  log(message: string): void;
}

/** A running local host server with a graceful `close`. */
export interface RunningHost {
  port: number;
  close(): Promise<void>;
}

/**
 * Start the loopback WebSocket server. Resolves once it is listening. Every
 * connected client receives a `hello`, the full event stream, and RPC replies.
 */
/**
 * Origins the app legitimately connects from. The Tauri WebView and the Vite dev
 * server are browser contexts, so they ALWAYS send an `Origin` header — we cannot
 * require "no origin". The per-launch token (below) is the real access control;
 * this allowlist is defense-in-depth against DNS-rebinding from a foreign page.
 */
const ALLOWED_ORIGINS = new Set<string>([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'null',
]);

export function startHostServer(
  deps: HostServerDeps,
  port: number,
): Promise<RunningHost> {
  const wss = new WebSocketServer({
    host: LOOPBACK,
    port,
    // Authenticate at the WS upgrade, before `connection` fires: no client is ever
    // added to `clients`, sent `hello`, or allowed to drive RPC/commands unless it
    // both (a) presents the per-launch token on the subprotocol and (b) carries no
    // `Origin` header. A native WebView sends no Origin; a browser tab always does,
    // so rejecting Origin blocks DNS-rebinding / web-page attacks even if the token
    // somehow leaks. ws responds 401 to a false verifyClient.
    verifyClient: (info: {
      origin: string;
      req: { headers: Record<string, string | string[] | undefined> };
    }): boolean => {
      // The WebView/dev-server are browser contexts and always send an Origin.
      // Allow only the app's own origins (or no origin for a native client);
      // reject any foreign page outright.
      const rawOrigin = info.req.headers['origin'];
      const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
      if (origin !== undefined && origin !== '' && !ALLOWED_ORIGINS.has(origin)) {
        deps.log(`ws upgrade rejected: foreign origin ${origin}`);
        return false;
      }
      // Until a token exists the whole RPC surface is untrusted: refuse every
      // connection rather than serving an open engine.
      if (deps.authToken === undefined || deps.authToken === '') {
        deps.log('ws upgrade rejected: no auth token configured');
        return false;
      }
      const presented = tokenFromHeader(info.req.headers['sec-websocket-protocol']);
      const ok = tokenMatches(deps.authToken, presented);
      if (!ok) deps.log(`ws upgrade rejected: token mismatch (origin=${origin ?? 'none'})`);
      return ok;
    },
    // Echo the auth scheme as the negotiated subprotocol (never the token) so the
    // browser/`ws` client completes the handshake.
    handleProtocols: (protocols: Set<string>): string | false =>
      protocols.has(LOCAL_AUTH_SUBPROTOCOL) ? LOCAL_AUTH_SUBPROTOCOL : false,
  });
  const clients = new Set<WebSocket>();

  // Fan engine events out to every connected client.
  const unsubscribe = deps.onEngineEvent((event) => {
    const frame: ServerMsg = { kind: 'event', event };
    broadcast(clients, frame);
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    deps.log(`ws client connected (${clients.size} total)`);
    send(ws, { kind: 'hello', protocol: LOCAL_PROTOCOL_VERSION });

    ws.on('message', (data) => {
      void handleMessage(ws, data.toString(), deps);
    });
    ws.on('close', () => clients.delete(ws));
    ws.on('error', (err) => deps.log(`ws client error: ${errMsg(err)}`));
  });

  return new Promise<RunningHost>((resolve, reject) => {
    wss.on('error', reject);
    wss.on('listening', () => {
      const addr = wss.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      deps.log(`listening on ws://${LOOPBACK}:${boundPort}`);
      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((res) => {
            unsubscribe();
            for (const ws of clients) ws.close();
            wss.close(() => res());
          }),
      });
    });
  });
}

async function handleMessage(
  ws: WebSocket,
  raw: string,
  deps: HostServerDeps,
): Promise<void> {
  let msg: ClientMsg;
  try {
    msg = JSON.parse(raw) as ClientMsg;
  } catch (err) {
    deps.log(`bad frame: ${errMsg(err)}`);
    return;
  }

  if (msg.kind === 'command') {
    try {
      deps.applyCommand(msg.command);
    } catch (err) {
      deps.log(`command failed: ${errMsg(err)}`);
    }
    return;
  }

  if (msg.kind === 'rpc') {
    await handleRpc(ws, msg, deps);
    return;
  }

  deps.log(`unknown frame kind: ${String((msg as { kind?: unknown }).kind)}`);
}

async function handleRpc(
  ws: WebSocket,
  msg: Extract<ClientMsg, { kind: 'rpc' }>,
  deps: HostServerDeps,
): Promise<void> {
  try {
    const api = resolveApi(deps.apis, msg.api);
    // Allowlist enforcement: only invoke a method the API object OWNS. Never walk
    // the prototype chain — otherwise `method` values like 'constructor',
    // 'toString', 'valueOf' or 'hasOwnProperty' would resolve to inherited
    // Object.prototype builtins, pass the `typeof fn === 'function'` guard, and
    // be called with attacker-controlled args (an allowlist bypass). The bound
    // maps already use a null prototype, so this `own` check is the second,
    // explicit line of defence and also rejects '__proto__'/'prototype'.
    if (!Object.prototype.hasOwnProperty.call(api, msg.method)) {
      throw new Error(`unknown method: ${msg.api}.${msg.method}`);
    }
    const fn = api[msg.method];
    if (typeof fn !== 'function') {
      throw new Error(`unknown method: ${msg.api}.${msg.method}`);
    }
    const result = await fn(...msg.args);
    send(ws, { kind: 'rpc.ok', id: msg.id, result });
  } catch (err) {
    const error =
      err instanceof Error
        ? { message: err.message, name: err.name }
        : { message: String(err) };
    send(ws, { kind: 'rpc.err', id: msg.id, error });
  }
}

function resolveApi(
  apis: HostApis,
  name: LocalApi,
): Record<string, (...args: unknown[]) => unknown> {
  switch (name) {
    case 'projects':
      return apis.projects;
    case 'chats':
      return apis.chats;
    case 'runtimes':
      return apis.runtimes;
    case 'settings':
      return apis.settings;
    default: {
      const exhaustive: never = name;
      throw new Error(`unknown api: ${String(exhaustive)}`);
    }
  }
}

function broadcast(clients: Set<WebSocket>, frame: ServerMsg): void {
  const data = JSON.stringify(frame);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function send(ws: WebSocket, frame: ServerMsg): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
