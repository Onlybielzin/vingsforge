/**
 * better-sqlite3 implementation of DbStore (WAL mode, foreign keys on).
 * Maps domain entities to the v1 schema and (de)serializes JSON columns faithfully (Spec 08).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import type {
  Block,
  Chat,
  ChatMessage,
  ChatSummary,
  GlobalSettings,
  PermissionPolicy,
  Project,
  RemoteRuntime,
  Usage,
  WorkspaceRef,
} from '@vingsforge/shared';
import {
  CURRENT_SCHEMA_VERSION,
  readSchemaVersion,
  runMigrations,
} from './migrations.js';
import { defaultDbPath } from './paths.js';
import { fromJson, fromJsonNullable, toJson } from './json.js';
import {
  blocksSchema,
  daemonSchema,
  permissionPolicySchema,
  sshSchema,
  usageSchema,
  workspaceRefSchema,
} from './schemas.js';
import {
  GLOBAL_SETTINGS_KEY,
  type AppendMessageInput,
  type ChatsRepo,
  type CreateChatInput,
  type CreateProjectInput,
  type DbStore,
  type MessagesRepo,
  type ProjectsRepo,
  type RuntimeRecord,
  type RuntimesRepo,
  type SettingsRepo,
  type UpdateChatPatch,
  type UpdateProjectPatch,
} from './store.js';
import { assertAppendableBlocks } from './replay.js';
import { newId, nowIso } from './util.js';

export interface SqliteStoreOptions {
  /** File path for the database. Defaults to the XDG location. ':memory:' is allowed but prefer InMemoryDbStore for tests. */
  path?: string;
  /** Skip WAL pragma (e.g. for `:memory:`). Defaults to true for on-disk databases. */
  wal?: boolean;
}

interface ProjectRow {
  id: string;
  name: string;
  workspace_kind: string;
  workspace_path: string;
  runtime_id: string;
  default_model: string | null;
  system_prompt_extra: string | null;
  permission_policy: string | null;
  created_at: string;
  last_opened_at: string | null;
}

interface ChatRow {
  id: string;
  project_id: string;
  title: string;
  model_override: string | null;
  runtime_override: string | null;
  claude_session_id: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  chat_id: string;
  role: string;
  blocks: string;
  usage: string | null;
  model: string | null;
  created_at: string;
  seq: number;
}

interface RuntimeRow {
  id: string;
  label: string;
  ssh: string;
  daemon: string;
  api_key_location: string;
  auth_token: string | null;
}

function rowToProject(row: ProjectRow): Project {
  const workspace = fromJson<typeof workspaceRefSchema, WorkspaceRef>(
    workspaceRefSchema,
    row.workspace_path,
  );
  const project: Project = {
    id: row.id,
    name: row.name,
    workspace,
    runtimeId: row.runtime_id,
    createdAt: row.created_at,
  };
  if (row.default_model !== null) project.defaultModel = row.default_model;
  if (row.system_prompt_extra !== null)
    project.systemPromptExtra = row.system_prompt_extra;
  const policy = fromJsonNullable<typeof permissionPolicySchema, PermissionPolicy>(
    permissionPolicySchema,
    row.permission_policy,
  );
  if (policy !== undefined) project.permissionPolicy = policy;
  if (row.last_opened_at !== null) project.lastOpenedAt = row.last_opened_at;
  return project;
}

function rowToChat(row: ChatRow): Chat {
  const chat: Chat = {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived !== 0,
  };
  if (row.model_override !== null) chat.modelOverride = row.model_override;
  if (row.runtime_override !== null) chat.runtimeOverride = row.runtime_override;
  // `claude_session_id` is added by migration v4; guard with `!= null` so a
  // database opened mid-upgrade (or a SELECT before the column exists) yields
  // `undefined` rather than throwing.
  if (row.claude_session_id != null) chat.claudeSessionId = row.claude_session_id;
  return chat;
}

function rowToMessage(row: MessageRow): ChatMessage {
  const msg: ChatMessage = {
    id: row.id,
    chatId: row.chat_id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    blocks: fromJson<typeof blocksSchema, Block[]>(blocksSchema, row.blocks),
    createdAt: row.created_at,
  };
  const usage = fromJsonNullable<typeof usageSchema, Usage>(usageSchema, row.usage);
  if (usage !== undefined) msg.usage = usage;
  if (row.model !== null) msg.model = row.model;
  return msg;
}

class SqliteProjectsRepo implements ProjectsRepo {
  constructor(private readonly db: Db) {}

  list(): Project[] {
    return this.db
      .prepare<[], ProjectRow>(`SELECT * FROM projects ORDER BY created_at ASC`)
      .all()
      .map(rowToProject);
  }

  get(id: string): Project | undefined {
    const row = this.db
      .prepare<[string], ProjectRow>(`SELECT * FROM projects WHERE id = ?`)
      .get(id);
    return row ? rowToProject(row) : undefined;
  }

  create(input: CreateProjectInput): Project {
    const project: Project = {
      id: input.id ?? newId(),
      name: input.name,
      workspace: input.workspace,
      runtimeId: input.runtimeId ?? 'local',
      createdAt: nowIso(),
    };
    if (input.defaultModel !== undefined) project.defaultModel = input.defaultModel;
    if (input.systemPromptExtra !== undefined)
      project.systemPromptExtra = input.systemPromptExtra;
    if (input.permissionPolicy !== undefined)
      project.permissionPolicy = input.permissionPolicy;

    this.db
      .prepare(
        `INSERT INTO projects
          (id, name, workspace_kind, workspace_path, runtime_id, default_model,
           system_prompt_extra, permission_policy, created_at, last_opened_at)
         VALUES (@id, @name, @workspace_kind, @workspace_path, @runtime_id, @default_model,
           @system_prompt_extra, @permission_policy, @created_at, @last_opened_at)`,
      )
      .run({
        id: project.id,
        name: project.name,
        workspace_kind: project.workspace.kind,
        workspace_path: toJson(project.workspace),
        runtime_id: project.runtimeId,
        default_model: project.defaultModel ?? null,
        system_prompt_extra: project.systemPromptExtra ?? null,
        permission_policy: project.permissionPolicy
          ? toJson(project.permissionPolicy)
          : null,
        created_at: project.createdAt,
        last_opened_at: null,
      });
    return project;
  }

  update(id: string, patch: UpdateProjectPatch): Project {
    const existing = this.get(id);
    if (!existing) throw new Error(`Project not found: ${id}`);
    const next: Project = { ...existing, ...patch };
    this.db
      .prepare(
        `UPDATE projects SET
           name = @name,
           workspace_kind = @workspace_kind,
           workspace_path = @workspace_path,
           runtime_id = @runtime_id,
           default_model = @default_model,
           system_prompt_extra = @system_prompt_extra,
           permission_policy = @permission_policy,
           last_opened_at = @last_opened_at
         WHERE id = @id`,
      )
      .run({
        id,
        name: next.name,
        workspace_kind: next.workspace.kind,
        workspace_path: toJson(next.workspace),
        runtime_id: next.runtimeId,
        default_model: next.defaultModel ?? null,
        system_prompt_extra: next.systemPromptExtra ?? null,
        permission_policy: next.permissionPolicy
          ? toJson(next.permissionPolicy)
          : null,
        last_opened_at: next.lastOpenedAt ?? null,
      });
    return next;
  }

  remove(id: string): void {
    this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  }
}

class SqliteChatsRepo implements ChatsRepo {
  constructor(private readonly db: Db) {}

  listByProject(
    projectId: string,
    opts?: { includeArchived?: boolean },
  ): ChatSummary[] {
    const includeArchived = opts?.includeArchived ?? false;
    const rows = this.db
      .prepare<[string], ChatRow>(
        `SELECT * FROM chats
         WHERE project_id = ? ${includeArchived ? '' : 'AND archived = 0'}
         ORDER BY updated_at DESC`,
      )
      .all(projectId);
    const previewStmt = this.db.prepare<[string], { blocks: string }>(
      `SELECT blocks FROM messages WHERE chat_id = ? ORDER BY seq DESC LIMIT 1`,
    );
    return rows.map((row) => {
      const summary: ChatSummary = {
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        updatedAt: row.updated_at,
        archived: row.archived !== 0,
      };
      const last = previewStmt.get(row.id);
      if (last) {
        const preview = previewFromBlocks(last.blocks);
        if (preview !== undefined) summary.lastMessagePreview = preview;
      }
      return summary;
    });
  }

  get(id: string): Chat | undefined {
    const row = this.db
      .prepare<[string], ChatRow>(`SELECT * FROM chats WHERE id = ?`)
      .get(id);
    return row ? rowToChat(row) : undefined;
  }

  create(input: CreateChatInput): Chat {
    const ts = nowIso();
    const chat: Chat = {
      id: input.id ?? newId(),
      projectId: input.projectId,
      title: input.title ?? 'New chat',
      createdAt: ts,
      updatedAt: ts,
      archived: false,
    };
    if (input.modelOverride !== undefined) chat.modelOverride = input.modelOverride;
    if (input.runtimeOverride !== undefined)
      chat.runtimeOverride = input.runtimeOverride;
    if (input.claudeSessionId !== undefined)
      chat.claudeSessionId = input.claudeSessionId;
    this.db
      .prepare(
        `INSERT INTO chats
          (id, project_id, title, model_override, runtime_override, claude_session_id, archived, created_at, updated_at)
         VALUES (@id, @project_id, @title, @model_override, @runtime_override, @claude_session_id, @archived, @created_at, @updated_at)`,
      )
      .run({
        id: chat.id,
        project_id: chat.projectId,
        title: chat.title,
        model_override: chat.modelOverride ?? null,
        runtime_override: chat.runtimeOverride ?? null,
        claude_session_id: chat.claudeSessionId ?? null,
        archived: 0,
        created_at: chat.createdAt,
        updated_at: chat.updatedAt,
      });
    return chat;
  }

  update(id: string, patch: UpdateChatPatch): Chat {
    const existing = this.get(id);
    if (!existing) throw new Error(`Chat not found: ${id}`);
    const next: Chat = { ...existing, ...patch, updatedAt: nowIso() };
    this.db
      .prepare(
        `UPDATE chats SET
           title = @title,
           model_override = @model_override,
           runtime_override = @runtime_override,
           claude_session_id = @claude_session_id,
           archived = @archived,
           updated_at = @updated_at
         WHERE id = @id`,
      )
      .run({
        id,
        title: next.title,
        model_override: next.modelOverride ?? null,
        runtime_override: next.runtimeOverride ?? null,
        claude_session_id: next.claudeSessionId ?? null,
        archived: next.archived ? 1 : 0,
        updated_at: next.updatedAt,
      });
    return next;
  }

  setClaudeSession(id: string, sessionId: string | null): void {
    // Touch only the session column; do NOT bump updated_at — capturing a CLI
    // session id is an internal continuation detail, not user activity, so it
    // must not reorder the chat list. No-op when the chat is gone.
    this.db
      .prepare(`UPDATE chats SET claude_session_id = ? WHERE id = ?`)
      .run(sessionId, id);
  }

  remove(id: string): void {
    this.db.prepare(`DELETE FROM chats WHERE id = ?`).run(id);
  }
}

class SqliteMessagesRepo implements MessagesRepo {
  constructor(private readonly db: Db) {}

  list(chatId: string): ChatMessage[] {
    return this.db
      .prepare<[string], MessageRow>(
        `SELECT * FROM messages WHERE chat_id = ? ORDER BY seq ASC`,
      )
      .all(chatId)
      .map(rowToMessage);
  }

  append(input: AppendMessageInput): ChatMessage {
    assertAppendableBlocks(input.blocks);
    const ts = nowIso();
    const message: ChatMessage = {
      id: input.id ?? newId(),
      chatId: input.chatId,
      role: input.role,
      blocks: input.blocks,
      createdAt: ts,
    };
    if (input.usage !== undefined) message.usage = input.usage;
    if (input.model !== undefined) message.model = input.model;

    const tx = this.db.transaction(() => {
      const next = this.db
        .prepare<[string], { next_seq: number }>(
          `SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq FROM messages WHERE chat_id = ?`,
        )
        .get(input.chatId);
      const seq = next ? next.next_seq : 0;
      this.db
        .prepare(
          `INSERT INTO messages (id, chat_id, role, blocks, usage, model, created_at, seq)
           VALUES (@id, @chat_id, @role, @blocks, @usage, @model, @created_at, @seq)`,
        )
        .run({
          id: message.id,
          chat_id: message.chatId,
          role: message.role,
          blocks: toJson(message.blocks),
          usage: message.usage ? toJson(message.usage) : null,
          model: message.model ?? null,
          created_at: message.createdAt,
          seq,
        });
      // Bump the chat's updated_at so lists reorder correctly.
      this.db
        .prepare(`UPDATE chats SET updated_at = ? WHERE id = ?`)
        .run(ts, message.chatId);
    });
    tx();
    return message;
  }

  clear(chatId: string): void {
    this.db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(chatId);
  }
}

class SqliteRuntimesRepo implements RuntimesRepo {
  constructor(private readonly db: Db) {}

  private toRecord(row: RuntimeRow): RuntimeRecord {
    const record: RuntimeRecord = {
      id: row.id,
      label: row.label,
      ssh: fromJson<typeof sshSchema, RemoteRuntime['ssh']>(sshSchema, row.ssh),
      daemon: fromJson<typeof daemonSchema, RemoteRuntime['daemon']>(
        daemonSchema,
        row.daemon,
      ),
      apiKeyLocation: row.api_key_location === 'daemon' ? 'daemon' : 'app',
    };
    if (row.auth_token !== null) record.authToken = row.auth_token;
    return record;
  }

  list(): RuntimeRecord[] {
    return this.db
      .prepare<[], RuntimeRow>(`SELECT * FROM runtimes ORDER BY label ASC`)
      .all()
      .map((r) => this.toRecord(r));
  }

  get(id: string): RuntimeRecord | undefined {
    const row = this.db
      .prepare<[string], RuntimeRow>(`SELECT * FROM runtimes WHERE id = ?`)
      .get(id);
    return row ? this.toRecord(row) : undefined;
  }

  upsert(record: RuntimeRecord): RuntimeRecord {
    this.db
      .prepare(
        `INSERT INTO runtimes (id, label, ssh, daemon, api_key_location, auth_token)
         VALUES (@id, @label, @ssh, @daemon, @api_key_location, @auth_token)
         ON CONFLICT(id) DO UPDATE SET
           label = @label, ssh = @ssh, daemon = @daemon,
           api_key_location = @api_key_location, auth_token = @auth_token`,
      )
      .run({
        id: record.id,
        label: record.label,
        ssh: toJson(record.ssh),
        daemon: toJson(record.daemon),
        api_key_location: record.apiKeyLocation,
        auth_token: record.authToken ?? null,
      });
    return record;
  }

  remove(id: string): void {
    this.db.prepare(`DELETE FROM runtimes WHERE id = ?`).run(id);
  }
}

class SqliteSettingsRepo implements SettingsRepo {
  constructor(private readonly db: Db) {}

  get<T = unknown>(key: string): T | undefined {
    const row = this.db
      .prepare<[string], { value: string }>(
        `SELECT value FROM settings WHERE key = ?`,
      )
      .get(key);
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  set<T = unknown>(key: string, value: T): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (@key, @value)
         ON CONFLICT(key) DO UPDATE SET value = @value`,
      )
      .run({ key, value: toJson(value) });
  }

  delete(key: string): void {
    this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
  }

  all(): Record<string, unknown> {
    const rows = this.db
      .prepare<[], { key: string; value: string }>(`SELECT key, value FROM settings`)
      .all();
    const out: Record<string, unknown> = {};
    for (const row of rows) out[row.key] = JSON.parse(row.value);
    return out;
  }

  getGlobal(): GlobalSettings | undefined {
    return this.get<GlobalSettings>(GLOBAL_SETTINGS_KEY);
  }

  setGlobal(value: GlobalSettings): void {
    this.set(GLOBAL_SETTINGS_KEY, value);
  }
}

/** Best-effort preview text from a message's blocks (first text/thinking block). */
function previewFromBlocks(rawBlocks: string): string | undefined {
  const blocks = fromJson(blocksSchema, rawBlocks);
  for (const block of blocks) {
    if (block.kind === 'text' || block.kind === 'thinking') {
      const text = block.text.trim();
      if (text) return text.length > 140 ? `${text.slice(0, 140)}…` : text;
    }
  }
  return undefined;
}

/** SQLite-backed DbStore. Opens (creating the file + parent dir), runs migrations, enables WAL. */
export class SqliteDbStore implements DbStore {
  readonly projects: ProjectsRepo;
  readonly chats: ChatsRepo;
  readonly messages: MessagesRepo;
  readonly runtimes: RuntimesRepo;
  readonly settings: SettingsRepo;
  private readonly db: Db;

  constructor(options: SqliteStoreOptions = {}) {
    const path = options.path ?? defaultDbPath();
    const onDisk = path !== ':memory:';
    if (onDisk) mkdirSync(dirname(path), { recursive: true });

    this.db = new Database(path);
    this.db.pragma('foreign_keys = ON');
    const useWal = options.wal ?? onDisk;
    if (useWal) this.db.pragma('journal_mode = WAL');

    runMigrations(this.db);

    this.projects = new SqliteProjectsRepo(this.db);
    this.chats = new SqliteChatsRepo(this.db);
    this.messages = new SqliteMessagesRepo(this.db);
    this.runtimes = new SqliteRuntimesRepo(this.db);
    this.settings = new SqliteSettingsRepo(this.db);
  }

  schemaVersion(): number {
    return readSchemaVersion(this.db) || CURRENT_SCHEMA_VERSION;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  vacuum(): void {
    this.db.exec('VACUUM');
  }

  close(): void {
    this.db.close();
  }
}

/** Convenience factory mirroring the in-memory one. */
export function createSqliteDbStore(options?: SqliteStoreOptions): DbStore {
  return new SqliteDbStore(options);
}
