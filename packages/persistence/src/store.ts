/**
 * DbStore — the persistence contract (Spec 08). Repositories for projects, chats,
 * messages, runtimes and settings sit behind this interface so the SQLite (better-sqlite3)
 * and in-memory implementations are interchangeable.
 */
import type {
  Block,
  Chat,
  ChatMessage,
  ChatSummary,
  GlobalSettings,
  ModelId,
  PermissionPolicy,
  Project,
  RemoteRuntime,
  Usage,
  WorkspaceRef,
} from '@vingsforge/shared';

/** Input to create a project (id/timestamps are assigned by the store unless provided). */
export interface CreateProjectInput {
  id?: string;
  name: string;
  workspace: WorkspaceRef;
  runtimeId?: string;
  defaultModel?: string;
  systemPromptExtra?: string;
  permissionPolicy?: PermissionPolicy;
}

/** Mutable project fields (Spec 01 updateConfig). */
export type UpdateProjectPatch = Partial<
  Pick<
    Project,
    | 'name'
    | 'workspace'
    | 'runtimeId'
    | 'defaultModel'
    | 'systemPromptExtra'
    | 'permissionPolicy'
    | 'lastOpenedAt'
  >
>;

export interface CreateChatInput {
  id?: string;
  projectId: string;
  title?: string;
  modelOverride?: string;
  runtimeOverride?: string;
}

export type UpdateChatPatch = Partial<
  Pick<Chat, 'title' | 'modelOverride' | 'runtimeOverride' | 'archived'>
>;

/** Input to append a message; `seq` is assigned by the store (monotonic per chat). */
export interface AppendMessageInput {
  id?: string;
  chatId: string;
  role: 'user' | 'assistant';
  blocks: Block[];
  usage?: Usage;
  /**
   * Model that produced the message (assistant turns). Recorded so replay can
   * keep or drop `thinking` blocks on a model switch (Spec 08 §4). Strongly
   * recommended for assistant turns containing `thinking` blocks.
   */
  model?: ModelId;
}

export interface RuntimeRecord {
  id: string;
  label: string;
  ssh: RemoteRuntime['ssh'];
  daemon: RemoteRuntime['daemon'];
  apiKeyLocation: RemoteRuntime['apiKeyLocation'];
  /**
   * Per-runtime shared secret the app presents on the daemon WebSocket handshake
   * (Spec 05 §2). Generated at add/install and mirrored onto the VPS; the daemon
   * rejects connections that don't present it, so loopback reachability alone is
   * not enough to drive the daemon on a shared host. Optional: legacy rows and
   * tests may omit it (an absent token disables the check on that runtime).
   */
  authToken?: string;
}

/** Projects repository. */
export interface ProjectsRepo {
  list(): Project[];
  get(id: string): Project | undefined;
  create(input: CreateProjectInput): Project;
  update(id: string, patch: UpdateProjectPatch): Project;
  /** Removes the project and (via cascade) its chats/messages. Workspace files are untouched. */
  remove(id: string): void;
}

/** Chats repository. */
export interface ChatsRepo {
  listByProject(projectId: string, opts?: { includeArchived?: boolean }): ChatSummary[];
  get(id: string): Chat | undefined;
  create(input: CreateChatInput): Chat;
  update(id: string, patch: UpdateChatPatch): Chat;
  remove(id: string): void;
}

/** Messages repository. */
export interface MessagesRepo {
  /** Ordered history of a chat (by `seq`). */
  list(chatId: string): ChatMessage[];
  append(input: AppendMessageInput): ChatMessage;
  /** Deletes all messages for a chat (kept distinct from chat removal). */
  clear(chatId: string): void;
}

/** Remote runtimes repository. */
export interface RuntimesRepo {
  list(): RuntimeRecord[];
  get(id: string): RuntimeRecord | undefined;
  upsert(record: RuntimeRecord): RuntimeRecord;
  remove(id: string): void;
}

/** Key/value settings repository (JSON values). `schema_version` is reserved (Spec 08 §5). */
export interface SettingsRepo {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
  delete(key: string): void;
  all(): Record<string, unknown>;
  /** Convenience for the typed global settings blob (Spec 07). */
  getGlobal(): GlobalSettings | undefined;
  setGlobal(value: GlobalSettings): void;
}

/**
 * Top-level persistence handle. All repos share one underlying connection/state.
 * `transaction` runs `fn` atomically (no-op grouping for the in-memory store).
 */
export interface DbStore {
  readonly projects: ProjectsRepo;
  readonly chats: ChatsRepo;
  readonly messages: MessagesRepo;
  readonly runtimes: RuntimesRepo;
  readonly settings: SettingsRepo;
  /** Current applied schema version. */
  schemaVersion(): number;
  /** Run a function inside a single transaction; returns its result. */
  transaction<T>(fn: () => T): T;
  /** Reclaim space (SQLite VACUUM; no-op in memory). Spec 08 §7. */
  vacuum(): void;
  /** Close the underlying connection. */
  close(): void;
}

/** The global-settings key in the `settings` table. */
export const GLOBAL_SETTINGS_KEY = 'global';
/** The schema-version key in the `settings` table (Spec 08 §5). */
export const SCHEMA_VERSION_KEY = 'schema_version';
