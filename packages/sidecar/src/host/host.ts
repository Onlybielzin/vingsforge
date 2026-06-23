/**
 * Local sidecar host (entrypoint).
 *
 * Wires the REAL engine to the UI over a loopback WebSocket (see ./server.ts and
 * @vingsforge/shared `localproto`). It owns the singletons — SQLite DbStore,
 * SettingsStore (libsecret), ProjectManager, RemoteRuntimeStore, ChatStore — and
 * resolves the per-turn context + engine runner so `chats.send` runs a real turn
 * against the project's confined workspace, gating tools through the UI.
 *
 * Runs under plain `node` (tsc build, no bundler). Logs to stderr only and NEVER
 * logs the API key.
 */
import { pathToFileURL } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import {
  isKnownModel,
  type Chat,
  type EngineCommand,
  type EngineEvent,
  type ModelId,
  type PermissionModes,
  type PermissionPolicy,
} from '@vingsforge/shared';
import {
  createSqliteDbStore,
  defaultDbPath,
  type DbStore,
} from '@vingsforge/persistence';
import { ProjectManager } from '../projects/manager.js';
import { isLocalWorkspace } from '../projects/workspace-fs.js';
import { RemoteRuntimeStore } from '../remote/runtimes.js';
import {
  ChatStore,
  type ChatContext,
  type EngineTurnInput,
} from '../chats/store.js';
import { makeEngineRunner } from '../chats/engine-runner.js';
import {
  makeClaudeCliRunner,
  type ClaudeAuth,
} from './claude-cli-runner.js';
import { EngineMetaStore } from './engine-meta.js';
import { Updater, DEFAULT_REPO_DIR } from './updater.js';
import { SettingsStore } from '../settings/settings-store.js';
import { LibSecretStore } from '../settings/secret-store.js';
import { ANTHROPIC_API_KEY_REF } from '../settings/secret-store.js';
import { ToolExecutor } from '../tools/executors.js';
import { Workspace } from '../tools/workspace.js';
import type { LocalToolName } from '../tools/schemas.js';
import {
  maybeAskPermission,
  rememberAllow,
  type PermissionContext,
} from '../permissions/policy.js';
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
} from '../engine/prompt.js';
import type {
  GateDecision,
  ToolCall,
  ToolOutcome,
} from '../engine/engine.js';
import {
  PendingPermissions,
  startHostServer,
  toGateDecision,
  type HostApis,
  type RunningHost,
} from './server.js';
import { DEFAULT_SIDECAR_PORT, LOCAL_AUTH_TOKEN_ENV } from '@vingsforge/shared';

/** stderr-only logger. Never receives the API key. */
function log(message: string): void {
  process.stderr.write(`[vingsforge-host] ${message}\n`);
}

/** Base app system prompt prefixed to every turn (project text is appended). */
const BASE_SYSTEM_PROMPT = [
  'You are VingsForge, a desktop coding agent powered by Claude.',
  'You operate inside a single project workspace; all file and shell tools are',
  'confined to that workspace root. Be precise, prefer reading before editing,',
  'and explain destructive actions before running them.',
].join(' ');

/** The local executor only covers these tools (web_search is out of scope). */
const LOCAL_TOOLS = new Set<LocalToolName>([
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'write_file',
  'edit_file',
  'bash',
]);

/** Derive the permission context (path/command) the policy inspects from input. */
function permissionContext(input: unknown): PermissionContext {
  const ctx: PermissionContext = {};
  if (input && typeof input === 'object') {
    const rec = input as Record<string, unknown>;
    if (typeof rec.path === 'string') ctx.path = rec.path;
    if (typeof rec.command === 'string') ctx.command = rec.command;
  }
  return ctx;
}

/**
 * Bind every own/proto method of an API instance for dynamic RPC dispatch.
 *
 * The returned map has a NULL prototype (`Object.create(null)`): it must not
 * inherit `Object.prototype` builtins (`constructor`, `toString`, `valueOf`,
 * `hasOwnProperty`, …). Otherwise an RPC `method` of `'constructor'` etc. would
 * resolve to a builtin via the prototype chain and pass the dispatcher's
 * `typeof fn === 'function'` guard — an allowlist bypass reaching methods that
 * were never meant to be RPC-exposed. With a null prototype only the methods we
 * explicitly bind here are present, so the dispatch surface is exactly the
 * intended class methods.
 */
function bindApi(instance: object): Record<string, (...args: unknown[]) => unknown> {
  const out: Record<string, (...args: unknown[]) => unknown> =
    Object.create(null) as Record<string, (...args: unknown[]) => unknown>;
  let proto: object | null = instance;
  // Walk the prototype chain so class methods (defined on the prototype) bind too.
  while (proto && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const value = (instance as Record<string, unknown>)[name];
      if (
        typeof value === 'function' &&
        !Object.prototype.hasOwnProperty.call(out, name)
      ) {
        out[name] = (value as (...a: unknown[]) => unknown).bind(instance);
      }
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }
  return out;
}

/**
 * Build the whole host: open the DB, construct the stores, wire the engine
 * runner with permission gating, and start the loopback server.
 */
export async function createHost(opts?: {
  dbPath?: string;
  port?: number;
  /**
   * Per-launch shared secret every WS client must present (see server.ts). The
   * Tauri shell generates it, passes it via {@link LOCAL_AUTH_TOKEN_ENV}, and
   * injects the same value into the WebView. Defaults to that env var. Without a
   * token the host refuses every connection — loopback alone is not access control.
   */
  authToken?: string;
}): Promise<RunningHost> {
  const db: DbStore = createSqliteDbStore({ path: opts?.dbPath ?? defaultDbPath() });
  const secrets = new LibSecretStore();
  const settings = new SettingsStore({ db, secrets });
  const projects = new ProjectManager(db);
  const runtimes = new RemoteRuntimeStore({ db });

  // Pending permission gates + per-chat remembered allows (session scope).
  const pending = new PendingPermissions();
  const remembered = new Map<string, Set<string>>();

  // Caches the slash commands / skills the `claude` CLI advertises on init.
  const engineMeta = new EngineMetaStore();

  /** Apply remembered "always allow" tools onto a chat's effective policy. */
  function withRemembered(chatId: string, policy: PermissionPolicy): PermissionPolicy {
    let effective = policy;
    for (const tool of remembered.get(chatId) ?? []) {
      effective = rememberAllow(effective, tool);
    }
    return effective;
  }

  /**
   * Resolve the per-turn context for a chat: build the system prompt from the
   * base app prompt + the project's instructions, and apply the chat > project >
   * default precedence for model/runtime/effort/policy/modes.
   */
  function resolveContext(chat: Chat): ChatContext {
    const project = db.projects.get(chat.projectId);
    const systemParts = [BASE_SYSTEM_PROMPT];
    if (project?.systemPromptExtra) systemParts.push(project.systemPromptExtra);

    const model: ModelId =
      chat.modelOverride ?? project?.defaultModel ?? DEFAULT_MODEL;
    const runtimeId = chat.runtimeOverride ?? project?.runtimeId ?? 'local';
    const policy: PermissionPolicy = project?.permissionPolicy ?? { defaults: {} };

    const ctx: ChatContext = {
      system: systemParts.join('\n\n'),
      model: isKnownModel(model) ? model : DEFAULT_MODEL,
      runtimeId,
      effort: DEFAULT_EFFORT,
      policy,
      volatileContext: `Current date: ${new Date().toISOString().slice(0, 10)}.`,
    };
    return ctx;
  }

  /** Resolve the confined workspace for the chat's project (local only here). */
  function workspaceFor(chatId: string): Workspace {
    const chat = db.chats.get(chatId);
    if (!chat) throw new Error(`chat not found: ${chatId}`);
    const project = db.projects.get(chat.projectId);
    if (!project) throw new Error(`project not found: ${chat.projectId}`);
    if (!isLocalWorkspace(project.workspace)) {
      throw new Error('remote workspaces are routed through the daemon, not the local host');
    }
    return new Workspace(project.workspace.path);
  }

  /**
   * The engine runner. Builds a per-turn Anthropic client from the stored API
   * key; if absent it emits an `error` EngineEvent and ends the turn cleanly
   * instead of crashing the host. Gates tools through the UI and executes them
   * against the project's confined workspace.
   */
  const runEngineTurn = makeEngineRunner(async (input: EngineTurnInput) => {
    const apiKey = await secrets.get(ANTHROPIC_API_KEY_REF);
    const policy = withRemembered(input.chatId, input.policy ?? { defaults: {} });
    const modes: PermissionModes = input.modes ?? {};
    const workspace = workspaceFor(input.chatId);
    const executor = new ToolExecutor(workspace);

    // No key: a client whose first stream throws a typed, key-free error. The
    // engine surfaces it as an `error` EngineEvent and ends the turn (Spec 03),
    // so onboarding can prompt for a key without the host going down.
    const client = apiKey
      ? (new Anthropic({ apiKey }) as unknown as import('../engine/client.js').AnthropicLike)
      : missingKeyClient();

    const gate = (call: ToolCall, signal: AbortSignal): Promise<GateDecision> =>
      runGate(input.chatId, call, signal, policy, modes, workspace);

    const executeTool = async (call: ToolCall): Promise<ToolOutcome> => {
      if (!LOCAL_TOOLS.has(call.tool as LocalToolName)) {
        return { output: { error: `unknown tool: ${call.tool}` }, isError: true };
      }
      const result = await executor.execute(call.tool as LocalToolName, call.input);
      return { output: result.output, isError: result.isError };
    };

    return { client, gate, executeTool };
  });

  /** Gate a single tool call, forwarding genuine `ask` outcomes to the UI. */
  function runGate(
    chatId: string,
    call: ToolCall,
    signal: AbortSignal,
    policy: PermissionPolicy,
    modes: PermissionModes,
    workspace: Workspace,
  ): Promise<GateDecision> {
    if (signal.aborted) {
      return Promise.resolve({ allow: false, reason: 'interrupted' });
    }
    const outcome = maybeAskPermission({
      policy,
      chatId,
      callId: call.callId,
      tool: call.tool,
      input: call.input,
      context: permissionContext(call.input),
      modes,
      workspace,
    });
    if (outcome.kind === 'allow') return Promise.resolve({ allow: true });
    if (outcome.kind === 'deny') {
      return Promise.resolve({ allow: false, reason: outcome.reason });
    }
    // `ask`: emit the tool.permission event and block until the UI resolves it.
    emitEvent(outcome.event);
    return pending.await(chatId, call.callId, signal).then((resolution) => {
      if (resolution.decision === 'allow' && resolution.remember) {
        const set = remembered.get(chatId) ?? new Set<string>();
        set.add(call.tool);
        remembered.set(chatId, set);
      }
      return toGateDecision(resolution);
    });
  }

  /**
   * The CLAUDE CLI engine runner (subscription motor). Drives the logged-in
   * `claude` CLI so turns run on the machine's Claude subscription WITHOUT an API
   * key — the same approach OpenCovibe/Nimbalyst use. Resolves the chat's
   * confined workspace root for `cwd`/`--add-dir`, and picks the auth mode:
   *
   *  - default `'plan'` — use the logged-in subscription (no key in the child env);
   *  - `'apiKey'` — only when `VINGSFORGE_AUTH_MODE=apiKey` AND a key is stored,
   *    injecting it into the child env (never logged).
   *
   * Continuity (per-chat `--resume`) is owned inside the runner via its session map.
   */
  const claudeCliRunner = makeClaudeCliRunner({
    resolveWorkspaceRoot: (input) => workspaceFor(input.chatId).root,
    resolveAuth: async (): Promise<ClaudeAuth> => {
      // The user's chosen mode (Settings) is authoritative; the env var stays a
      // last-resort override for headless/dev runs.
      const { authMode } = await settings.get();
      const preferApiKey =
        authMode === 'apiKey' || process.env.VINGSFORGE_AUTH_MODE === 'apiKey';
      if (preferApiKey) {
        const apiKey = await secrets.get(ANTHROPIC_API_KEY_REF);
        if (apiKey) return { authMode: 'apiKey', apiKey };
        // Fall back to the subscription if no key is configured.
      }
      return { authMode: 'plan' };
    },
    // Cache the CLI's advertised slash commands / skills for the EngineMetaAPI.
    onMeta: (meta) => engineMeta.set(meta),
    log,
  });

  /**
   * Which runner the ChatStore drives. The CLAUDE CLI motor is the default
   * (subscription auth, no API key). Set `VINGSFORGE_ENGINE=sdk` to use the
   * in-process Anthropic SDK engine instead (kept intact for tests/parity).
   */
  const useSdkEngine = process.env.VINGSFORGE_ENGINE === 'sdk';
  const selectedRunner = useSdkEngine ? runEngineTurn : claudeCliRunner;
  log(`engine runner: ${useSdkEngine ? 'sdk' : 'claude-cli'}`);

  const chatStore = new ChatStore({
    db,
    resolveContext,
    runEngineTurn: selectedRunner,
    // Import of terminal-created sessions delegates transcript I/O (and its
    // ~/.claude/projects confinement) to the ProjectManager, so the store stays
    // fs-free.
    loadSessionTranscript: (projectId, sessionId) =>
      projects.readSessionTranscript(projectId, sessionId),
  });

  // Single event bus: chat-store events fan out to connected UI clients.
  const listeners = new Set<(event: EngineEvent) => void>();
  function emitEvent(event: EngineEvent): void {
    for (const l of listeners) l(event);
  }
  chatStore.onEvent(emitEvent);

  // In-app git auto-updater. The repo dir comes from Settings (validated inside
  // the Updater); progress streams to the UI as update.log / update.done events.
  const updater = new Updater({
    resolveRepoDir: async () => {
      const { repoDir } = await settings.get();
      return repoDir && repoDir.trim().length > 0 ? repoDir : DEFAULT_REPO_DIR;
    },
    emit: emitEvent,
    log,
  });

  // Apply UI commands: interrupt a turn, or resolve a pending permission gate.
  function applyCommand(command: EngineCommand): void {
    switch (command.type) {
      case 'engine.interrupt':
        void chatStore.interrupt(command.chatId);
        return;
      case 'tool.permission.resolve':
        pending.resolve(command.chatId, command.callId, {
          decision: command.decision,
          ...(command.reason !== undefined ? { reason: command.reason } : {}),
          ...(command.remember !== undefined ? { remember: command.remember } : {}),
        });
        return;
      case 'engine.send':
        // A turn is started via the chats.send RPC (it persists the user turn
        // and streams events); engine.send over the command channel is ignored.
        return;
      default: {
        const exhaustive: never = command;
        void exhaustive;
      }
    }
  }

  const apis: HostApis = {
    projects: bindApi(projects),
    chats: bindApi(chatStore),
    runtimes: bindApi(runtimes),
    settings: bindApi(settings),
    meta: bindApi(engineMeta),
    update: bindApi(updater),
  };
  const port = opts?.port ?? (Number(process.env.PORT) || DEFAULT_SIDECAR_PORT);
  const authToken = opts?.authToken ?? process.env[LOCAL_AUTH_TOKEN_ENV];
  if (authToken === undefined || authToken === '') {
    // Fail closed: a host with no token would accept any local process. Refuse to
    // start rather than serve an unauthenticated engine.
    throw new Error(
      `refusing to start: ${LOCAL_AUTH_TOKEN_ENV} is not set — the loopback host ` +
        'requires a per-launch token (any local process can otherwise drive the engine)',
    );
  }
  return startHostServer(
    {
      authToken,
      apis,
      onEngineEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      applyCommand,
      log,
    },
    port,
  );
}

/**
 * A stand-in Anthropic client used when no API key is configured: its stream
 * throws a typed, key-free error so the engine emits a clear `error` EngineEvent
 * (and the host stays up). Never carries or logs a key.
 */
function missingKeyClient(): import('../engine/client.js').AnthropicLike {
  const message =
    'No Anthropic API key configured. Add one in Settings before sending a message.';
  return {
    messages: {
      stream() {
        const err = new Error(message);
        const stream: import('../engine/client.js').MessageStreamLike = {
          [Symbol.asyncIterator](): AsyncIterator<never> {
            return { next: () => Promise.reject(err) };
          },
          finalMessage: () => Promise.reject(err),
          abort: () => undefined,
        };
        return stream;
      },
    },
  };
}

// Run when executed directly (node dist/host/host.js), not when imported.
// Use pathToFileURL so paths with spaces / non-ASCII (e.g. "Área de trabalho")
// percent-encode the same way import.meta.url does — a bare `file://${argv[1]}`
// never matches such paths and the host would silently never start.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createHost().catch((err: unknown) => {
    log(`failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
