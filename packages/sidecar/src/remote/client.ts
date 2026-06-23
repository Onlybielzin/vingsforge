/**
 * App-side remote runtime client (Spec 05 §4/§8): connects to the forge-daemon
 * over the SSH-tunneled WebSocket, re-emits EngineEvents to the app, dedupes by
 * per-connection event seq, and reconnects with exponential backoff. Permission
 * gating stays in the app, so it forwards `tool.permission.resolve` downstream.
 */
import { WebSocket } from 'ws';
import type {
  ChatMessage,
  DirEntry,
  EngineCommand,
  EngineEvent,
  RemoteRuntimeStatus,
} from '@vingsforge/shared';
import {
  decodeServerFrame,
  encodeFrame,
  type ClientFrame,
} from './protocol.js';
import { AUTH_SUBPROTOCOL } from './daemon.js';
import {
  HostKeyMismatchError,
  openSshTunnel,
  type HostKeyOptions,
  type SshTunnel,
} from './tunnel.js';
import type { RuntimeRecord } from '@vingsforge/persistence';

/** Tunables for reconnection backoff and heartbeats (Spec 05 §8). */
export interface RemoteClientOptions {
  /** First reconnect delay; doubles each attempt up to {@link maxBackoffMs}. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Heartbeat interval; a missed pong triggers a reconnect. */
  heartbeatMs?: number;
  /** Injectable tunnel opener (real ssh2 in prod, a stub in tests). */
  openTunnel?: (record: RuntimeRecord) => Promise<SshTunnel>;
  /**
   * Injectable WS factory (real `ws` in prod, a stub in tests). `protocols`
   * carries the daemon auth handshake (`[AUTH_SUBPROTOCOL, <token>]`, Spec 05
   * §2) and must be forwarded to the `WebSocket` constructor.
   */
  connectWs?: (url: string, protocols?: string[]) => WebSocket;
}

const DEFAULTS = {
  baseBackoffMs: 500,
  maxBackoffMs: 30_000,
  heartbeatMs: 15_000,
} as const;

/** Callbacks the host wires to surface remote state into the app. */
export interface RemoteClientHandlers {
  /** Forward an EngineEvent to the chat store's event bus (Spec 02 §5). */
  onEvent(event: EngineEvent): void;
  /**
   * Persist a completed assistant turn streamed by the daemon (Spec 05 §4): the
   * fully-assembled {@link ChatMessage} (text + thinking{signature} + tool_use),
   * NOT the lossy deltas, so the app's history stays API-valid and replayable.
   */
  onPersistAssistant?(message: ChatMessage): void;
  /** Persist the batched tool_result user turn streamed by the daemon (Spec 05 §4). */
  onPersistToolResults?(message: ChatMessage): void;
  /** Surface connection status changes for the UI indicator (Spec 05 RF-03). */
  onStatus(status: RemoteRuntimeStatus): void;
  /**
   * Persist the VPS host-key fingerprint pinned on first connect (TOFU), so
   * later reconnects verify against it (Spec 05 §2). Optional: tests omit it.
   */
  onPinHostKey?(fingerprint: string): void;
  /**
   * Surface a fatal connection error (e.g. host-key mismatch) to the UI so the
   * user sees why the tunnel was refused, instead of a silent reconnect loop.
   */
  onError?(message: string): void;
}

interface PendingRequest {
  resolve(entries: DirEntry[]): void;
  reject(err: Error): void;
}

/**
 * One connection to a single remote daemon. `connect()` opens the tunnel + WS;
 * the client auto-reconnects on drops until `disconnect()` is called. Engine
 * events are deduped by the daemon's per-connection `seq`, which the daemon
 * resets to 0 for every new {@link DaemonSession}; the client therefore resets
 * its `lastSeq` cursor on each (re)connect so frames from a fresh session — whose
 * seq restarts at 1 — are still delivered (Spec 05 §8).
 */
export class RemoteRuntimeClient {
  private ws: WebSocket | undefined;
  private tunnel: SshTunnel | undefined;
  private status: RemoteRuntimeStatus = 'offline';
  private closed = false;
  private attempt = 0;
  /**
   * Highest seq delivered to the app on the CURRENT connection — the dedupe
   * cursor. The daemon's `seq` is per-DaemonSession and restarts at 0 on every
   * new WS connection (daemon.ts), so this is reset in {@link onOpen}; otherwise
   * a stale (large) cursor would drop every frame from a post-reconnect session.
   */
  private lastSeq = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private pongSeen = true;
  private reqId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly opts: Required<Pick<RemoteClientOptions, 'baseBackoffMs' | 'maxBackoffMs' | 'heartbeatMs'>> &
    Pick<RemoteClientOptions, 'openTunnel' | 'connectWs'>;

  constructor(
    private readonly record: RuntimeRecord,
    private readonly handlers: RemoteClientHandlers,
    options: RemoteClientOptions = {},
  ) {
    this.opts = {
      baseBackoffMs: options.baseBackoffMs ?? DEFAULTS.baseBackoffMs,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULTS.maxBackoffMs,
      heartbeatMs: options.heartbeatMs ?? DEFAULTS.heartbeatMs,
      ...(options.openTunnel ? { openTunnel: options.openTunnel } : {}),
      ...(options.connectWs ? { connectWs: options.connectWs } : {}),
    };
  }

  /** Open the tunnel + WS and begin streaming (Spec 05 RF-03). Idempotent. */
  async connect(): Promise<void> {
    if (this.ws || this.closed) return;
    this.closed = false;
    await this.dial();
  }

  /** Tear down the connection and stop reconnecting (Spec 05 RF-08). */
  async disconnect(): Promise<void> {
    this.closed = true;
    this.clearTimers();
    this.ws?.removeAllListeners();
    this.ws?.close();
    this.ws = undefined;
    await this.tunnel?.close();
    this.tunnel = undefined;
    this.setStatus('offline');
    for (const [, p] of this.pending) p.reject(new Error('disconnected'));
    this.pending.clear();
  }

  /** Send an engine command to the daemon (Spec 05 §4). */
  sendCommand(command: EngineCommand): void {
    this.frame({ kind: 'command', command });
  }

  /** Forward an app permission decision to the daemon (gating stays in the app). */
  resolvePermission(
    chatId: string,
    callId: string,
    decision: 'allow' | 'deny',
    opts: { reason?: string; remember?: boolean } = {},
  ): void {
    const command: EngineCommand = { type: 'tool.permission.resolve', chatId, callId, decision };
    if (opts.reason !== undefined) command.reason = opts.reason;
    if (opts.remember !== undefined) command.remember = opts.remember;
    this.sendCommand(command);
  }

  /** List a directory on the VPS (Spec 05 §7 fsList). Rejects on transport error. */
  fsList(path: string): Promise<DirEntry[]> {
    return new Promise<DirEntry[]>((resolve, reject) => {
      if (!this.ws || this.status !== 'online') {
        reject(new Error('runtime is not connected'));
        return;
      }
      this.reqId += 1;
      const reqId = `r${this.reqId}`;
      this.pending.set(reqId, { resolve, reject });
      this.frame({ kind: 'fs.list', reqId, path });
    });
  }

  get currentStatus(): RemoteRuntimeStatus {
    return this.status;
  }

  // --- internals ------------------------------------------------------------

  private async dial(): Promise<void> {
    this.setStatus('connecting');
    try {
      const openTunnel =
        this.opts.openTunnel ??
        ((record: RuntimeRecord) =>
          defaultOpenTunnel(record, {
            ...(record.ssh.hostFingerprint !== undefined
              ? { expectedFingerprint: record.ssh.hostFingerprint }
              : {}),
            onPin: (fp) => this.handlers.onPinHostKey?.(fp),
          }));
      this.tunnel = await openTunnel(this.record);
      const url = `ws://127.0.0.1:${this.tunnel.localPort}`;
      // Present the per-runtime bearer token on the handshake (Spec 05 §2): the
      // daemon rejects the upgrade if it's absent/wrong, so loopback reach alone
      // can't drive it. Runtimes without a token (legacy/tests) connect plain.
      const protocols =
        this.record.authToken !== undefined
          ? [AUTH_SUBPROTOCOL, this.record.authToken]
          : undefined;
      const connect = this.opts.connectWs ?? ((u: string, p?: string[]) => new WebSocket(u, p));
      const ws = connect(url, protocols);
      this.ws = ws;
      ws.on('open', () => this.onOpen());
      ws.on('message', (data: Buffer) => this.onMessage(data.toString('utf8')));
      ws.on('close', () => this.onClose());
      ws.on('error', () => this.onClose());
    } catch (err) {
      // A host-key mismatch is fatal and likely an attack: stop the reconnect
      // loop and surface it, rather than retrying against the same bad host.
      if (err instanceof HostKeyMismatchError) {
        this.closed = true;
        this.clearTimers();
        this.handlers.onError?.(err.message);
        this.setStatus('error');
        return;
      }
      this.onClose();
    }
  }

  private onOpen(): void {
    this.attempt = 0;
    this.pongSeen = true;
    // The daemon opens a fresh DaemonSession with seq=0 for each connection, so
    // the dedupe cursor must restart too; a stale cursor from the prior
    // connection would suppress every frame of the new session (Spec 05 §8).
    this.lastSeq = 0;
    this.setStatus('online');
    this.startHeartbeat();
  }

  private onMessage(raw: string): void {
    let frame;
    try {
      frame = decodeServerFrame(raw);
    } catch {
      return; // ignore malformed frames
    }
    switch (frame.kind) {
      case 'event':
        // DEDUPE within a single connection: deliver only events past the
        // cursor, so a duplicate frame on the same session isn't re-applied. The
        // cursor is reset per-connection in onOpen because the daemon's seq
        // restarts at 0 on reconnect (Spec 05 §8).
        if (frame.seq > this.lastSeq) {
          this.lastSeq = frame.seq;
          this.handlers.onEvent(frame.event);
        }
        return;
      case 'persist.assistant':
        // Same per-connection seq-dedupe as events: a duplicate persist frame on
        // the same session must not write the turn twice. Carries the full
        // ChatMessage (Spec 05 §4).
        if (frame.seq > this.lastSeq) {
          this.lastSeq = frame.seq;
          this.handlers.onPersistAssistant?.(frame.message);
        }
        return;
      case 'persist.toolResults':
        if (frame.seq > this.lastSeq) {
          this.lastSeq = frame.seq;
          this.handlers.onPersistToolResults?.(frame.message);
        }
        return;
      case 'daemon.status':
        if (frame.seq > this.lastSeq) this.lastSeq = frame.seq;
        this.setStatus(frame.status);
        return;
      case 'fs.list.result': {
        this.pending.get(frame.reqId)?.resolve(frame.entries);
        this.pending.delete(frame.reqId);
        return;
      }
      case 'fs.list.error': {
        this.pending.get(frame.reqId)?.reject(new Error(frame.message));
        this.pending.delete(frame.reqId);
        return;
      }
      case 'pong':
        this.pongSeen = true;
        return;
      case 'daemon.health.result':
      case 'error':
        return;
      default: {
        const _exhaustive: never = frame;
        void _exhaustive;
      }
    }
  }

  private onClose(): void {
    this.clearTimers();
    this.ws?.removeAllListeners();
    this.ws = undefined;
    void this.tunnel?.close();
    this.tunnel = undefined;
    // The reqId counter and the daemon's per-session state are gone after a
    // drop, so no reply can ever arrive for in-flight requests; reject them
    // now instead of leaking the promises forever (mirrors disconnect()).
    for (const [, p] of this.pending) p.reject(new Error('connection lost'));
    this.pending.clear();
    if (this.closed) return;
    this.setStatus('connecting');
    this.scheduleReconnect();
  }

  /** Exponential backoff with a ceiling (Spec 05 §8). */
  private scheduleReconnect(): void {
    const delay = Math.min(
      this.opts.baseBackoffMs * 2 ** this.attempt,
      this.opts.maxBackoffMs,
    );
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      if (!this.closed) void this.dial();
    }, delay);
  }

  /** Heartbeat: ping each interval; a missed pong forces a reconnect. */
  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.pongSeen) {
        this.ws?.terminate();
        return;
      }
      this.pongSeen = false;
      this.frame({ kind: 'ping', ts: Date.now() });
    }, this.opts.heartbeatMs);
  }

  private frame(frame: ClientFrame): void {
    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(encodeFrame(frame));
    }
  }

  private setStatus(status: RemoteRuntimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatus(status);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearHeartbeat();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }
}

/** Default tunnel opener: SSH-forward to the daemon's loopback port on the VPS. */
async function defaultOpenTunnel(
  record: RuntimeRecord,
  hostKey: HostKeyOptions = {},
): Promise<SshTunnel> {
  // The daemon listens on loopback inside the VPS; we forward to it. The remote
  // daemon port is not in the runtime model, so v1 uses a fixed convention.
  return openSshTunnel(
    record.ssh,
    { daemonHost: '127.0.0.1', daemonPort: DAEMON_REMOTE_PORT },
    hostKey,
  );
}

/** Loopback port the forge-daemon binds on the VPS (Spec 05 §2 convention). */
export const DAEMON_REMOTE_PORT = 8717;
