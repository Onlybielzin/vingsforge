/**
 * ProjectManager (Spec 01): CRUD over the DbStore plus the local-workspace side
 * effects — create/adopt a folder, detect AGENTS.md/FORGE.md, and safe removal
 * with optional file deletion. Implements the {@link ProjectsAPI} contract.
 */
import { spawn } from 'node:child_process';
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  encodeProjectDir,
  isSessionId,
  parseSessionPreview,
} from './external-sessions.js';
import type {
  ChatSummary,
  ExternalSession,
  PermissionPolicy,
  Project,
  ProjectsAPI,
  WorkspaceRef,
  Worktree,
} from '@vingsforge/shared';
import {
  permissionPolicySchema,
  type CreateProjectInput,
  type DbStore,
  type UpdateProjectPatch,
} from '@vingsforge/persistence';
import {
  deleteWorkspaceFiles,
  deriveProjectName,
  detectInstructionFile,
  ensureLocalWorkspace,
  isLocalWorkspace,
  type InstructionFile,
} from './workspace-fs.js';

/** Raised when an operation targets a project id that is not in the registry. */
export class ProjectNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`project not found: ${id}`);
    this.name = 'ProjectNotFoundError';
  }
}

/** Raised when a workspace/runtime ref points at a runtime that does not exist. */
export class RuntimeNotFoundError extends Error {
  constructor(readonly runtimeId: string) {
    super(`runtime not found: ${runtimeId}`);
    this.name = 'RuntimeNotFoundError';
  }
}

// --- Input validation (Spec 01 §5) -----------------------------------------

const nameSchema = z.string().trim().min(1).max(200);

/**
 * A remote workspace path is handed to the VPS daemon for fs-list/execution
 * (Spec 05), so it must be a non-empty absolute path with no `..` traversal
 * segments. Local paths are canonicalized on disk separately.
 */
const remotePathSchema = z
  .string()
  .min(1)
  .refine((p) => isAbsolute(p), { message: 'remote path must be absolute' })
  .refine((p) => !p.split(/[/\\]/).includes('..'), {
    message: 'remote path must not contain ".." segments',
  });

/** workspaceRefSchema with the remote path tightened for untrusted input. */
const inputWorkspaceRefSchema = z.union([
  z.object({ kind: z.literal('local'), path: z.string() }),
  z.object({
    kind: z.literal('remote'),
    runtimeId: z.string().min(1),
    path: remotePathSchema,
  }),
]);

const createInputSchema = z
  .object({
    name: nameSchema.optional(),
    workspace: inputWorkspaceRefSchema,
    runtimeId: z.string().min(1).optional(),
    /** When set on a local workspace, create the folder if it does not exist. */
    createFolder: z.boolean().optional(),
  })
  .strict();

const updatePatchSchema = z
  .object({
    name: nameSchema.optional(),
    workspace: inputWorkspaceRefSchema.optional(),
    runtimeId: z.string().min(1).optional(),
    defaultModel: z.string().min(1).optional(),
    systemPromptExtra: z.string().optional(),
    permissionPolicy: permissionPolicySchema.optional(),
    lastOpenedAt: z.string().min(1).optional(),
  })
  .strict();

const removeOptsSchema = z
  .object({ deleteFiles: z.boolean() })
  .strict();

/** Input accepted by {@link ProjectManager.create} (a superset of the IPC input). */
export type CreateProjectArgs = z.infer<typeof createInputSchema>;

/** Result of {@link ProjectManager.open}: the project plus its chat list and detected instructions. */
export interface OpenProjectResult {
  project: Project;
  chats: ChatSummary[];
  /** The detected AGENTS.md/FORGE.md, if any (Spec 01 RF-07). */
  instructions?: InstructionFile;
}

/**
 * Project lifecycle service. Stateless beyond its injected {@link DbStore}, so it
 * is safe to construct per request or hold as a singleton.
 */
export class ProjectManager implements ProjectsAPI {
  constructor(private readonly db: DbStore) {}

  /** All projects, oldest first (registry order from the store). */
  async list(): Promise<Project[]> {
    return this.db.projects.list();
  }

  /**
   * Create a project from a workspace folder (Spec 01 §4.1). For local
   * workspaces the folder is ensured to exist (optionally created); remote
   * workspaces are recorded as-is and resolved later via the daemon (Spec 05).
   */
  async create(input: {
    name?: string;
    workspace: WorkspaceRef;
    runtimeId?: string;
    createFolder?: boolean;
  }): Promise<Project> {
    const args = createInputSchema.parse(input);
    const workspace = await this.prepareWorkspace(args.workspace, args.createFolder ?? false);

    const create: CreateProjectInput = {
      name: args.name ?? deriveProjectName(workspace),
      workspace,
    };
    // runtimeId defaults to the workspace's runtime for remote refs, else 'local'.
    const runtimeId =
      args.runtimeId ?? (workspace.kind === 'remote' ? workspace.runtimeId : 'local');
    if (runtimeId !== undefined) {
      this.requireRuntime(runtimeId);
      create.runtimeId = runtimeId;
    }

    return this.db.transaction(() => this.db.projects.create(create));
  }

  /**
   * Open a project: stamps `lastOpenedAt`, returns its chats and any detected
   * project-instruction file for system-prompt injection (Spec 01 §4.1, RF-07).
   */
  async open(id: string): Promise<OpenProjectResult> {
    const existing = this.requireProject(id);
    const project = this.db.projects.update(id, {
      lastOpenedAt: new Date().toISOString(),
    });
    const chats = this.db.chats.listByProject(id);
    const instructions = await detectInstructionFile(existing.workspace);
    const result: OpenProjectResult = { project, chats };
    if (instructions) result.instructions = instructions;
    return result;
  }

  /** Rename the project label only — never moves the workspace folder (Spec 01 RF-04). */
  async rename(id: string, name: string): Promise<void> {
    const parsed = nameSchema.parse(name);
    this.requireProject(id);
    this.db.projects.update(id, { name: parsed });
  }

  /**
   * Patch project configuration (Spec 01 RF-06). Only the whitelisted, mutable
   * fields are applied; unknown keys are rejected by the schema. A local
   * workspace change re-validates the new folder.
   */
  async updateConfig(id: string, patch: Partial<Project>): Promise<Project> {
    const parsed = updatePatchSchema.parse(patch);
    this.requireProject(id);

    const update: UpdateProjectPatch = {};
    if (parsed.name !== undefined) update.name = parsed.name;
    if (parsed.runtimeId !== undefined) {
      this.requireRuntime(parsed.runtimeId);
      update.runtimeId = parsed.runtimeId;
    }
    if (parsed.defaultModel !== undefined) update.defaultModel = parsed.defaultModel;
    if (parsed.systemPromptExtra !== undefined)
      update.systemPromptExtra = parsed.systemPromptExtra;
    if (parsed.permissionPolicy !== undefined)
      update.permissionPolicy = parsed.permissionPolicy as PermissionPolicy;
    if (parsed.lastOpenedAt !== undefined) update.lastOpenedAt = parsed.lastOpenedAt;
    if (parsed.workspace !== undefined) {
      update.workspace = await this.prepareWorkspace(parsed.workspace, false);
    }

    return this.db.transaction(() => this.db.projects.update(id, update));
  }

  /**
   * Remove a project from the registry (Spec 01 RF-05). The workspace folder is
   * preserved unless `deleteFiles` is explicitly true — in which case the local
   * folder is deleted only after the registry row is gone, and only for local
   * workspaces (remote deletion is out of scope here).
   */
  async remove(id: string, opts: { deleteFiles: boolean }): Promise<void> {
    const { deleteFiles } = removeOptsSchema.parse(opts);
    // Read the workspace straight from the store by id so the path handed to the
    // (most destructive) delete is the stored ref, never a raw caller argument.
    const project = this.requireProject(id);
    const workspace = project.workspace;

    this.db.transaction(() => this.db.projects.remove(id));

    if (deleteFiles && isLocalWorkspace(workspace)) {
      await deleteWorkspaceFiles(workspace.path);
    }
  }

  /**
   * List the git worktrees of a project's repository (Spec 01). Remote
   * workspaces have no local repo to inspect, so they return `[]`. For local
   * workspaces this runs `git -C <root> worktree list --porcelain` and parses the
   * porcelain output. If the folder is not a git repository (git exits non-zero),
   * `[]` is returned rather than throwing — a missing repo must not break the UI.
   *
   * SECURITY: git is spawned WITHOUT a shell and with a fixed argv; only the
   * stored, already-validated workspace root is passed via `-C`, so no caller
   * input is ever interpolated into a command line.
   */
  async worktrees(projectId: string): Promise<Worktree[]> {
    const project = this.requireProject(projectId);
    const workspace = project.workspace;
    if (!isLocalWorkspace(workspace)) return [];

    let stdout: string;
    try {
      stdout = await runGitWorktreeList(workspace.path);
    } catch {
      // Not a git repo, git missing, or any spawn failure: degrade to empty.
      return [];
    }
    return parseWorktreePorcelain(stdout);
  }

  /**
   * List the Claude Code CLI sessions started OUTSIDE the app for this project's
   * local workspace (Spec: continue terminal sessions). Remote workspaces have no
   * local transcript folder, so they return `[]`.
   *
   * Resolves `~/.claude/projects/<encode(workspace.path)>/`, lists its `*.jsonl`
   * files newest-first by mtime, and builds an {@link ExternalSession} per file.
   * Only the first {@link PREVIEW_LINES} lines of each transcript are read so a
   * multi-megabyte session does not get slurped into memory just to preview it.
   *
   * ROBUSTNESS: a missing folder yields `[]` (not an error); a session whose name
   * is not a UUID is skipped before any read; a transcript that fails to read or
   * parse is skipped rather than failing the whole call (one bad file must not
   * hide every other session). SECURITY: reads are confined to
   * `~/.claude/projects` — the resolved per-session path is re-checked to live
   * under that root, so a crafted workspace path can never escape it.
   */
  async externalSessions(projectId: string): Promise<ExternalSession[]> {
    const project = this.requireProject(projectId);
    const workspace = project.workspace;
    if (!isLocalWorkspace(workspace)) return [];

    const root = claudeProjectsRoot();
    const dir = join(root, encodeProjectDir(workspace.path));
    // Confine to ~/.claude/projects: reject anything that resolves outside it.
    if (!isInside(root, dir)) return [];

    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      // Folder absent (no sessions yet) or unreadable: nothing to import.
      return [];
    }

    const candidates: { sessionId: string; file: string; mtimeMs: number; size: number }[] = [];
    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const sessionId = name.slice(0, -'.jsonl'.length);
      // Validate the UUID shape BEFORE touching the file.
      if (!isSessionId(sessionId)) continue;
      const file = join(dir, name);
      if (!isInside(root, file)) continue;
      try {
        const info = await stat(file);
        if (!info.isFile()) continue;
        candidates.push({ sessionId, file, mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        continue;
      }
    }

    // Newest first.
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const sessions: ExternalSession[] = [];
    for (const c of candidates) {
      try {
        const head = await readHeadLines(c.file, PREVIEW_LINES, c.size);
        const { preview, turns } = parseSessionPreview(head);
        const session: ExternalSession = {
          sessionId: c.sessionId,
          updatedAt: new Date(c.mtimeMs).toISOString(),
          preview,
        };
        if (turns > 0) session.turns = turns;
        sessions.push(session);
      } catch {
        // Never let one malformed/unreadable transcript break the listing.
        continue;
      }
    }
    return sessions;
  }

  /**
   * Read the FULL NDJSON transcript of an external Claude Code session for a
   * project's local workspace, as a list of lines. Used by the chat importer to
   * reconstruct history. Mirrors the confinement of {@link externalSessions}: the
   * `sessionId` must be a valid UUID, the workspace must be local, and the
   * resolved path must live under `~/.claude/projects`. Throws a clear error when
   * the session id is invalid, the workspace is remote, or the file is missing —
   * the importer surfaces these to the UI rather than creating an empty chat.
   */
  async readSessionTranscript(
    projectId: string,
    sessionId: string,
  ): Promise<string[]> {
    if (!isSessionId(sessionId)) {
      throw new Error(`invalid session id: ${sessionId}`);
    }
    const project = this.requireProject(projectId);
    const workspace = project.workspace;
    if (!isLocalWorkspace(workspace)) {
      throw new Error('external sessions are only available for local workspaces');
    }
    const root = claudeProjectsRoot();
    const file = join(root, encodeProjectDir(workspace.path), `${sessionId}.jsonl`);
    if (!isInside(root, file)) {
      throw new Error('resolved transcript path escapes the Claude projects root');
    }
    // Cap the read BEFORE touching the file: a multi-GB .jsonl in
    // ~/.claude/projects (the user's own dir, but also a tamper/corruption
    // surface) must never be slurped whole into the sidecar heap. stat() first,
    // reject anything past a hard size cap, and otherwise read only a bounded
    // tail — the importer keeps the most recent messages, so the tail carries
    // exactly what we mirror; the CLI retains the full session for `--resume`.
    let size: number;
    try {
      const info = await stat(file);
      if (!info.isFile()) {
        throw new Error(`Claude Code session transcript not found: ${sessionId}`);
      }
      size = info.size;
    } catch {
      throw new Error(`Claude Code session transcript not found: ${sessionId}`);
    }
    if (size > TRANSCRIPT_MAX_BYTES) {
      throw new Error(
        `Claude Code session transcript too large to import: ${sessionId} ` +
          `(${size} bytes exceeds the ${TRANSCRIPT_MAX_BYTES}-byte cap)`,
      );
    }
    try {
      return await readTailLines(file, size);
    } catch {
      throw new Error(`Claude Code session transcript not found: ${sessionId}`);
    }
  }

  // --- internals ------------------------------------------------------------

  private requireProject(id: string): Project {
    const project = this.db.projects.get(id);
    if (!project) throw new ProjectNotFoundError(id);
    return project;
  }

  /**
   * Ensure a runtimeId refers to a real runtime before it is persisted. The
   * `'local'` sentinel has no runtimes row and is always accepted; any other id
   * must exist so a project can never be repointed at an unknown/attacker-chosen
   * runtime (Spec 05).
   */
  private requireRuntime(runtimeId: string): void {
    if (runtimeId === 'local') return;
    if (!this.db.runtimes.get(runtimeId)) throw new RuntimeNotFoundError(runtimeId);
  }

  /**
   * Resolve/validate a workspace ref. Local paths are canonicalized on disk;
   * remote refs are validated (absolute, no `..` segments — enforced by the
   * input schema) and their runtime is verified to exist before the ref is
   * handed to the daemon (Spec 05).
   */
  private async prepareWorkspace(
    ref: WorkspaceRef,
    createFolder: boolean,
  ): Promise<WorkspaceRef> {
    if (!isLocalWorkspace(ref)) {
      this.requireRuntime(ref.runtimeId);
      return ref;
    }
    const path = await ensureLocalWorkspace(ref.path, { create: createFolder });
    return { kind: 'local', path };
  }
}

// --- external Claude Code session helpers ------------------------------------

/** Cap on how many leading transcript lines we read just to build a preview. */
const PREVIEW_LINES = 40;

/**
 * A transcript's head is enough to build a preview, so we still cap the total
 * size we'll consider at preview time. The read itself is already bounded (see
 * {@link readHeadLines}); this extra guard means a pathologically large head
 * line never even reaches that read for a one-line preview.
 */
const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Root of the Claude Code transcript store: `<HOME>/.claude/projects`. Reads
 * `HOME` from the environment (falling back to the OS home dir) so a test or a
 * non-default profile can point it elsewhere, matching how the CLI resolves it.
 */
function claudeProjectsRoot(): string {
  const home = process.env.HOME ?? homedir();
  return join(home, '.claude', 'projects');
}

/**
 * True when `child` resolves to `root` itself or a path strictly under it. Guards
 * the transcript reads against path traversal from a crafted workspace path.
 */
function isInside(root: string, child: string): boolean {
  const r = resolve(root);
  const c = resolve(child);
  return c === r || c.startsWith(r + sep);
}

/** Largest first chunk we read to derive a preview, regardless of file size. */
const PREVIEW_HEAD_BYTES = 256 * 1024;

/**
 * Hard cap on a transcript we will import. Larger files are rejected outright
 * rather than read, so a multi-GB .jsonl can never reach the sidecar heap. The
 * importer only persists the most recent {@link IMPORT_MESSAGE_LIMIT} messages,
 * and the CLI keeps the full session for `--resume`, so a tail of this size is
 * always more than enough context to mirror locally.
 */
const TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;

/** Largest trailing chunk we read from a transcript when importing it. */
const TRANSCRIPT_TAIL_BYTES = 16 * 1024 * 1024;

/**
 * Read the TAIL of a transcript as lines without loading the whole file. We read
 * at most a single bounded chunk (`TRANSCRIPT_TAIL_BYTES`) from the END via a
 * file descriptor, so heap usage stays O(chunk) instead of O(file). The caller
 * has already rejected files past {@link TRANSCRIPT_MAX_BYTES}; this further
 * bounds the read to the recent tail, which is all the importer keeps. When the
 * file is larger than the chunk the first (partial) line is dropped — that line
 * fails `JSON.parse` in {@link jsonlToBlocks} and would be skipped regardless.
 * `size` is the value already returned by the caller's `stat()`.
 */
async function readTailLines(file: string, size: number): Promise<string[]> {
  if (size <= 0) return [];
  const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
  const position = size - length;
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    const text = buffer.toString('utf8', 0, bytesRead);
    const lines = text.split('\n');
    // Drop the leading partial line only when we did not read from the start.
    if (position > 0 && lines.length > 0) lines.shift();
    return lines;
  } finally {
    await handle.close();
  }
}

/**
 * Read at most `maxLines` lines from the START of a file without loading the
 * whole thing. Transcripts can be huge (multi-hundred-MB terminal logs), and we
 * only need the head to derive a preview/turn count, so we read at most a single
 * bounded chunk (`PREVIEW_HEAD_BYTES`) via a file descriptor and split that —
 * heap usage stays O(chunk) instead of O(file). `size` is the value already
 * returned by the caller's `stat()`: files larger than {@link PREVIEW_MAX_BYTES}
 * are skipped (empty preview) rather than read at all.
 */
async function readHeadLines(file: string, maxLines: number, size: number): Promise<string[]> {
  if (size > PREVIEW_MAX_BYTES) return [];
  const length = Math.min(size, PREVIEW_HEAD_BYTES);
  if (length <= 0) return [];
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const text = buffer.toString('utf8', 0, bytesRead);
    return text.split('\n').slice(0, maxLines);
  } finally {
    await handle.close();
  }
}

// --- git worktree helpers ----------------------------------------------------

/**
 * Run `git -C <root> worktree list --porcelain` without a shell and capture
 * stdout. Rejects when git is unavailable, the spawn fails, or git exits
 * non-zero (e.g. the folder is not a repository) so the caller can map those to
 * an empty list. `root` is the stored, validated workspace path — never raw
 * user input — and is passed as a discrete argv entry, so it cannot be
 * interpreted as a flag or injected into a command line.
 */
function runGitWorktreeList(root: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`git worktree list exited ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Parse `git worktree list --porcelain` output into {@link Worktree} records.
 *
 * The porcelain format is a sequence of blocks separated by blank lines. Each
 * block starts with `worktree <path>` and may carry `HEAD <sha>`,
 * `branch refs/heads/<name>`, `detached`, `locked`, and `bare` lines. The first
 * block is the repository's main working tree (`isMain: true`). Bare repos have
 * no working files and no HEAD; they are skipped so consumers only see real
 * worktrees.
 *
 * Exported for unit testing: this is a pure function over the porcelain text and
 * is verified directly with fixtures, without spawning git.
 */
export function parseWorktreePorcelain(output: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let mainAssigned = false;

  // Split into blocks on blank lines; tolerate CRLF and trailing whitespace.
  for (const rawBlock of output.split(/\r?\n\r?\n/)) {
    const lines = rawBlock.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length === 0) continue;

    let path: string | undefined;
    let head: string | undefined;
    let branch: string | undefined;
    let isDetached = false;
    let isLocked = false;
    let isBare = false;

    for (const line of lines) {
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length);
      else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length);
        branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      } else if (line === 'detached') isDetached = true;
      else if (line === 'locked' || line.startsWith('locked ')) isLocked = true;
      else if (line === 'bare') isBare = true;
    }

    if (path === undefined) continue;

    // Bare repos have no working tree/HEAD; skip them entirely. A bare first
    // block must not consume the "main" flag — the first real worktree gets it.
    if (isBare) continue;

    // The first emitted worktree is the repository's main working tree.
    const isMain = !mainAssigned;
    mainAssigned = true;

    const worktree: Worktree = {
      path,
      head: head ?? '',
      isMain,
    };
    if (branch !== undefined) worktree.branch = branch;
    if (isDetached) worktree.isDetached = true;
    if (isLocked) worktree.isLocked = true;
    worktrees.push(worktree);
  }

  return worktrees;
}
