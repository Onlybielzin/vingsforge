/**
 * ProjectManager (Spec 01): CRUD over the DbStore plus the local-workspace side
 * effects — create/adopt a folder, detect AGENTS.md/FORGE.md, and safe removal
 * with optional file deletion. Implements the {@link ProjectsAPI} contract.
 */
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type {
  ChatSummary,
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
