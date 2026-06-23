/**
 * Real IpcClient backed by the local sidecar WebSocket (Spec 06 §7, Spec 00 §5).
 *
 * Speaks the loopback {@link import('@vingsforge/shared').ClientMsg}/`ServerMsg`
 * protocol from `@vingsforge/shared/localproto`:
 *
 *  - the four request/response APIs (projects/chats/runtimes/settings) become
 *    `{kind:'rpc', api, method, args}` frames, correlated by id; `rpc.ok` resolves
 *    and `rpc.err` rejects with an Error;
 *  - `engine.onEvent` registers a listener fed by pushed `{kind:'event'}` frames;
 *  - `engine.send` (engine.interrupt + tool.permission.resolve) ships a
 *    `{kind:'command'}` frame. Turn `send` is a `chats.send` RPC whose stream
 *    arrives via the event channel.
 *
 * The socket auto-reconnects with backoff; RPCs and commands issued while the
 * socket is down queue and flush on (re)connect. Mirrors the exact
 * {@link IpcClient} interface so components never see the transport.
 */
import {
  DEFAULT_SIDECAR_PORT,
  LOCAL_AUTH_SUBPROTOCOL,
  LOCAL_AUTH_TOKEN_GLOBAL,
  type ClientMsg,
  type EngineCommand,
  type EngineEvent,
  type LocalApi,
  type ServerMsg,
} from '@vingsforge/shared';
import type {
  ChatsAPI,
  ProjectsAPI,
  RuntimesAPI,
  SettingsAPI,
} from '@vingsforge/shared';
import type { EngineChannel, IpcClient, Unsubscribe } from './client.js';

/** Options for {@link createRealIpcClient}. */
export interface RealIpcOptions {
  /** Full ws:// URL to the sidecar host. Defaults to loopback on the shared port. */
  url?: string;
  /** Reconnect backoff ceiling in ms (default 5000). */
  maxBackoffMs?: number;
  /** Optional WebSocket constructor (testing); defaults to the global. */
  WebSocketImpl?: typeof WebSocket;
  /**
   * Per-launch shared secret the host requires on the WS handshake. Defaults to the
   * value the Tauri shell injects on `globalThis` ({@link LOCAL_AUTH_TOKEN_GLOBAL}).
   * Presented as `Sec-WebSocket-Protocol: ['vingsforge.local.v1', '<token>']`; the
   * host 401s the upgrade without it, so loopback reach alone cannot drive the engine.
   */
  authToken?: string;
}

/** Default loopback URL — never the page origin, the sidecar always binds 127.0.0.1. */
function defaultUrl(): string {
  return `ws://127.0.0.1:${DEFAULT_SIDECAR_PORT}`;
}

/** Read the token the Tauri shell injected into the WebView (undefined outside it). */
function injectedToken(): string | undefined {
  const value = (globalThis as Record<string, unknown>)[LOCAL_AUTH_TOKEN_GLOBAL];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * Owns the socket lifecycle, the pending-RPC map and the event listener set.
 * One instance backs a single {@link IpcClient}.
 */
class SidecarConnection {
  private readonly url: string;
  private readonly maxBackoffMs: number;
  private readonly WS: typeof WebSocket;
  /** WS subprotocols presenting the auth token, or undefined when none is available. */
  private readonly protocols: string[] | undefined;

  private socket: WebSocket | null = null;
  private closed = false;
  private backoff = 250;
  private nextId = 0;

  private readonly pending = new Map<string, PendingRpc>();
  /** Frames queued while the socket is not OPEN; flushed on connect. */
  private readonly outbox: string[] = [];
  private readonly listeners = new Set<(event: EngineEvent) => void>();

  constructor(opts: RealIpcOptions) {
    this.url = opts.url ?? defaultUrl();
    this.maxBackoffMs = opts.maxBackoffMs ?? 5000;
    this.WS = opts.WebSocketImpl ?? WebSocket;
    const token = opts.authToken ?? injectedToken();
    this.protocols = token !== undefined ? [LOCAL_AUTH_SUBPROTOCOL, token] : undefined;
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    let socket: WebSocket;
    try {
      socket =
        this.protocols !== undefined
          ? new this.WS(this.url, this.protocols)
          : new this.WS(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = (): void => {
      this.backoff = 250;
      this.flushOutbox();
    };
    socket.onmessage = (ev: MessageEvent): void => {
      this.handleMessage(ev.data);
    };
    socket.onclose = (): void => {
      if (this.socket === socket) this.socket = null;
      this.scheduleReconnect();
    };
    socket.onerror = (): void => {
      // Surfaced as a close; nothing to do here but avoid an unhandled error.
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.maxBackoffMs);
    setTimeout(() => this.connect(), delay);
  }

  private flushOutbox(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== this.WS.OPEN) return;
    while (this.outbox.length > 0) {
      const frame = this.outbox.shift()!;
      socket.send(frame);
    }
  }

  private send(msg: ClientMsg): void {
    const frame = JSON.stringify(msg);
    const socket = this.socket;
    if (socket && socket.readyState === this.WS.OPEN) {
      socket.send(frame);
    } else {
      this.outbox.push(frame);
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let msg: ServerMsg;
    try {
      msg = JSON.parse(data) as ServerMsg;
    } catch {
      return;
    }
    switch (msg.kind) {
      case 'hello':
        // Protocol handshake; nothing to assert here beyond receiving it.
        return;
      case 'rpc.ok': {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          p.resolve(msg.result);
        }
        return;
      }
      case 'rpc.err': {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          const err = new Error(msg.error.message);
          if (msg.error.name) err.name = msg.error.name;
          p.reject(err);
        }
        return;
      }
      case 'event': {
        for (const l of this.listeners) l(msg.event);
        return;
      }
    }
  }

  /** Issues an RPC and resolves with the host's serialized result. */
  rpc(api: LocalApi, method: string, args: unknown[]): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('IPC client closed'));
    const id = `${(this.nextId += 1)}`;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ kind: 'rpc', id, api, method, args });
    });
  }

  /** Pushes a command to the engine (interrupt / permission resolve). */
  command(command: EngineCommand): void {
    this.send({ kind: 'command', command });
  }

  onEvent(listener: (event: EngineEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new Error('IPC client closed'));
    this.pending.clear();
    this.outbox.length = 0;
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already closing */
      }
      this.socket = null;
    }
  }
}

/**
 * Builds a typed RPC proxy for one API. Every method on the interface forwards
 * its arguments verbatim through the socket as an `{kind:'rpc'}` frame.
 */
function rpcApi<T>(conn: SidecarConnection, api: LocalApi): T {
  return new Proxy(
    {},
    {
      get(_target, method: string | symbol) {
        if (typeof method !== 'string') return undefined;
        return (...args: unknown[]): Promise<unknown> => conn.rpc(api, method, args);
      },
    },
  ) as T;
}

/** A real {@link IpcClient} plus a `close()` to tear the socket down. */
export interface RealIpcClient extends IpcClient {
  /** Closes the socket and rejects any in-flight RPCs. */
  close(): void;
}

/**
 * Creates a real {@link IpcClient} that talks to the sidecar host over the local
 * WebSocket protocol. Connects lazily/asynchronously; calls made before the
 * socket is open queue and flush on connect.
 */
export function createRealIpcClient(opts: RealIpcOptions = {}): RealIpcClient {
  const conn = new SidecarConnection(opts);

  const engine: EngineChannel = {
    onEvent: (listener) => conn.onEvent(listener),
    send: async (command) => {
      conn.command(command);
    },
  };

  return {
    engine,
    projects: rpcApi<ProjectsAPI>(conn, 'projects'),
    chats: rpcApi<ChatsAPI>(conn, 'chats'),
    runtimes: rpcApi<RuntimesAPI>(conn, 'runtimes'),
    settings: rpcApi<SettingsAPI>(conn, 'settings'),
    close: () => conn.close(),
  };
}
