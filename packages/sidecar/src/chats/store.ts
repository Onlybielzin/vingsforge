/**
 * ChatStore (Spec 02): CRUD over chats + per-turn orchestration. Persists the
 * user turn, runs the injected engine, forwards EngineEvents on a per-chat bus,
 * auto-titles from the first message, and resolves model/runtime overrides.
 */
import { z } from 'zod';
import {
  isKnownModel,
  type Chat,
  type ChatMessage,
  type ChatSummary,
  type ChatsAPI,
  type EngineEvent,
  type Effort,
  type ModelId,
  type PermissionModes,
  type PermissionPolicy,
} from '@vingsforge/shared';
import { isSessionId, jsonlToBlocks } from '../projects/external-sessions.js';
import {
  type AppendMessageInput,
  type CreateChatInput,
  type DbStore,
  type UpdateChatPatch,
} from '@vingsforge/persistence';
import type { TurnResult } from '../engine/engine.js';
import { RuntimeNotFoundError } from '../projects/manager.js';

/** Raised when an operation targets a chat id that does not exist. */
export class ChatNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`chat not found: ${id}`);
    this.name = 'ChatNotFoundError';
  }
}

/** Raised when a chat override names a model outside the known-models allowlist. */
export class UnknownModelError extends Error {
  constructor(readonly model: string) {
    super(`unknown model: ${model}`);
    this.name = 'UnknownModelError';
  }
}

/** Raised by {@link ChatStore.send} when a turn is already running for the chat. */
export class TurnInProgressError extends Error {
  constructor(readonly chatId: string) {
    super(`a turn is already running for chat: ${chatId}`);
    this.name = 'TurnInProgressError';
  }
}

/** Raised by {@link ChatStore.importSession} for a non-UUID session id. */
export class InvalidSessionIdError extends Error {
  constructor(readonly sessionId: string) {
    super(`invalid Claude Code session id: ${sessionId}`);
    this.name = 'InvalidSessionIdError';
  }
}

/** Raised when importing a session but no transcript loader was wired. */
export class SessionImportUnsupportedError extends Error {
  constructor() {
    super('importing external Claude Code sessions is not supported here');
    this.name = 'SessionImportUnsupportedError';
  }
}

export type { TurnResult };

/**
 * Everything the engine needs for one turn. The store assembles this from the
 * resolved chat context and hands it to {@link ChatStoreDeps.runEngineTurn},
 * which owns how the Anthropic client, permission gate and tool executor are
 * wired for the chat's runtime (local or remote — out of scope here, Spec 05).
 */
export interface EngineTurnInput {
  chatId: string;
  /** Frozen system prompt (app + project instructions). */
  system: string;
  /** Persisted prior turns, oldest first. */
  history: ChatMessage[];
  /** The new user text for this turn. */
  userText: string;
  /** Resolved model (chat override > project default > engine default). */
  model?: ModelId;
  /** Runtime the turn runs on (chat override > project default). */
  runtimeId?: string;
  effort?: Effort;
  maxTokens?: number;
  /** Volatile context appended as a trailing system message. */
  volatileContext?: string;
  /**
   * The chat's effective permission policy (Spec 04 §3). Ships to a remote
   * daemon so it gates server-side (Spec 05 §5); the local engine resolves its
   * gate from the same policy via the engine-runner wiring.
   */
  policy?: PermissionPolicy;
  /** Quick modes (read-only / auto-approve) for the turn (Spec 04 §3.2). */
  modes?: PermissionModes;
  /**
   * Persisted Claude Code CLI `session_id` for this chat, if any (Spec: resume
   * across restarts). The CLI runner uses it to pass `claude --resume <id>` so an
   * old chat continues its prior CLI session after the app restarts, instead of
   * starting a fresh one and losing context. Absent on a chat's first CLI turn.
   * This is the SOURCE OF TRUTH for resume; the runner's in-memory Map is only a
   * fallback cache for turns within a single process run.
   */
  resumeSessionId?: string;
  /** Aborts the turn when {@link ChatStore.interrupt} fires. */
  controller: AbortController;
  /** Persist a completed assistant turn (called by the engine). */
  persistAssistant(chatId: string, message: ChatMessage): void;
  /** Persist the user turn carrying batched tool_results (called by the engine). */
  persistToolResults(chatId: string, message: ChatMessage): void;
  /**
   * Persist the Claude Code CLI `session_id` captured by the engine for this chat
   * (called by the CLI runner when `system/init` advertises a session). Durable so
   * `claude --resume` works after an app restart. No-op for engines that don't run
   * the CLI (SDK engine never calls it).
   */
  persistClaudeSession?(chatId: string, sessionId: string): void;
}

/**
 * The context resolved for a chat before a turn: the frozen system prompt plus
 * the effective model/runtime/effort after applying chat → project → default
 * overrides (Spec 02 RF-08).
 */
export interface ChatContext {
  system: string;
  model?: ModelId;
  runtimeId?: string;
  effort?: Effort;
  maxTokens?: number;
  volatileContext?: string;
  /** Effective permission policy for the chat (Spec 04 §3 / Spec 05 §5). */
  policy?: PermissionPolicy;
  /** Quick modes (read-only / auto-approve) for the turn (Spec 04 §3.2). */
  modes?: PermissionModes;
}

/** Collaborators the store depends on (all injectable for tests). */
export interface ChatStoreDeps {
  db: DbStore;
  /**
   * Resolve the per-turn context for a chat: builds the system prompt (app +
   * project AGENTS.md/systemPromptExtra) and applies model/runtime overrides
   * (Spec 02 RF-08, Spec 03 §3). Kept out of the store so prompt assembly and
   * runtime resolution can evolve independently.
   */
  resolveContext(chat: Chat): Promise<ChatContext> | ChatContext;
  /**
   * Run one engine turn. Streams EngineEvents through `emit`, persists the
   * assistant/tool-result turns via the supplied hooks, and resolves when the
   * turn ends (Spec 03). The store never talks to the Anthropic SDK directly.
   */
  runEngineTurn(
    input: EngineTurnInput,
    emit: (event: EngineEvent) => void,
  ): Promise<TurnResult>;
  /**
   * Derive an automatic title from the first user message (Spec 02 RF-06).
   * Defaults to a truncated slice of the text when omitted.
   */
  titleFromText?(text: string): string;
  /**
   * Load the full NDJSON transcript (as lines) of an external Claude Code CLI
   * session for {@link ChatStore.importSession}. Injected so the fs/path logic and
   * its `~/.claude/projects` confinement live in one place (the ProjectManager);
   * the store stays fs-free and unit-testable. Must throw when the workspace is
   * remote, the session id is invalid, or the transcript file is missing.
   */
  loadSessionTranscript?(projectId: string, sessionId: string): Promise<string[]>;
}

// --- Input validation (Spec 02 §5) -----------------------------------------

const titleSchema = z.string().trim().min(1).max(200);
// Upper bound guards against unbounded input (cost/DoS): a multi-megabyte
// message would be persisted to SQLite and re-sent as history every turn,
// ballooning token cost/memory and risking an OOM when assembling the prompt.
// Sized to the engine's max context window (see Spec 03).
const MESSAGE_TEXT_MAX = 200_000;
const messageTextSchema = z.string().min(1).max(MESSAGE_TEXT_MAX);
/**
 * Upper bound on how many imported messages we persist from an external session,
 * keeping the MOST RECENT. Bounds memory/cost when adopting a very long terminal
 * transcript; the CLI still has the full session, so `--resume` continues with
 * complete server-side context regardless of how much we mirror locally.
 */
const IMPORT_MESSAGE_LIMIT = 200;
const createOptsSchema = z
  .object({
    model: z.string().min(1).optional(),
    runtimeId: z.string().min(1).optional(),
  })
  .strict()
  .optional();

/** Default auto-title: first non-empty line, truncated. */
const DEFAULT_TITLE_MAX = 60;
function defaultTitle(text: string): string {
  const firstLine = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const trimmed = firstLine.length > 0 ? firstLine : text.trim();
  return trimmed.length > DEFAULT_TITLE_MAX
    ? `${trimmed.slice(0, DEFAULT_TITLE_MAX).trimEnd()}…`
    : trimmed || 'New chat';
}

/**
 * Chat lifecycle + turn orchestration. Stateless beyond the injected deps and a
 * small map of in-flight turn controllers, so a single instance serves the whole
 * app. Implements the {@link ChatsAPI} contract.
 */
export class ChatStore implements ChatsAPI {
  private readonly listeners = new Set<(event: EngineEvent) => void>();
  /** chatId -> AbortController for the turn currently running (Spec 02 RF-05). */
  private readonly inFlight = new Map<string, AbortController>();

  constructor(private readonly deps: ChatStoreDeps) {}

  // --- subscription (the `engine.events` channel, Spec 02 §5) ---------------

  /**
   * Subscribe to every EngineEvent the store emits. The renderer filters by
   * `chatId`; returns an unsubscribe function (Spec 02 §5 — dedicated stream).
   */
  onEvent(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  // --- CRUD (Spec 02 RF-01/02/03/06/07) -------------------------------------

  /** Active chats of a project, most recently updated first (Spec 02 RF-02). */
  async list(projectId: string): Promise<ChatSummary[]> {
    return this.deps.db.chats.listByProject(projectId);
  }

  /**
   * Create a chat in a project (Spec 02 RF-01). Optional model/runtime overrides
   * are recorded up front; the title starts as a placeholder and is filled in
   * automatically from the first message (Spec 02 RF-06, RF-08).
   */
  async create(
    projectId: string,
    opts?: { model?: ModelId; runtimeId?: string },
  ): Promise<Chat> {
    if (!this.deps.db.projects.get(projectId)) {
      throw new Error(`project not found: ${projectId}`);
    }
    const parsed = createOptsSchema.parse(opts);
    if (parsed?.model !== undefined) this.requireKnownModel(parsed.model);
    if (parsed?.runtimeId !== undefined) this.requireRuntime(parsed.runtimeId);
    const input: CreateChatInput = { projectId };
    if (parsed?.model !== undefined) input.modelOverride = parsed.model;
    if (parsed?.runtimeId !== undefined) input.runtimeOverride = parsed.runtimeId;
    return this.deps.db.transaction(() => this.deps.db.chats.create(input));
  }

  /**
   * Import a Claude Code CLI session created OUTSIDE the app as a new chat, so it
   * can be continued in-app (Spec: continue terminal sessions). Creates the chat
   * with `claudeSessionId = sessionId` up front, so the NEXT {@link send} resumes
   * the same CLI session via `claude --resume` (the resume infra already reads
   * this column). The prior transcript is mirrored best-effort: only mappable
   * user/assistant turns are kept, bounded to the most recent
   * {@link IMPORT_MESSAGE_LIMIT} so a huge terminal session is not slurped whole.
   *
   * Throws {@link InvalidSessionIdError} for a non-UUID id (before any read),
   * {@link SessionImportUnsupportedError} when no transcript loader is wired, and a
   * clear error (from the loader) when the workspace is remote or the file is
   * missing — never leaving a half-created chat that points at a session it cannot
   * resume: the chat row is created only AFTER the transcript reads successfully.
   */
  async importSession(projectId: string, sessionId: string): Promise<Chat> {
    if (!isSessionId(sessionId)) throw new InvalidSessionIdError(sessionId);
    if (!this.deps.db.projects.get(projectId)) {
      throw new Error(`project not found: ${projectId}`);
    }
    const load = this.deps.loadSessionTranscript;
    if (!load) throw new SessionImportUnsupportedError();

    // Read+parse the transcript BEFORE creating any row, so a missing/remote
    // transcript fails cleanly with no orphan chat.
    const lines = await load(projectId, sessionId);
    const imported = jsonlToBlocks(lines);
    // Keep the most recent messages within the import bound (chronological order
    // preserved). The CLI retains the full session, so `--resume` still has it all.
    const recent =
      imported.length > IMPORT_MESSAGE_LIMIT
        ? imported.slice(imported.length - IMPORT_MESSAGE_LIMIT)
        : imported;

    // Title from the first imported user text, else a stable fallback.
    const firstUserText = recent.find((m) => m.role === 'user')?.blocks.find(
      (b): b is Extract<typeof b, { kind: 'text' }> => b.kind === 'text',
    )?.text;
    const make = this.deps.titleFromText ?? defaultTitle;
    const title = (firstUserText ? make(firstUserText) : `Imported session`)
      .slice(0, 200)
      .trim();

    return this.deps.db.transaction(() => {
      const createInput: CreateChatInput = { projectId, claudeSessionId: sessionId };
      if (title.length > 0) createInput.title = title;
      const chat = this.deps.db.chats.create(createInput);
      for (const m of recent) {
        this.deps.db.messages.append({
          chatId: chat.id,
          role: m.role,
          blocks: m.blocks,
        });
      }
      return chat;
    });
  }

  /** Full ordered history of a chat for rendering (Spec 02 RF-03, RF-09). */
  async history(chatId: string): Promise<ChatMessage[]> {
    this.requireChat(chatId);
    return this.deps.db.messages.list(chatId);
  }

  /** Rename a chat (Spec 02 RF-06). */
  async rename(chatId: string, title: string): Promise<void> {
    const parsed = titleSchema.parse(title);
    this.requireChat(chatId);
    this.deps.db.chats.update(chatId, { title: parsed });
  }

  /** Archive a chat — hides it from the default list (Spec 02 RF-07). */
  async archive(chatId: string): Promise<void> {
    this.requireChat(chatId);
    const patch: UpdateChatPatch = { archived: true };
    this.deps.db.chats.update(chatId, patch);
  }

  /**
   * Delete a chat and its history (Spec 02 RF-07). Any in-flight turn is
   * interrupted first so no event arrives for a chat that no longer exists.
   */
  async delete(chatId: string): Promise<void> {
    this.requireChat(chatId);
    this.abortInFlight(chatId);
    this.deps.db.transaction(() => this.deps.db.chats.remove(chatId));
  }

  // --- turn orchestration (Spec 02 §4, RF-04) -------------------------------

  /**
   * Send a user message and run an engine turn (Spec 02 RF-04). Persists the
   * user message first (so reopening reconstructs the thread — Spec 02 RF-09),
   * then streams the turn; the engine persists the assistant + tool-result
   * turns. On the chat's first message the title is auto-derived (RF-06).
   *
   * Resolves when the turn ends; EngineEvents arrive on {@link onEvent} as they
   * stream. Throws {@link TurnInProgressError} if a turn is already running.
   */
  async send(chatId: string, text: string): Promise<void> {
    const userText = messageTextSchema.parse(text);
    const chat = this.requireChat(chatId);
    if (this.inFlight.has(chatId)) throw new TurnInProgressError(chatId);

    // Reserve the in-flight slot SYNCHRONOUSLY — before any `await` — so two
    // concurrent send() calls for the same chat can't both clear the guard
    // above (TOCTOU): the second would otherwise also persist a user turn,
    // double-bill the chat, and overwrite this controller (leaving this turn
    // un-interruptible). The slot is always released in the finally below; an
    // early throw (validation / resolveContext / removed chat) clears it too.
    const controller = new AbortController();
    this.inFlight.set(chatId, controller);
    try {
      // Auto-title from the first message, before persisting it, so the very
      // first turn already shows a meaningful title (Spec 02 RF-06).
      this.maybeAutoTitle(chatId, userText);

      // Persist the user turn up front: history must be durable even if the
      // turn is interrupted or errors (Spec 02 RF-09, acceptance #2).
      const userMessage: AppendMessageInput = {
        chatId,
        role: 'user',
        blocks: [{ kind: 'text', text: userText }],
      };
      const persistedUser = this.deps.db.messages.append(userMessage);

      const context = await this.deps.resolveContext(chat);
      // The chat may have been deleted/archived during the await above (e.g. a
      // concurrent delete()). Re-confirm it still exists before routing engine
      // output to it, so we don't persist assistant/tool turns for a removed
      // chat (FK error in SQLite; orphan messages in the memory store).
      this.requireChat(chatId);
      // Re-validate the resolved model/runtime before the turn runs: a persisted
      // override could have been written before this guard existed, or by a path
      // that bypassed `create()` (Spec 05 — never route a turn to an unknown
      // runtime or unsupported model).
      if (context.model !== undefined) this.requireKnownModel(context.model);
      if (context.runtimeId !== undefined) this.requireRuntime(context.runtimeId);
      // History sent to the engine is everything BEFORE this user turn; the
      // engine appends `userText` itself (prompt.buildMessages), so exclude it
      // here to avoid duplicating the message.
      const history = this.deps.db.messages
        .list(chatId)
        .filter((m) => m.id !== persistedUser.id);

      const input: EngineTurnInput = {
        chatId,
        system: context.system,
        history,
        userText,
        controller,
        persistAssistant: (id, message) => this.persistTurn(id, message),
        persistToolResults: (id, message) => this.persistTurn(id, message),
        // Persist any CLI session_id the engine captures, so `--resume` survives
        // an app restart. Writing only the session column (no updatedAt bump)
        // keeps the chat list ordering driven by real messages.
        persistClaudeSession: (id, sessionId) =>
          this.deps.db.chats.setClaudeSession(id, sessionId),
      };
      // Pass the persisted CLI session id (read fresh from the chat row) so the
      // runner resumes the right session even on the FIRST turn after a restart.
      const resumeSessionId = this.deps.db.chats.get(chatId)?.claudeSessionId;
      if (resumeSessionId !== undefined) input.resumeSessionId = resumeSessionId;
      if (context.model !== undefined) input.model = context.model;
      if (context.runtimeId !== undefined) input.runtimeId = context.runtimeId;
      if (context.effort !== undefined) input.effort = context.effort;
      if (context.maxTokens !== undefined) input.maxTokens = context.maxTokens;
      if (context.volatileContext !== undefined) {
        input.volatileContext = context.volatileContext;
      }
      if (context.policy !== undefined) input.policy = context.policy;
      if (context.modes !== undefined) input.modes = context.modes;

      try {
        await this.deps.runEngineTurn(input, (event) => this.emit(event));
      } catch (err) {
        // Surface engine failures on the stream too, so the UI can react even
        // when the caller does not await/handle the rejection (Spec 02 §4).
        const message = err instanceof Error ? err.message : String(err);
        this.emit({ type: 'error', chatId, message });
        throw err;
      }
    } finally {
      // Only clear OUR reservation: a delete()/interrupt() during the turn may
      // have already aborted and replaced/removed the controller, and a later
      // send() could have reserved the slot again. Never clobber a newer turn.
      if (this.inFlight.get(chatId) === controller) {
        this.inFlight.delete(chatId);
      }
    }
  }

  /**
   * Interrupt the turn in progress for a chat (Spec 02 RF-05). No-op when idle;
   * the engine closes the loop so the persisted thread stays continuable.
   */
  async interrupt(chatId: string): Promise<void> {
    this.abortInFlight(chatId);
  }

  // --- internals ------------------------------------------------------------

  private requireChat(chatId: string): Chat {
    const chat = this.deps.db.chats.get(chatId);
    if (!chat) throw new ChatNotFoundError(chatId);
    return chat;
  }

  /**
   * Ensure a runtime override refers to a real runtime before it drives runtime
   * resolution (Spec 05). The `'local'` sentinel has no runtimes row and is
   * always accepted; any other id must exist, mirroring the projects guard so a
   * chat can never route a turn to an unknown/attacker-chosen runtime.
   */
  private requireRuntime(runtimeId: string): void {
    if (runtimeId === 'local') return;
    if (!this.deps.db.runtimes.get(runtimeId)) throw new RuntimeNotFoundError(runtimeId);
  }

  /** Reject model overrides outside the known-models allowlist (Spec 07 §5). */
  private requireKnownModel(model: string): void {
    if (!isKnownModel(model)) throw new UnknownModelError(model);
  }

  /**
   * Persist an engine-produced turn. Assistant turns carry their model so replay
   * can keep or drop `thinking` blocks on a later model switch (Spec 08 §4).
   */
  private persistTurn(chatId: string, message: ChatMessage): void {
    const input: AppendMessageInput = {
      id: message.id,
      chatId,
      role: message.role,
      blocks: message.blocks,
    };
    if (message.usage !== undefined) input.usage = message.usage;
    if (message.model !== undefined) input.model = message.model;
    this.deps.db.messages.append(input);
  }

  /** Set the title from the first user message when the chat is still untitled. */
  private maybeAutoTitle(chatId: string, text: string): void {
    if (this.deps.db.messages.list(chatId).length > 0) return;
    const make = this.deps.titleFromText ?? defaultTitle;
    const title = make(text).slice(0, 200).trim();
    if (title.length > 0) this.deps.db.chats.update(chatId, { title });
  }

  /** Abort and forget any in-flight controller for the chat. */
  private abortInFlight(chatId: string): void {
    const controller = this.inFlight.get(chatId);
    if (controller) {
      controller.abort();
      this.inFlight.delete(chatId);
    }
  }
}

