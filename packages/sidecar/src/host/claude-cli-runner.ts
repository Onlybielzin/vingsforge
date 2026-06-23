/**
 * Claude Code CLI engine runner (subscription-auth motor).
 *
 * Drives the logged-in `claude` CLI (`-p --output-format stream-json`) as the
 * turn engine instead of the Anthropic SDK. This lets VingsForge run on the
 * machine's CLAUDE SUBSCRIPTION (the user's `claude login`) WITHOUT an API key —
 * the same approach OpenCovibe / Nimbalyst use. When `apiKeySource` in the CLI's
 * `system/init` event is `"none"`, the turn ran on the logged-in subscription.
 *
 * It exposes the SAME shape the ChatStore expects for `runEngineTurn`:
 *   (input: EngineTurnInput, emit: (e: EngineEvent) => void) => Promise<TurnResult>
 *
 * so the host can swap this in for the SDK-backed `makeEngineRunner` without the
 * store knowing the difference. The Engine SDK path stays in the codebase; this
 * is just an alternate runner the host selects.
 *
 * Stream mapping (NDJSON, one event per line — captured from claude-opus-4-8):
 *   system/init               -> capture session_id (+ apiKeySource) for --resume
 *   system/hook_*             -> ignored
 *   assistant.message.content -> text  -> message.delta + persisted text block
 *                                thinking -> thinking.delta + persisted thinking block
 *                                tool_use -> tool.start + persisted tool_use block
 *   user.message.tool_result  -> tool.result + persisted tool_result block
 *   rate_limit_event          -> ignored (logged at debug)
 *   result                    -> turn.end + Usage; ends the turn
 *
 * Persistence mirrors the SDK engine: one assistant turn per `assistant` message
 * (text/thinking/tool_use blocks) via `persistAssistant`, and one user turn per
 * `user` message carrying the batched `tool_result` blocks via
 * `persistToolResults`, so the stored history stays API-valid / continuable.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { accessSync, constants as fsConstants } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import type {
  Block,
  ChatMessage,
  EngineEvent,
  EngineStopReason,
  ModelId,
  Usage,
} from '@vingsforge/shared';
import { DEFAULT_MODEL } from '../engine/prompt.js';
import type { EngineTurnInput, TurnResult } from '../chats/store.js';

/** Env var that overrides the resolved `claude` binary path. */
export const CLAUDE_BIN_ENV = 'VINGSFORGE_CLAUDE_BIN';

/**
 * How the child `claude` process authenticates:
 *  - `'plan'`   — use the machine's logged-in subscription. ANTHROPIC_API_KEY /
 *                 ANTHROPIC_AUTH_TOKEN are stripped from the child env so the CLI
 *                 falls back to the stored login (apiKeySource:"none").
 *  - `'apiKey'` — set ANTHROPIC_API_KEY in the child env (value from SecretStore).
 */
export type ClaudeAuthMode = 'plan' | 'apiKey';

/** Auth resolved per turn (never logged). */
export interface ClaudeAuth {
  authMode: ClaudeAuthMode;
  /** Required when `authMode === 'apiKey'`. Never logged. */
  apiKey?: string;
}

/** Collaborators the runner depends on (all injectable for tests). */
export interface ClaudeCliRunnerDeps {
  /**
   * Resolve the absolute workspace root for the turn's chat/project. Used as the
   * child `cwd` and passed via `--add-dir`. Throw to fail the turn with an error.
   */
  resolveWorkspaceRoot(input: EngineTurnInput): string | Promise<string>;
  /**
   * Resolve how this turn authenticates. `'plan'` uses the logged-in
   * subscription; `'apiKey'` injects the key. The key is read from the
   * SecretStore by the host and passed here; it is NEVER logged.
   */
  resolveAuth(input: EngineTurnInput): ClaudeAuth | Promise<ClaudeAuth>;
  /**
   * Absolute path to the `claude` binary. When omitted the runner resolves it
   * from {@link CLAUDE_BIN_ENV}, then PATH (incl. `~/.local/bin`).
   */
  claudeBin?: string;
  /** stderr-only logger (never receives the API key). Optional. */
  log?(message: string): void;
  /**
   * Called whenever a `system/init` event advertises the CLI's slash commands /
   * skills, so the host can cache them and expose them to the UI (EngineMetaAPI).
   * Optional; absent in tests that don't care about meta.
   */
  onMeta?(meta: { slashCommands: string[]; skills: string[] }): void;
  /**
   * Spawn hook (tests inject a fake). Defaults to `node:child_process.spawn`.
   * Mirrors the exact call the runner makes so tests can assert args/env.
   */
  spawn?: typeof spawn;
}

/**
 * Permission mode passed to `claude --permission-mode`. Mapped from the turn's
 * quick modes (Spec 04 §3.2):
 *   readOnly  -> 'plan'              (read & plan only)
 *   acceptEdits -> 'acceptEdits'     (auto-approve edits; ask for bash)
 *   autoApprove -> 'bypassPermissions' (approve everything)
 *   (none)    -> 'acceptEdits'       (v1 default)
 */
export type ClaudePermissionMode =
  | 'plan'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'default';

/**
 * Build a `runEngineTurn`-shaped function backed by the `claude` CLI. Keeps a
 * per-instance `Map<chatId, sessionId>` so the FIRST turn of a chat spawns
 * without `--resume` (capturing `session_id` from `system/init`) and subsequent
 * turns pass `--resume <sessionId>` to continue the same CLI session.
 */
export function makeClaudeCliRunner(
  deps: ClaudeCliRunnerDeps,
): (input: EngineTurnInput, emit: (event: EngineEvent) => void) => Promise<TurnResult> {
  const sessions = new Map<string, string>();
  const log = deps.log ?? ((): void => undefined);
  const doSpawn = deps.spawn ?? spawn;

  return async (input, emit): Promise<TurnResult> => {
    const chatId = input.chatId;

    // Resolve the binary up front so a missing CLI surfaces as a clean `error`
    // EngineEvent (and a non-throwing return) rather than a spawn ENOENT crash.
    let bin: string;
    try {
      bin = resolveClaudeBin(deps.claudeBin);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Claude Code CLI not found';
      emit({ type: 'error', chatId, message });
      return { stopReason: 'end_turn', usage: emptyUsage() };
    }

    let root: string;
    let auth: ClaudeAuth;
    try {
      root = await deps.resolveWorkspaceRoot(input);
      auth = await deps.resolveAuth(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: 'error', chatId, message });
      return { stopReason: 'end_turn', usage: emptyUsage() };
    }

    const model: ModelId = input.model ?? DEFAULT_MODEL;
    const permissionMode = mapPermissionMode(input.modes);
    const resumeId = sessions.get(chatId);

    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--input-format',
      'text',
      '--model',
      model,
      '--permission-mode',
      permissionMode,
      '--add-dir',
      root,
    ];
    if (resumeId !== undefined) {
      args.push('--resume', resumeId);
    }

    const env = childEnv(auth);

    // Never log the API key. Args/env are key-free here (the key lives only in
    // `env.ANTHROPIC_API_KEY`, which we do not stringify).
    log(
      `spawn claude model=${model} mode=${permissionMode} auth=${auth.authMode}` +
        `${resumeId !== undefined ? ' resume' : ''} cwd=${root}`,
    );

    let child: ChildProcessWithoutNullStreams;
    try {
      child = doSpawn(bin, args, {
        cwd: root,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      const message = describeSpawnError(err, bin);
      emit({ type: 'error', chatId, message });
      return { stopReason: 'end_turn', usage: emptyUsage() };
    }

    return runChild({
      child,
      chatId,
      bin,
      userText: input.userText,
      controller: input.controller,
      emit,
      persistAssistant: input.persistAssistant,
      persistToolResults: input.persistToolResults,
      model,
      onSession: (sid) => sessions.set(chatId, sid),
      onMeta: deps.onMeta,
      log,
    });
  };
}

// --- child lifecycle --------------------------------------------------------

interface RunChildParams {
  child: ChildProcessWithoutNullStreams;
  chatId: string;
  bin: string;
  userText: string;
  controller: AbortController;
  emit: (event: EngineEvent) => void;
  persistAssistant: EngineTurnInput['persistAssistant'];
  persistToolResults: EngineTurnInput['persistToolResults'];
  model: ModelId;
  onSession: (sessionId: string) => void;
  onMeta: ((meta: { slashCommands: string[]; skills: string[] }) => void) | undefined;
  log: (message: string) => void;
}

/**
 * Pump the user text into the child via STDIN (never as an argv — avoids the
 * arg-length limit and shell/injection surface), parse stdout NDJSON line by
 * line into EngineEvents + persisted turns, and resolve when the CLI ends the
 * turn (`result`), the process exits, or the controller aborts.
 */
function runChild(p: RunChildParams): Promise<TurnResult> {
  const { child, chatId, controller, emit } = p;

  return new Promise<TurnResult>((resolve) => {
    let usage: Usage = emptyUsage();
    let stopReason: EngineStopReason = 'end_turn';
    let settled = false;
    let sawResult = false;
    let errorMessage: string | undefined;
    let stderrTail = '';

    const finish = (result: TurnResult): void => {
      if (settled) return;
      settled = true;
      controller.signal.removeEventListener('abort', onAbort);
      resolve(result);
    };

    // Abort: kill the child and end the turn as `interrupted` (Spec 03 §5).
    const onAbort = (): void => {
      stopReason = 'interrupted';
      killChild(child);
    };
    if (controller.signal.aborted) {
      onAbort();
    } else {
      controller.signal.addEventListener('abort', onAbort, { once: true });
    }

    const ctx: HandleCtx = {
      chatId,
      emit,
      model: p.model,
      persistAssistant: p.persistAssistant,
      persistToolResults: p.persistToolResults,
      onSession: p.onSession,
      onMeta: p.onMeta,
    };

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line: string) => {
      const outcome = mapStreamLine(line, ctx);
      if (outcome === undefined) return;
      if (outcome.usage !== undefined) usage = outcome.usage;
      if (outcome.stopReason !== undefined) stopReason = outcome.stopReason;
      if (outcome.error !== undefined) errorMessage = outcome.error;
      if (outcome.isResult) sawResult = true;
    });

    // Keep a small tail of stderr to explain a non-zero exit.
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2_000);
    });

    child.on('error', (err: Error) => {
      const message = describeSpawnError(err, p.bin);
      emit({ type: 'error', chatId, message });
      finish({ stopReason: 'end_turn', usage });
    });

    child.on('close', (code: number | null) => {
      rl.close();
      // Aborted: already accounted as interrupted.
      if (controller.signal.aborted) {
        emit({ type: 'turn.end', chatId, stopReason: 'interrupted', usage });
        finish({ stopReason: 'interrupted', usage });
        return;
      }
      // A `result` event already drove turn.end; just settle.
      if (sawResult) {
        finish({ stopReason, usage });
        return;
      }
      // The CLI exited without a `result`: surface a useful error and end the
      // turn cleanly (do not crash the host).
      const detail =
        errorMessage ??
        (stderrTail.trim().length > 0
          ? stderrTail.trim()
          : `claude exited with code ${code ?? 'null'}`);
      emit({ type: 'error', chatId, message: `Claude CLI: ${detail}` });
      emit({ type: 'turn.end', chatId, stopReason: 'end_turn', usage });
      finish({ stopReason: 'end_turn', usage });
    });

    // Feed the prompt via stdin and close it (text input-format expects one
    // message then EOF). Guard against EPIPE if the child died early.
    try {
      child.stdin.end(p.userText);
    } catch {
      // The 'error'/'close' handlers above will settle the turn.
    }
  });
}

// --- stream-event mapping ---------------------------------------------------

/**
 * Sink the pure stream-mapper writes into. `emit` receives EngineEvents;
 * `persistAssistant`/`persistToolResults` mirror the SDK engine's persistence;
 * `onSession` captures the CLI `session_id` (for `--resume`). All are injectable
 * so the mapper can be unit-tested with no child process / network.
 */
export interface HandleCtx {
  chatId: string;
  emit: (event: EngineEvent) => void;
  model: ModelId;
  persistAssistant: EngineTurnInput['persistAssistant'];
  persistToolResults: EngineTurnInput['persistToolResults'];
  onSession: (sessionId: string) => void;
  /** Optional sink for the CLI's advertised slash commands / skills (init event). */
  onMeta: ((meta: { slashCommands: string[]; skills: string[] }) => void) | undefined;
}

/** What the host's child-lifecycle loop needs to know after a mapped event. */
export interface HandleOutcome {
  sessionId?: string;
  usage?: Usage;
  stopReason?: EngineStopReason;
  error?: string;
  isResult?: boolean;
  /** Slash commands / skills advertised by a `system/init` event, if present. */
  meta?: { slashCommands: string[]; skills: string[] };
}

/** Aggregated result of feeding a whole NDJSON stream through the mapper. */
export interface MappedStream {
  /** Captured `session_id` from `system/init`, if any. */
  sessionId?: string;
  /** Usage from the terminal `result` event (zeroed when none). */
  usage: Usage;
  /** Stop reason from the terminal `result` (or `end_turn` default). */
  stopReason: EngineStopReason;
  /** Error text from a failed `result`, if any. */
  error?: string;
  /** Whether a terminal `result` event was seen. */
  sawResult: boolean;
  /** Slash commands / skills from the last `system/init`, if any. */
  meta?: { slashCommands: string[]; skills: string[] };
}

/**
 * Pure mapper for ONE NDJSON stdout line. Parses the line, dispatches it, and
 * (mirroring the child loop) routes any captured `session_id` through
 * `ctx.onSession`. Side effects happen ONLY through `ctx` (emit/persist/onSession)
 * — there is no process, no I/O, no global state — so it is trivially unit-tested.
 *
 * Returns `undefined` for blank / non-JSON lines (the CLI occasionally prints a
 * banner on stdout), or the {@link HandleOutcome} for a mapped event.
 */
export function mapStreamLine(line: string, ctx: HandleCtx): HandleOutcome | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  let event: ClaudeStreamEvent;
  try {
    event = JSON.parse(trimmed) as ClaudeStreamEvent;
  } catch {
    // Non-JSON line on stdout (rare; CLI banner etc.) — ignore.
    return undefined;
  }
  const outcome = handleStreamEvent(event, ctx);
  if (outcome.sessionId !== undefined) ctx.onSession(outcome.sessionId);
  if (outcome.meta !== undefined) ctx.onMeta?.(outcome.meta);
  return outcome;
}

/**
 * Pure mapper for a WHOLE NDJSON stream (array of stdout lines). Feeds each line
 * through {@link mapStreamLine} and folds the per-line outcomes into the same
 * aggregate the child-lifecycle loop computes (session id, final usage, stop
 * reason, error, whether a `result` was seen). Spawns nothing and touches no
 * network — the test harness for the stream → EngineEvent contract.
 */
export function mapStreamLines(lines: readonly string[], ctx: HandleCtx): MappedStream {
  const agg: MappedStream = {
    usage: emptyUsage(),
    stopReason: 'end_turn',
    sawResult: false,
  };
  for (const line of lines) {
    const outcome = mapStreamLine(line, ctx);
    if (outcome === undefined) continue;
    if (outcome.sessionId !== undefined) agg.sessionId = outcome.sessionId;
    if (outcome.usage !== undefined) agg.usage = outcome.usage;
    if (outcome.stopReason !== undefined) agg.stopReason = outcome.stopReason;
    if (outcome.error !== undefined) agg.error = outcome.error;
    if (outcome.isResult) agg.sawResult = true;
    if (outcome.meta !== undefined) agg.meta = outcome.meta;
  }
  return agg;
}

/** Map one parsed NDJSON event to EngineEvents + persisted turns. */
function handleStreamEvent(event: ClaudeStreamEvent, ctx: HandleCtx): HandleOutcome {
  switch (event.type) {
    case 'system':
      return handleSystem(event);
    case 'assistant':
      return handleAssistant(event, ctx);
    case 'user':
      return handleUser(event, ctx);
    case 'result':
      return handleResult(event, ctx);
    case 'rate_limit_event':
    default:
      // hook_started/hook_response (carried under system) and rate-limit/unknown
      // events carry nothing the UI needs — ignore.
      return {};
  }
}

function handleSystem(event: ClaudeStreamEvent): HandleOutcome {
  if (event.subtype !== 'init') return {};
  const out: HandleOutcome = {};
  if (typeof event.session_id === 'string') out.sessionId = event.session_id;
  // The init event advertises the CLI's slash commands + skills (and agents).
  // Capture the string arrays defensively — fields may be absent on older CLIs.
  const slashCommands = stringArray(event.slash_commands);
  const skills = stringArray(event.skills);
  if (slashCommands.length > 0 || skills.length > 0) {
    out.meta = { slashCommands, skills };
  }
  return out;
}

/** Coerce an unknown stream-json field into a clean `string[]` (drops non-strings). */
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

function handleAssistant(event: ClaudeStreamEvent, ctx: HandleCtx): HandleOutcome {
  const content = event.message?.content;
  if (!Array.isArray(content)) return {};

  const blocks: Block[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string' && b.text.length > 0) {
          ctx.emit({ type: 'message.delta', chatId: ctx.chatId, text: b.text });
          blocks.push({ kind: 'text', text: b.text });
        }
        break;
      case 'thinking':
        if (typeof b.thinking === 'string' && b.thinking.length > 0) {
          ctx.emit({ type: 'thinking.delta', chatId: ctx.chatId, text: b.thinking });
          const tb: Block = { kind: 'thinking', text: b.thinking };
          if (typeof b.signature === 'string') tb.signature = b.signature;
          blocks.push(tb);
        }
        break;
      case 'tool_use':
        if (typeof b.id === 'string' && typeof b.name === 'string') {
          ctx.emit({
            type: 'tool.start',
            chatId: ctx.chatId,
            tool: b.name,
            input: b.input,
            callId: b.id,
          });
          blocks.push({
            kind: 'tool_use',
            callId: b.id,
            tool: b.name,
            input: b.input,
          });
        }
        break;
      default:
        break;
    }
  }

  if (blocks.length === 0) return {};
  const turn = makeAssistantTurn(ctx.chatId, event.message?.id, blocks, ctx.model);
  ctx.persistAssistant(ctx.chatId, turn);
  return {};
}

function handleUser(event: ClaudeStreamEvent, ctx: HandleCtx): HandleOutcome {
  const content = event.message?.content;
  if (!Array.isArray(content)) return {};

  const blocks: Block[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool_result') continue;
    if (typeof b.tool_use_id !== 'string') continue;
    const isError = b.is_error === true;
    ctx.emit({
      type: 'tool.result',
      chatId: ctx.chatId,
      callId: b.tool_use_id,
      output: b.content,
      isError,
    });
    blocks.push({
      kind: 'tool_result',
      callId: b.tool_use_id,
      output: b.content,
      isError,
    });
  }

  if (blocks.length === 0) return {};
  ctx.persistToolResults(ctx.chatId, makeUserResultTurn(ctx.chatId, blocks));
  return {};
}

function handleResult(event: ClaudeStreamEvent, ctx: HandleCtx): HandleOutcome {
  const usage = mapUsage(event.usage);
  if (event.is_error === true || isErrorSubtype(event.subtype)) {
    const message =
      typeof event.result === 'string' && event.result.length > 0
        ? event.result
        : `claude turn failed (${event.subtype ?? 'error'})`;
    ctx.emit({ type: 'error', chatId: ctx.chatId, message });
    ctx.emit({ type: 'turn.end', chatId: ctx.chatId, stopReason: 'end_turn', usage });
    return { usage, stopReason: 'end_turn', error: message, isResult: true };
  }
  const stopReason = mapStopReason(event.stop_reason);
  ctx.emit({ type: 'turn.end', chatId: ctx.chatId, stopReason, usage });
  return { usage, stopReason, isResult: true };
}

// --- helpers ----------------------------------------------------------------

/** Map the turn's quick modes to the CLI's `--permission-mode` value. */
export function mapPermissionMode(
  modes: EngineTurnInput['modes'],
): ClaudePermissionMode {
  // TODO(perms): interactive per-tool gating via `--permission-prompt-tool`
  // is the next step; v1 maps quick-modes to the CLI's coarse modes.
  if (modes?.readOnly) return 'plan';
  if (modes?.autoApprove) return 'bypassPermissions';
  if (modes?.acceptEdits) return 'acceptEdits';
  // v1 default: auto-approve edits rather than block the turn waiting on a gate
  // we don't yet wire interactively.
  return 'acceptEdits';
}

/** Build the child env, applying the auth mode (NEVER logged). */
function childEnv(auth: ClaudeAuth): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (auth.authMode === 'apiKey') {
    if (auth.apiKey === undefined || auth.apiKey.length === 0) {
      throw new Error('apiKey auth selected but no API key was provided');
    }
    env.ANTHROPIC_API_KEY = auth.apiKey;
  } else {
    // 'plan': use the logged-in subscription. Remove any inherited key/token so
    // the CLI falls back to the stored login (apiKeySource:"none").
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}

/**
 * Resolve the `claude` binary: explicit override > {@link CLAUDE_BIN_ENV} > a
 * PATH scan that also includes `~/.local/bin` (where `claude` commonly installs
 * but which a GUI-launched process may not have on PATH). Throws a clear error
 * when nothing is found.
 */
export function resolveClaudeBin(override?: string): string {
  // An explicit override (deps.claudeBin) is trusted as-is: the caller resolved
  // it deliberately, and spawn surfaces ENOENT/EACCES cleanly if it is wrong.
  if (override !== undefined && override.length > 0) return override;

  const fromEnv = process.env[CLAUDE_BIN_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    if (isExecutable(fromEnv)) return fromEnv;
    throw new Error(
      `Claude Code CLI not found at ${CLAUDE_BIN_ENV}=${fromEnv} (not executable)`,
    );
  }

  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const home = homedir();
  const candidates = [
    join(home, '.local', 'bin'),
    ...pathEntries,
    '/usr/local/bin',
    '/usr/bin',
  ];
  for (const dir of candidates) {
    const candidate = join(dir, 'claude');
    if (isExecutable(candidate)) return candidate;
  }
  throw new Error(
    'Claude Code CLI not found. Install it (npm i -g @anthropic-ai/claude-code) ' +
      `and run \`claude login\`, or set ${CLAUDE_BIN_ENV} to its path.`,
  );
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Kill the child and its group; SIGKILL after a grace period if it lingers. */
function killChild(child: ChildProcessWithoutNullStreams): void {
  try {
    child.kill('SIGTERM');
  } catch {
    // already gone
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }, 2_000);
  // Don't keep the event loop alive just for the grace timer.
  timer.unref?.();
}

function describeSpawnError(err: unknown, bin: string): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return `Claude Code CLI not found at ${bin} (ENOENT). Install it and run \`claude login\`.`;
    }
    if (code === 'EACCES') {
      return `Claude Code CLI at ${bin} is not executable (EACCES).`;
    }
    return err.message;
  }
  return String(err);
}

function makeAssistantTurn(
  chatId: string,
  id: unknown,
  blocks: Block[],
  model: ModelId,
): ChatMessage {
  const turn: ChatMessage = {
    id: typeof id === 'string' && id.length > 0 ? id : `claude-asst-${Date.now()}`,
    chatId,
    role: 'assistant',
    blocks,
    model,
    createdAt: new Date().toISOString(),
  };
  return turn;
}

function makeUserResultTurn(chatId: string, blocks: Block[]): ChatMessage {
  return {
    id: `claude-tool-results-${Date.now()}`,
    chatId,
    role: 'user',
    blocks,
    createdAt: new Date().toISOString(),
  };
}

function isErrorSubtype(subtype: unknown): boolean {
  return typeof subtype === 'string' && subtype.startsWith('error');
}

function mapStopReason(reason: unknown): EngineStopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'pause_turn':
      return 'pause_turn';
    case 'refusal':
      return 'refusal';
    case 'end_turn':
    case 'stop_sequence':
    default:
      return 'end_turn';
  }
}

function mapUsage(u: ClaudeUsage | undefined): Usage {
  if (!u) return emptyUsage();
  const usage: Usage = {
    inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
    outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
  };
  if (typeof u.cache_creation_input_tokens === 'number') {
    usage.cacheCreationInputTokens = u.cache_creation_input_tokens;
  }
  if (typeof u.cache_read_input_tokens === 'number') {
    usage.cacheReadInputTokens = u.cache_read_input_tokens;
  }
  return usage;
}

function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0 };
}

// --- raw stream-json shapes (loosely typed; we validate fields at use) -------

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ClaudeMessage {
  id?: string;
  role?: string;
  content?: unknown;
}

interface ClaudeStreamEvent {
  type: 'system' | 'assistant' | 'user' | 'result' | 'rate_limit_event' | string;
  subtype?: string;
  session_id?: string;
  /** `system/init` advertises these capability arrays (loosely typed). */
  slash_commands?: unknown;
  skills?: unknown;
  message?: ClaudeMessage;
  is_error?: boolean;
  result?: string;
  stop_reason?: string;
  usage?: ClaudeUsage;
}
