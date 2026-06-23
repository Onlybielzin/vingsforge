/**
 * In-memory DbStore for tests and previews — same contract as SqliteDbStore,
 * with deep-cloned records so callers can't mutate stored state (Spec 08 §2 testability).
 */
import type {
  Chat,
  ChatMessage,
  ChatSummary,
  GlobalSettings,
  Project,
} from '@vingsforge/shared';
import { CURRENT_SCHEMA_VERSION } from './migrations.js';
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

function clone<T>(value: T): T {
  return structuredClone(value);
}

function preview(message: ChatMessage | undefined): string | undefined {
  if (!message) return undefined;
  for (const block of message.blocks) {
    if (block.kind === 'text' || block.kind === 'thinking') {
      const text = block.text.trim();
      if (text) return text.length > 140 ? `${text.slice(0, 140)}…` : text;
    }
  }
  return undefined;
}

interface MemState {
  projects: Map<string, Project>;
  chats: Map<string, Chat>;
  /** chatId -> ordered messages (with their assigned seq). */
  messages: Map<string, Array<ChatMessage & { seq: number }>>;
  runtimes: Map<string, RuntimeRecord>;
  settings: Map<string, unknown>;
}

class MemProjectsRepo implements ProjectsRepo {
  constructor(private readonly s: MemState) {}

  list(): Project[] {
    return [...this.s.projects.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(clone);
  }

  get(id: string): Project | undefined {
    const p = this.s.projects.get(id);
    return p ? clone(p) : undefined;
  }

  create(input: CreateProjectInput): Project {
    const project: Project = {
      id: input.id ?? newId(),
      name: input.name,
      workspace: clone(input.workspace),
      runtimeId: input.runtimeId ?? 'local',
      createdAt: nowIso(),
    };
    if (input.defaultModel !== undefined) project.defaultModel = input.defaultModel;
    if (input.systemPromptExtra !== undefined)
      project.systemPromptExtra = input.systemPromptExtra;
    if (input.permissionPolicy !== undefined)
      project.permissionPolicy = clone(input.permissionPolicy);
    this.s.projects.set(project.id, clone(project));
    return clone(project);
  }

  update(id: string, patch: UpdateProjectPatch): Project {
    const existing = this.s.projects.get(id);
    if (!existing) throw new Error(`Project not found: ${id}`);
    const next: Project = { ...existing, ...clone(patch) };
    this.s.projects.set(id, next);
    return clone(next);
  }

  remove(id: string): void {
    this.s.projects.delete(id);
    // Cascade to chats + messages.
    for (const [chatId, chat] of this.s.chats) {
      if (chat.projectId === id) {
        this.s.chats.delete(chatId);
        this.s.messages.delete(chatId);
      }
    }
  }
}

class MemChatsRepo implements ChatsRepo {
  constructor(private readonly s: MemState) {}

  listByProject(
    projectId: string,
    opts?: { includeArchived?: boolean },
  ): ChatSummary[] {
    const includeArchived = opts?.includeArchived ?? false;
    return [...this.s.chats.values()]
      .filter(
        (c) => c.projectId === projectId && (includeArchived || !c.archived),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((chat) => {
        const msgs = this.s.messages.get(chat.id);
        const last = msgs && msgs.length ? msgs[msgs.length - 1] : undefined;
        const summary: ChatSummary = {
          id: chat.id,
          projectId: chat.projectId,
          title: chat.title,
          updatedAt: chat.updatedAt,
          archived: chat.archived,
        };
        const p = preview(last);
        if (p !== undefined) summary.lastMessagePreview = p;
        return summary;
      });
  }

  get(id: string): Chat | undefined {
    const c = this.s.chats.get(id);
    return c ? clone(c) : undefined;
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
    this.s.chats.set(chat.id, clone(chat));
    this.s.messages.set(chat.id, []);
    return clone(chat);
  }

  update(id: string, patch: UpdateChatPatch): Chat {
    const existing = this.s.chats.get(id);
    if (!existing) throw new Error(`Chat not found: ${id}`);
    const next: Chat = { ...existing, ...clone(patch), updatedAt: nowIso() };
    this.s.chats.set(id, next);
    return clone(next);
  }

  setClaudeSession(id: string, sessionId: string | null): void {
    const existing = this.s.chats.get(id);
    if (!existing) return;
    // Mirror the SQLite repo: update only the session field, leaving updatedAt
    // untouched so capturing a CLI session id doesn't reorder the chat list.
    const next: Chat = { ...existing };
    if (sessionId === null) delete next.claudeSessionId;
    else next.claudeSessionId = sessionId;
    this.s.chats.set(id, next);
  }

  remove(id: string): void {
    this.s.chats.delete(id);
    this.s.messages.delete(id);
  }
}

class MemMessagesRepo implements MessagesRepo {
  constructor(private readonly s: MemState) {}

  list(chatId: string): ChatMessage[] {
    const msgs = this.s.messages.get(chatId) ?? [];
    return msgs
      .slice()
      .sort((a, b) => a.seq - b.seq)
      .map(({ seq: _seq, ...rest }) => clone(rest));
  }

  append(input: AppendMessageInput): ChatMessage {
    assertAppendableBlocks(input.blocks);
    const ts = nowIso();
    const list = this.s.messages.get(input.chatId) ?? [];
    const seq = list.length
      ? Math.max(...list.map((m) => m.seq)) + 1
      : 0;
    const message: ChatMessage = {
      id: input.id ?? newId(),
      chatId: input.chatId,
      role: input.role,
      blocks: clone(input.blocks),
      createdAt: ts,
    };
    if (input.usage !== undefined) message.usage = clone(input.usage);
    if (input.model !== undefined) message.model = input.model;
    list.push({ ...clone(message), seq });
    this.s.messages.set(input.chatId, list);
    const chat = this.s.chats.get(input.chatId);
    if (chat) chat.updatedAt = ts;
    return clone(message);
  }

  clear(chatId: string): void {
    this.s.messages.set(chatId, []);
  }
}

class MemRuntimesRepo implements RuntimesRepo {
  constructor(private readonly s: MemState) {}

  list(): RuntimeRecord[] {
    return [...this.s.runtimes.values()]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(clone);
  }

  get(id: string): RuntimeRecord | undefined {
    const r = this.s.runtimes.get(id);
    return r ? clone(r) : undefined;
  }

  upsert(record: RuntimeRecord): RuntimeRecord {
    this.s.runtimes.set(record.id, clone(record));
    return clone(record);
  }

  remove(id: string): void {
    this.s.runtimes.delete(id);
  }
}

class MemSettingsRepo implements SettingsRepo {
  constructor(private readonly s: MemState) {}

  get<T = unknown>(key: string): T | undefined {
    return this.s.settings.has(key)
      ? clone(this.s.settings.get(key) as T)
      : undefined;
  }

  set<T = unknown>(key: string, value: T): void {
    this.s.settings.set(key, clone(value));
  }

  delete(key: string): void {
    this.s.settings.delete(key);
  }

  all(): Record<string, unknown> {
    return clone(Object.fromEntries(this.s.settings));
  }

  getGlobal(): GlobalSettings | undefined {
    return this.get<GlobalSettings>(GLOBAL_SETTINGS_KEY);
  }

  setGlobal(value: GlobalSettings): void {
    this.set(GLOBAL_SETTINGS_KEY, value);
  }
}

/** Fully in-memory DbStore. Transactions are best-effort (run the fn directly). */
export class InMemoryDbStore implements DbStore {
  readonly projects: ProjectsRepo;
  readonly chats: ChatsRepo;
  readonly messages: MessagesRepo;
  readonly runtimes: RuntimesRepo;
  readonly settings: SettingsRepo;
  private readonly state: MemState;

  constructor() {
    this.state = {
      projects: new Map(),
      chats: new Map(),
      messages: new Map(),
      runtimes: new Map(),
      settings: new Map([['schema_version', CURRENT_SCHEMA_VERSION]]),
    };
    this.projects = new MemProjectsRepo(this.state);
    this.chats = new MemChatsRepo(this.state);
    this.messages = new MemMessagesRepo(this.state);
    this.runtimes = new MemRuntimesRepo(this.state);
    this.settings = new MemSettingsRepo(this.state);
  }

  schemaVersion(): number {
    return CURRENT_SCHEMA_VERSION;
  }

  transaction<T>(fn: () => T): T {
    return fn();
  }

  vacuum(): void {
    // no-op
  }

  close(): void {
    this.state.projects.clear();
    this.state.chats.clear();
    this.state.messages.clear();
    this.state.runtimes.clear();
    this.state.settings.clear();
  }
}

/** Convenience factory. */
export function createInMemoryDbStore(): DbStore {
  return new InMemoryDbStore();
}
