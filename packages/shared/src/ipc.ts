/**
 * IPC contracts between renderer (React) and the engine host / sidecar.
 * Specs 01 §5, 02 §5, 05 §7, 07 §5.
 *
 * These are declared as interfaces of (possibly async) methods. The transport
 * (Tauri commands + stdio, or WebSocket for remote) is an implementation detail;
 * these contracts stay stable across transports (Spec 09 §8).
 */
import type { Project, WorkspaceRef } from './project.js';
import type { Worktree } from './worktree.js';
import type { Chat, ChatMessage, ChatSummary } from './chat.js';
import type { DirEntry, RemoteRuntime } from './runtime.js';
import type {
  ApiKeyTestResult,
  GlobalSettings,
  ModelInfo,
} from './settings.js';
import type { ModelId } from './common.js';
import type { PermissionModes } from './permissions.js';

/** Projects API — Spec 01 §5. */
export interface ProjectsAPI {
  list(): Promise<Project[]>;
  create(input: {
    name?: string;
    workspace: WorkspaceRef;
    runtimeId?: string;
  }): Promise<Project>;
  open(id: string): Promise<{ project: Project; chats: ChatSummary[] }>;
  rename(id: string, name: string): Promise<void>;
  updateConfig(id: string, patch: Partial<Project>): Promise<Project>;
  remove(id: string, opts: { deleteFiles: boolean }): Promise<void>;
  /**
   * List the git worktrees of a project's repository. Returns `[]` for remote
   * workspaces or when the local workspace is not a git repository (never throws
   * for a non-repo folder).
   */
  worktrees(projectId: string): Promise<Worktree[]>;
}

/** Chats API — Spec 02 §5. Engine events stream over a dedicated `engine.events` channel. */
export interface ChatsAPI {
  list(projectId: string): Promise<ChatSummary[]>;
  create(
    projectId: string,
    opts?: { model?: ModelId; runtimeId?: string },
  ): Promise<Chat>;
  history(chatId: string): Promise<ChatMessage[]>;
  /**
   * Triggers an engine turn; emits EngineEvent via the stream. `modes` carries
   * the chat's quick permission modes (read-only / auto-approve) for the turn so
   * the engine can gate tool calls server-side — they are a real safety control,
   * not just UI state (Spec 04 §3.2, Spec 05 §5). The implementation forwards
   * them onto the turn's {@link EngineSendContext.modes}.
   */
  send(chatId: string, text: string, modes?: PermissionModes): Promise<void>;
  interrupt(chatId: string): Promise<void>;
  rename(chatId: string, title: string): Promise<void>;
  archive(chatId: string): Promise<void>;
  delete(chatId: string): Promise<void>;
}

/**
 * Engine metadata API — exposes the capabilities the `claude` CLI advertised on
 * its last `system/init` event (its slash commands and skills). The host caches
 * the arrays from each turn's init event; this returns the latest snapshot, or
 * empty arrays when no turn has run yet.
 */
export interface EngineMetaAPI {
  meta(): Promise<EngineMeta>;
}

/** Snapshot of the `claude` CLI's advertised slash commands / skills. */
export interface EngineMeta {
  slashCommands: string[];
  skills: string[];
}

/**
 * Self-update API — drives the in-app git auto-updater against the VingsForge
 * checkout (Settings `repoDir`, or the app's built-in default). `status` is a
 * read-only probe (git fetch + count of commits behind upstream); `run` kicks
 * off the build/install pipeline whose progress streams over the engine event
 * channel as `update.log` / `update.done` events. Neither interpolates user
 * input into a shell — the repo dir comes from settings and is validated.
 */
export interface UpdateAPI {
  status(): Promise<UpdateStatus>;
  /** Starts the update pipeline; progress arrives as update.* engine events. */
  run(): Promise<void>;
}

/** Result of probing the checkout against its upstream (UpdateAPI.status). */
export interface UpdateStatus {
  /** Commits the local HEAD is behind its upstream (`HEAD..@{u}`). */
  behind: number;
  /** Short SHA of the local HEAD. */
  current: string;
  /** Short SHA of the upstream tip (`@{u}`). */
  latest: string;
  /** The resolved repo directory the probe ran against. */
  repoDir: string;
  /** Convenience flag: `behind > 0`. */
  available: boolean;
}

/** Remote runtimes API — Spec 05 §7. */
export interface RuntimesAPI {
  list(): Promise<RemoteRuntime[]>;
  add(input: {
    label: string;
    ssh: RemoteRuntime['ssh'];
    daemon: RemoteRuntime['daemon'];
    apiKeyLocation: RemoteRuntime['apiKeyLocation'];
  }): Promise<RemoteRuntime>;
  connect(id: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  /** Installs/updates the daemon on the VPS; streams a log (Spec 05 RF-02). */
  installDaemon(id: string): Promise<void>;
  fsList(id: string, path: string): Promise<DirEntry[]>;
  remove(id: string): Promise<void>;
}

/** Settings + models API — Spec 07 §5. */
export interface SettingsAPI {
  get(): Promise<GlobalSettings>;
  update(patch: Partial<GlobalSettings>): Promise<GlobalSettings>;
  /** Writes the key to OS secure storage (Spec 07 §3, §6). */
  setApiKey(key: string): Promise<void>;
  clearApiKey(): Promise<void>;
  testApiKey(): Promise<ApiKeyTestResult>;
  /** Lists models via the Models API when online (Spec 07 §5). */
  models(): Promise<ModelInfo[]>;
}
