/**
 * Filesystem helpers backing the ProjectManager (Spec 01 §4/§7): create or adopt
 * a local workspace folder, detect project-instruction files (AGENTS.md/FORGE.md),
 * and safely delete a workspace tree on explicit request.
 */
import { lstat, open, readdir, realpath, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { appDataDir } from '@vingsforge/persistence';
import type { WorkspaceRef } from '@vingsforge/shared';

/**
 * Project-instruction filenames detected at the workspace root, in precedence
 * order (Spec 01 RF-07). The first one found wins.
 */
export const INSTRUCTION_FILE_NAMES = ['AGENTS.md', 'FORGE.md'] as const;

export type InstructionFileName = (typeof INSTRUCTION_FILE_NAMES)[number];

/**
 * Hard cap on the bytes read from an instruction file. The content is injected
 * verbatim into the agent system prompt (Spec 01 RF-07 / Spec 03), so an
 * unbounded read of a hostile/huge file would blow up the prompt and the token
 * budget. Files larger than this are read truncated to the cap (never rejected,
 * to stay non-throwing for "present but oversized").
 */
export const MAX_INSTRUCTION_FILE_BYTES = 256 * 1024;

/** A detected project-instruction file plus its contents. */
export interface InstructionFile {
  name: InstructionFileName;
  /** Absolute path to the file (canonicalized via realpath, inside the root). */
  path: string;
  /**
   * File contents, capped at {@link MAX_INSTRUCTION_FILE_BYTES}. SECURITY: this
   * is attacker-controllable, workspace-supplied text (indirect prompt
   * injection). Callers assembling the system prompt MUST treat it as untrusted
   * data, not as trusted system instructions.
   */
  content: string;
  /** True when the on-disk file exceeded the cap and `content` was truncated. */
  truncated: boolean;
}

/** Raised when a workspace path is rejected (not absolute, missing, not a dir, unsafe to delete). */
export class WorkspaceError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`workspace '${path}': ${reason}`);
    this.name = 'WorkspaceError';
  }
}

/** True only for local workspaces, which are the ones this host can touch on disk. */
export function isLocalWorkspace(
  ref: WorkspaceRef,
): ref is Extract<WorkspaceRef, { kind: 'local' }> {
  return ref.kind === 'local';
}

/**
 * Ensure a local workspace folder exists and is a directory, creating it (and
 * any missing parents) when `create` is set. Returns the canonical absolute path.
 * Remote workspaces are never touched here — the caller resolves them via the
 * remote daemon (Spec 05).
 */
export async function ensureLocalWorkspace(
  rawPath: string,
  opts: { create?: boolean } = {},
): Promise<string> {
  if (!isAbsolute(rawPath)) {
    throw new WorkspaceError(rawPath, 'path must be absolute');
  }
  const path = resolve(rawPath);
  let info;
  try {
    info = await stat(path);
  } catch {
    if (opts.create) {
      await mkdir(path, { recursive: true });
      return path;
    }
    throw new WorkspaceError(path, 'folder does not exist');
  }
  if (!info.isDirectory()) {
    throw new WorkspaceError(path, 'path exists but is not a directory');
  }
  return path;
}

/** True when `child` is the canonical root itself or nested under it. */
function isInsideRoot(root: string, child: string): boolean {
  if (child === root) return true;
  const rel = relative(root, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Detect the first project-instruction file at the workspace root and read it
 * (Spec 01 RF-07). Returns `undefined` when none is present or the workspace is
 * remote/unreadable. Never throws for a missing file.
 *
 * SECURITY: the content is injected verbatim into the agent system prompt and
 * shipped to the Anthropic API (Spec 03), so this read is hardened against
 * exfiltration and prompt injection, mirroring the realpath confinement in
 * tools/workspace.ts (`resolveExisting`):
 *  - The candidate is rejected if it is a symlink (`lstat`), so a planted
 *    `AGENTS.md -> ~/.ssh/id_rsa` (or any out-of-tree target) is never read.
 *  - The resolved path is canonicalized via `realpath` and asserted to stay
 *    inside the canonical workspace root, defeating intermediate-symlink and
 *    `..` escapes even on case-insensitive/symlinked roots.
 *  - The read is capped at {@link MAX_INSTRUCTION_FILE_BYTES}; larger files are
 *    truncated, never read whole.
 * The returned `content` is still attacker-controlled — see {@link InstructionFile}.
 */
export async function detectInstructionFile(
  ref: WorkspaceRef,
): Promise<InstructionFile | undefined> {
  if (!isLocalWorkspace(ref)) return undefined;

  // Canonicalize the workspace root once so symlinked roots compare correctly.
  let root: string;
  try {
    root = await realpath(resolve(ref.path));
  } catch {
    return undefined;
  }

  for (const name of INSTRUCTION_FILE_NAMES) {
    const filePath = join(root, name);
    try {
      // lstat (does NOT follow symlinks): refuse a symlinked candidate outright.
      const link = await lstat(filePath);
      if (link.isSymbolicLink()) continue;
      if (!link.isFile()) continue;

      // Canonicalize and assert the real target is still inside the root. This
      // also defends against a symlinked parent directory component.
      const real = await realpath(filePath);
      if (!isInsideRoot(root, real)) continue;

      const info = await stat(real);
      if (!info.isFile()) continue;

      // Read at most the cap, no matter the on-disk size.
      const handle = await open(real, 'r');
      try {
        const buf = Buffer.alloc(MAX_INSTRUCTION_FILE_BYTES);
        const { bytesRead } = await handle.read(buf, 0, MAX_INSTRUCTION_FILE_BYTES, 0);
        const truncated = info.size > MAX_INSTRUCTION_FILE_BYTES;
        const content = buf.toString('utf8', 0, bytesRead);
        return { name, path: real, content, truncated };
      } finally {
        await handle.close();
      }
    } catch {
      // Missing or unreadable — try the next candidate.
    }
  }
  return undefined;
}

/**
 * Build the set of absolute paths that {@link deleteWorkspaceFiles} must never
 * remove, even on explicit confirmation. This is the high-value-directory
 * blocklist required by RF-05 / Spec 01 §4.3:
 *  - the filesystem root and every depth-1 entry under it (e.g. `/etc`, `/usr`,
 *    `/var`, `/home`, `/boot`, `/lib`, ...) — computed live from the actual root
 *    so it is correct on any platform/mount, not a hardcoded POSIX list;
 *  - the user's home directory;
 *  - the app's own data directory and its ancestor chain up to home (e.g.
 *    `~/.local/share/vingsforge`, `~/.local/share`, `~/.local`), so a project
 *    repointed at the database dir can never wipe app state.
 * All entries are returned canonicalized (resolved) for exact comparison.
 */
async function protectedDeletePaths(path: string): Promise<Set<string>> {
  const blocked = new Set<string>();
  const { root } = parse(path);
  blocked.add(root);

  // Every immediate child of the root is a critical OS directory. Enumerate the
  // root and block each depth-1 entry; if the root cannot be read, fall back to
  // blocking just the root (already added above).
  try {
    for (const entry of await readdir(root)) {
      blocked.add(resolve(root, entry));
    }
  } catch {
    /* keep the root-only guard */
  }

  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home) {
    const resolvedHome = resolve(home);
    blocked.add(resolvedHome);

    // The app data dir and every ancestor down to (but not below) home.
    let dir = resolve(appDataDir());
    while (isInsideRoot(resolvedHome, dir) && dir !== resolvedHome) {
      blocked.add(dir);
      dir = dirname(dir);
    }
  }
  return blocked;
}

/**
 * Delete a local workspace folder and its contents (RF-05). This is the most
 * destructive operation in the product (Spec 01 §4.3), so it is hardened well
 * beyond a non-absolute check:
 *  - The caller MUST pass the project id and the path read *from the store at
 *    delete time* (not a raw, possibly-stale or attacker-supplied argument). The
 *    path is re-validated here; see {@link ProjectManager.remove}.
 *  - The final path component is `lstat`-ed and refused outright if it is a
 *    symlink, so a `workspace.path` pointing at a symlink-to-directory can never
 *    be force-removed (deleting the link would be harmless, but following it via
 *    `stat`+`rm` would not — we refuse rather than guess).
 *  - The path is canonicalized via `realpath` and the *resolved* target is
 *    checked against {@link protectedDeletePaths} (root, all depth-1 OS dirs,
 *    home, and the app data dir), defeating intermediate-symlink escapes.
 * The caller must already have obtained an explicit, separate user confirmation.
 */
export async function deleteWorkspaceFiles(rawPath: string): Promise<void> {
  if (!rawPath || !isAbsolute(rawPath)) {
    throw new WorkspaceError(rawPath, 'refusing to delete a non-absolute path');
  }
  const path = resolve(rawPath);

  let link;
  try {
    link = await lstat(path);
  } catch {
    // Nothing on disk: treat as already gone (idempotent).
    return;
  }
  // Refuse a symlinked final component: never follow it into an out-of-tree
  // (e.g. system) directory via stat()+rm().
  if (link.isSymbolicLink()) {
    throw new WorkspaceError(path, 'refusing to delete a symlinked path');
  }
  if (!link.isDirectory()) {
    throw new WorkspaceError(path, 'refusing to delete a non-directory path');
  }

  // Canonicalize and re-check: an intermediate symlink could still alias a
  // critical directory. Compare the resolved real path against the blocklist.
  const real = await realpath(path);
  const blocked = await protectedDeletePaths(real);
  if (blocked.has(real)) {
    throw new WorkspaceError(real, 'refusing to delete a protected directory');
  }
  // Guard the pre-canonicalized path too, in case realpath widened (it should
  // not, but the blocklist for `path` and `real` may differ on odd mounts).
  if (path !== real) {
    const blockedRaw = await protectedDeletePaths(path);
    if (blockedRaw.has(path)) {
      throw new WorkspaceError(path, 'refusing to delete a protected directory');
    }
  }

  await rm(real, { recursive: true, force: true });
}

/** Best-effort, dependency-free folder name derivation for a default project name. */
export function deriveProjectName(ref: WorkspaceRef): string {
  const base = ref.path.split(/[\\/]/).filter(Boolean).pop();
  return base && base.length ? base : 'Untitled project';
}
