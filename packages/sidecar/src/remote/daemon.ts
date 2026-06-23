/**
 * forge-daemon (Spec 05 §4): the headless engine over WebSocket. Accepts the
 * shared EngineCommand contract, runs the agentic loop against the VPS FS/shell,
 * and streams id-tagged EngineEvents back — permission gating stays in the app,
 * so the daemon emits `tool.permission` and blocks on a `tool.permission.resolve`.
 */
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { EngineEvent, EngineSendContext, PermissionPolicy } from '@vingsforge/shared';
import { Engine, type GateDecision, type ToolCall, type ToolOutcome } from '../engine/engine.js';
import type { AnthropicLike } from '../engine/client.js';
import { Workspace } from '../tools/workspace.js';
import { ToolExecutor } from '../tools/executors.js';
import type { LocalToolName } from '../tools/schemas.js';
import {
  maybeAskPermission,
  type PermissionContext,
  type PermissionModes,
} from '../permissions/policy.js';
import {
  PROTOCOL_VERSION,
  decodeClientFrame,
  encodeFrame,
  type ServerFrame,
} from './protocol.js';

/**
 * How a turn is assembled on the daemon side. This is exactly the per-turn
 * {@link EngineSendContext} the app ships on each `engine.send` (Spec 05 §4):
 * system + history + model/effort/maxTokens + volatileContext, plus the chat's
 * effective permission `policy`/`modes` so the daemon enforces deny rules and
 * per-tool defaults server-side (Spec 05 §5 — "reforçar confinamento ... no
 * daemon"). `policy` is omitted only in trusted/test setups, where it falls back
 * to an ask-everything policy so behaviour is unchanged.
 */
export type DaemonTurnContext = EngineSendContext;

/** Collaborators the daemon needs (all injectable for tests / different hosts). */
export interface DaemonDeps {
  /** Anthropic client used when the API key lives on the VPS (Spec 05 §2). */
  client: AnthropicLike;
  /**
   * The daemon is stateless on history (Spec 05 §4): the app ships the context
   * for each `engine.send`. This resolves the system prompt + prior turns for a
   * chat id at send time.
   */
  resolveTurnContext(chatId: string): DaemonTurnContext | Promise<DaemonTurnContext>;
  /** Absolute path of the remote workspace root tools are confined to (Spec 05 §5). */
  workspaceRoot: string;
  /**
   * Per-runtime shared secret the app must present on the WS handshake (Spec 05
   * §2). The daemon rejects any connection that doesn't carry it BEFORE creating
   * a {@link DaemonSession}, so binding to loopback is not the only access
   * control: a co-tenant who can open the socket still can't drive the daemon.
   * Omit ONLY in trusted/test setups — an undefined token disables the check.
   */
  authToken?: string;
}

/**
 * WS subprotocol scheme that carries the bearer token on the handshake: the app
 * offers `['vingsforge.v1', '<token>']` as `Sec-WebSocket-Protocol`; the daemon
 * compares the second entry against {@link DaemonDeps.authToken}. Using the
 * subprotocol header keeps auth in the WS upgrade itself — rejected before any
 * command/fs frame is ever processed.
 */
export const AUTH_SUBPROTOCOL = 'vingsforge.v1';

/** Constant-time compare of the presented token against the expected one. */
function tokenMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Fallback policy when {@link DaemonTurnContext.policy} is omitted (trusted/test
 * setups): no rules/defaults, so writes/bash resolve to the global `ask` default
 * and read-only tools still auto-run — i.e. the prior "ask the app" behaviour.
 */
const ASK_EVERYTHING_POLICY: PermissionPolicy = { defaults: {} };

/**
 * Derive the {@link PermissionContext} the policy inspects (path / shell command)
 * from a tool's raw input, so `pathGlob` / `commandRegex` deny rules match the
 * same value the executor acts on. Matches the local engine's gate wiring.
 */
function permissionContext(input: unknown): PermissionContext {
  const ctx: PermissionContext = {};
  if (input && typeof input === 'object') {
    const rec = input as Record<string, unknown>;
    if (typeof rec.path === 'string') ctx.path = rec.path;
    if (typeof rec.command === 'string') ctx.command = rec.command;
  }
  return ctx;
}

const TOOL_NAMES = new Set<LocalToolName>([
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'write_file',
  'edit_file',
  'bash',
]);

/**
 * A single connected app session. Owns the per-connection event sequence, the
 * map of pending permission gates (resolved by app frames), and the in-flight
 * turn controllers so an `engine.interrupt` can abort the right run.
 */
class DaemonSession {
  private seq = 0;
  private readonly pendingGates = new Map<string, (d: GateDecision) => void>();
  private readonly inFlight = new Map<string, AbortController>();
  private readonly workspace: Workspace;
  private readonly executor: ToolExecutor;

  constructor(
    private readonly ws: WebSocket,
    private readonly deps: DaemonDeps,
  ) {
    this.workspace = new Workspace(deps.workspaceRoot);
    this.executor = new ToolExecutor(this.workspace);
    this.send({ kind: 'daemon.status', seq: this.nextSeq(), status: 'online' });
  }

  /** Route one decoded app→daemon frame. */
  async handle(raw: string): Promise<void> {
    let frame;
    try {
      frame = decodeClientFrame(raw);
    } catch (err) {
      this.send({ kind: 'error', message: `bad frame: ${errMsg(err)}` });
      return;
    }
    switch (frame.kind) {
      case 'ping':
        this.send({ kind: 'pong', ts: frame.ts });
        return;
      case 'daemon.health':
        this.send({
          kind: 'daemon.health.result',
          reqId: frame.reqId,
          protocol: PROTOCOL_VERSION,
        });
        return;
      case 'fs.list':
        await this.fsList(frame.reqId, frame.path);
        return;
      case 'command':
        await this.command(frame.command);
        return;
      default: {
        const _exhaustive: never = frame;
        void _exhaustive;
      }
    }
  }

  /** Resolve a pending gate / abort an in-flight run / start a new turn. */
  private async command(command: import('@vingsforge/shared').EngineCommand): Promise<void> {
    if (command.type === 'tool.permission.resolve') {
      const resolve = this.pendingGates.get(command.callId);
      if (resolve) {
        this.pendingGates.delete(command.callId);
        resolve(
          command.decision === 'allow'
            ? { allow: true }
            : { allow: false, reason: command.reason ?? 'denied by user' },
        );
      }
      return;
    }
    if (command.type === 'engine.interrupt') {
      this.inFlight.get(command.chatId)?.abort();
      return;
    }
    // engine.send: run a turn against the VPS runtime.
    await this.runTurn(command.chatId, command.text, command.context);
  }

  private async runTurn(
    chatId: string,
    userText: string,
    shipped: EngineSendContext | undefined,
  ): Promise<void> {
    if (this.inFlight.has(chatId)) {
      this.emit({ type: 'error', chatId, message: 'a turn is already running' });
      return;
    }
    const controller = new AbortController();
    this.inFlight.set(chatId, controller);
    try {
      // The daemon is stateless (Spec 05 §4): when the app ships the per-turn
      // context on `engine.send`, use it verbatim — system/history/policy/modes
      // are the app's source of truth. Only fall back to `resolveTurnContext`
      // for trusted/test setups that drive the daemon without shipped context.
      const ctx: DaemonTurnContext = shipped ?? (await this.deps.resolveTurnContext(chatId));
      const policy = ctx.policy ?? ASK_EVERYTHING_POLICY;
      const modes = ctx.modes ?? {};
      const engine = new Engine({
        client: this.deps.client,
        gate: (call, signal) => this.gate(chatId, call, signal, policy, modes),
        executeTool: (call, signal) => this.executeTool(call, signal),
        // The app is the source of truth for history (Spec 05 §4): stream each
        // fully-assembled turn — text + thinking{signature} + tool_use/tool_result
        // — back so the app persists an API-valid, replayable thread. Streaming
        // only the `*.delta` events would drop signatures and tool pairing and
        // 400 on the next turn (Spec 05 acceptance #4).
        persistAssistant: (_id, message) =>
          this.send({ kind: 'persist.assistant', seq: this.nextSeq(), message }),
        persistToolResults: (_id, message) =>
          this.send({ kind: 'persist.toolResults', seq: this.nextSeq(), message }),
      });
      const params: import('../engine/engine.js').RunTurnParams = {
        chatId,
        system: ctx.system,
        history: ctx.history,
        userText,
        controller,
      };
      if (ctx.model !== undefined) params.model = ctx.model;
      if (ctx.effort !== undefined) params.effort = ctx.effort;
      if (ctx.maxTokens !== undefined) params.maxTokens = ctx.maxTokens;
      if (ctx.volatileContext !== undefined) params.volatileContext = ctx.volatileContext;
      await engine.runTurn(params, (event) => this.emit(event));
    } catch (err) {
      this.emit({ type: 'error', chatId, message: errMsg(err) });
    } finally {
      if (this.inFlight.get(chatId) === controller) this.inFlight.delete(chatId);
    }
  }

  /**
   * Gate a tool call against the chat's permission policy ON THE DAEMON (Spec 05
   * §5 — "reforçar confinamento ... no daemon"), mirroring the local engine:
   *
   * - `allow` (incl. read-only tools / auto-approve) runs immediately;
   * - `deny` (project deny rule or read-only hard override) is refused here and
   *   never reaches the app — the daemon must not execute a denied tool;
   * - only a genuine `ask` is forwarded to the UI as `tool.permission` and blocks
   *   until the app resolves it (or the run is interrupted).
   */
  private gate(
    chatId: string,
    call: ToolCall,
    signal: AbortSignal,
    policy: PermissionPolicy,
    modes: PermissionModes,
  ): Promise<GateDecision> {
    return new Promise<GateDecision>((resolve) => {
      if (signal.aborted) {
        resolve({ allow: false, reason: 'interrupted' });
        return;
      }

      const outcome = maybeAskPermission({
        policy,
        chatId,
        callId: call.callId,
        tool: call.tool,
        input: call.input,
        context: permissionContext(call.input),
        modes,
        workspace: this.workspace,
      });
      if (outcome.kind === 'allow') {
        resolve({ allow: true });
        return;
      }
      if (outcome.kind === 'deny') {
        resolve({ allow: false, reason: outcome.reason });
        return;
      }

      // `ask`: the app stays the resolver (Spec 05 §5) — block until it answers.
      this.pendingGates.set(call.callId, resolve);
      const onAbort = (): void => {
        if (this.pendingGates.delete(call.callId)) {
          resolve({ allow: false, reason: 'interrupted' });
        }
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.emit(outcome.event);
    });
  }

  /** Execute an allowed tool against the VPS workspace (Spec 05 §5). */
  private async executeTool(call: ToolCall, _signal: AbortSignal): Promise<ToolOutcome> {
    if (!TOOL_NAMES.has(call.tool as LocalToolName)) {
      return { output: { error: `unknown tool: ${call.tool}` }, isError: true };
    }
    const result = await this.executor.execute(call.tool as LocalToolName, call.input);
    return { output: result.output, isError: result.isError };
  }

  private async fsList(reqId: string, path: string): Promise<void> {
    try {
      const workspace = new Workspace(this.deps.workspaceRoot);
      const executor = new ToolExecutor(workspace);
      const out = (await executor.execute('list_dir', { path })) as {
        output: { path: string; entries: { name: string; kind: 'file' | 'dir' | 'symlink'; size?: number }[] };
        isError: boolean;
      };
      if (out.isError) {
        this.send({ kind: 'fs.list.error', reqId, message: 'list failed' });
        return;
      }
      const base = out.output.path;
      const entries = out.output.entries.map((e) => {
        const entry: import('@vingsforge/shared').DirEntry = {
          name: e.name,
          path: `${base.replace(/\/$/, '')}/${e.name}`,
          kind: e.kind,
        };
        if (e.size !== undefined) entry.size = e.size;
        return entry;
      });
      this.send({ kind: 'fs.list.result', reqId, entries });
    } catch (err) {
      this.send({ kind: 'fs.list.error', reqId, message: errMsg(err) });
    }
  }

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private emit(event: EngineEvent): void {
    this.send({ kind: 'event', seq: this.nextSeq(), event });
  }

  private send(frame: ServerFrame): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(encodeFrame(frame));
  }
}

/** A running daemon instance with a close handle. */
export interface ForgeDaemon {
  /** The bound TCP port (useful when started on port 0 for tests). */
  readonly port: number;
  /**
   * Forcibly terminate all currently-connected sessions without stopping the
   * server, so a dropped client reconnects into a fresh {@link DaemonSession}
   * (seq back to 0). Used to exercise reconnect resilience (Spec 05 §8).
   */
  dropConnections(): void;
  close(): Promise<void>;
}

/**
 * Read the bearer token off the handshake's `Sec-WebSocket-Protocol` header. The
 * app offers `vingsforge.v1, <token>`; we return the token (second entry). Loopback
 * binding is NOT a trust boundary on a shared host (Spec 05 §2), so this is the
 * real access control.
 */
function tokenFromHeader(header: string | string[] | undefined): string | undefined {
  if (header === undefined) return undefined;
  const raw = Array.isArray(header) ? header.join(',') : header;
  const parts = raw.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  const schemeAt = parts.indexOf(AUTH_SUBPROTOCOL);
  if (schemeAt === -1) return undefined;
  return parts[schemeAt + 1];
}

/**
 * Start the forge-daemon WebSocket server (Spec 05 §4). It listens on
 * `127.0.0.1:<port>` only — exposure to the app is via the SSH tunnel, never a
 * public port (Spec 05 §2). A per-runtime bearer token ({@link DaemonDeps.authToken})
 * is required on the handshake and rejected before any session/command runs;
 * loopback alone is not the access control. Each accepted connection gets its
 * own {@link DaemonSession}.
 */
export function startForgeDaemon(
  deps: DaemonDeps,
  opts: { port?: number; host?: string } = {},
): Promise<ForgeDaemon> {
  const wss = new WebSocketServer({
    port: opts.port ?? 0,
    host: opts.host ?? '127.0.0.1',
    // Reject unauthenticated upgrades at the WS layer, before `connection` fires
    // — no DaemonSession is created and no command/fs frame is ever processed.
    verifyClient: (info: { req: { headers: Record<string, string | string[] | undefined> } }) => {
      if (deps.authToken === undefined) return true;
      const presented = tokenFromHeader(info.req.headers['sec-websocket-protocol']);
      return tokenMatches(deps.authToken, presented);
    },
    // Echo the auth scheme as the negotiated subprotocol (never the token) so the
    // browser/`ws` client completes the handshake.
    handleProtocols: (protocols) =>
      protocols.has(AUTH_SUBPROTOCOL) ? AUTH_SUBPROTOCOL : false,
  });

  wss.on('connection', (ws) => {
    const session = new DaemonSession(ws, deps);
    ws.on('message', (data: Buffer) => {
      void session.handle(data.toString('utf8'));
    });
  });

  return new Promise<ForgeDaemon>((resolve, reject) => {
    wss.on('error', reject);
    wss.on('listening', () => {
      const address = wss.address();
      const port = typeof address === 'object' && address ? address.port : (opts.port ?? 0);
      resolve({
        port,
        dropConnections: () => {
          for (const client of wss.clients) client.terminate();
        },
        close: () =>
          new Promise<void>((res) => {
            for (const client of wss.clients) client.terminate();
            wss.close(() => res());
          }),
      });
    });
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
