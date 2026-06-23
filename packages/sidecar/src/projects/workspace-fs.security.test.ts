/**
 * Edge / security coverage for the workspace filesystem layer behind Projects
 * (Spec 01 §4/§7, §4.3). These exercise the path-confinement guarantees that the
 * higher-level ProjectManager relies on but does not itself test:
 *  - instruction-file detection refuses symlinks and is confined to the
 *    canonical workspace root (indirect prompt-injection / exfil defense);
 *  - the oversized-file read cap and truncation flag;
 *  - the (most destructive) delete refuses non-absolute paths, symlinks, and the
 *    protected high-value directories (root, depth-1 OS dirs, home, app data).
 *
 * Symlink-dependent cases are skipped automatically on platforms where the test
 * runner cannot create symlinks (e.g. unprivileged Windows).
 */
import { lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appDataDir } from '@vingsforge/persistence';
import {
  MAX_INSTRUCTION_FILE_BYTES,
  WorkspaceError,
  deleteWorkspaceFiles,
  deriveProjectName,
  detectInstructionFile,
  ensureLocalWorkspace,
  isLocalWorkspace,
} from './workspace-fs.js';

/** Probe whether this environment can create symlinks; skip those cases if not. */
let symlinksSupported = false;

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vf-wsfs-'));
  try {
    const target = join(tmp, '.probe-target');
    await writeFile(target, 'x');
    await symlink(target, join(tmp, '.probe-link'));
    symlinksSupported = true;
    await rm(join(tmp, '.probe-link'), { force: true });
    await rm(target, { force: true });
  } catch {
    symlinksSupported = false;
  }
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe('ensureLocalWorkspace', () => {
  it('rejects a relative path', async () => {
    await expect(ensureLocalWorkspace('relative/dir')).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('rejects a path that exists but is a file', async () => {
    const file = join(tmp, 'a-file');
    await writeFile(file, 'hi');
    await expect(ensureLocalWorkspace(file)).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('rejects a missing folder unless create is set, then creates parents', async () => {
    const nested = join(tmp, 'x', 'y', 'z');
    await expect(ensureLocalWorkspace(nested)).rejects.toBeInstanceOf(WorkspaceError);
    const out = await ensureLocalWorkspace(nested, { create: true });
    expect(out).toBe(nested);
    expect((await stat(nested)).isDirectory()).toBe(true);
  });
});

describe('detectInstructionFile', () => {
  it('returns undefined for a remote workspace (never touches disk)', async () => {
    const got = await detectInstructionFile({
      kind: 'remote',
      runtimeId: 'vps-1',
      path: '/srv/app',
    });
    expect(got).toBeUndefined();
  });

  it('returns undefined when the root does not exist', async () => {
    const got = await detectInstructionFile({ kind: 'local', path: join(tmp, 'ghost') });
    expect(got).toBeUndefined();
  });

  it('returns undefined when no instruction file is present', async () => {
    expect(await detectInstructionFile({ kind: 'local', path: tmp })).toBeUndefined();
  });

  it('prefers AGENTS.md over FORGE.md (precedence order)', async () => {
    await writeFile(join(tmp, 'AGENTS.md'), 'agents');
    await writeFile(join(tmp, 'FORGE.md'), 'forge');
    const got = await detectInstructionFile({ kind: 'local', path: tmp });
    expect(got?.name).toBe('AGENTS.md');
    expect(got?.content).toBe('agents');
    expect(got?.truncated).toBe(false);
  });

  it('falls back to FORGE.md when AGENTS.md is absent', async () => {
    await writeFile(join(tmp, 'FORGE.md'), 'forge rules');
    const got = await detectInstructionFile({ kind: 'local', path: tmp });
    expect(got?.name).toBe('FORGE.md');
    expect(got?.content).toBe('forge rules');
  });

  it('caps an oversized file at MAX_INSTRUCTION_FILE_BYTES and flags truncated', async () => {
    const big = 'A'.repeat(MAX_INSTRUCTION_FILE_BYTES + 1024);
    await writeFile(join(tmp, 'AGENTS.md'), big);
    const got = await detectInstructionFile({ kind: 'local', path: tmp });
    expect(got?.name).toBe('AGENTS.md');
    expect(got?.truncated).toBe(true);
    expect(Buffer.byteLength(got!.content, 'utf8')).toBe(MAX_INSTRUCTION_FILE_BYTES);
  });

  it('does not flag truncated for a file exactly at the cap', async () => {
    const exact = 'B'.repeat(MAX_INSTRUCTION_FILE_BYTES);
    await writeFile(join(tmp, 'AGENTS.md'), exact);
    const got = await detectInstructionFile({ kind: 'local', path: tmp });
    expect(got?.truncated).toBe(false);
    expect(Buffer.byteLength(got!.content, 'utf8')).toBe(MAX_INSTRUCTION_FILE_BYTES);
  });

  it('refuses a symlinked AGENTS.md pointing outside the root (exfil defense)', async () => {
    if (!symlinksSupported) return;
    // A secret outside the workspace that a planted symlink would try to read.
    const secretDir = await mkdtemp(join(tmpdir(), 'vf-secret-'));
    const secret = join(secretDir, 'id_rsa');
    await writeFile(secret, 'PRIVATE KEY MATERIAL');
    try {
      await symlink(secret, join(tmp, 'AGENTS.md'));
      // Sanity: the symlink really is one.
      expect((await lstat(join(tmp, 'AGENTS.md'))).isSymbolicLink()).toBe(true);
      const got = await detectInstructionFile({ kind: 'local', path: tmp });
      // The symlinked AGENTS.md is skipped entirely; no secret leaks.
      expect(got).toBeUndefined();
    } finally {
      await rm(secretDir, { recursive: true, force: true });
    }
  });

  it('skips a symlinked AGENTS.md but still finds a real FORGE.md', async () => {
    if (!symlinksSupported) return;
    const secretDir = await mkdtemp(join(tmpdir(), 'vf-secret-'));
    const secret = join(secretDir, 'secret.txt');
    await writeFile(secret, 'nope');
    try {
      await symlink(secret, join(tmp, 'AGENTS.md'));
      await writeFile(join(tmp, 'FORGE.md'), 'real forge');
      const got = await detectInstructionFile({ kind: 'local', path: tmp });
      expect(got?.name).toBe('FORGE.md');
      expect(got?.content).toBe('real forge');
    } finally {
      await rm(secretDir, { recursive: true, force: true });
    }
  });

  it('detects a real file through a symlinked workspace root (root canonicalized)', async () => {
    if (!symlinksSupported) return;
    const realRoot = join(tmp, 'real-root');
    await mkdir(realRoot);
    await writeFile(join(realRoot, 'AGENTS.md'), 'via link');
    const linkRoot = join(tmp, 'link-root');
    await symlink(realRoot, linkRoot);
    const got = await detectInstructionFile({ kind: 'local', path: linkRoot });
    expect(got?.name).toBe('AGENTS.md');
    expect(got?.content).toBe('via link');
    // The reported path is canonicalized to the real target, inside the real root.
    expect(got?.path.startsWith(realRoot)).toBe(true);
  });

  it('ignores a directory named AGENTS.md', async () => {
    await mkdir(join(tmp, 'AGENTS.md'));
    expect(await detectInstructionFile({ kind: 'local', path: tmp })).toBeUndefined();
  });
});

describe('deleteWorkspaceFiles', () => {
  it('refuses an empty or non-absolute path', async () => {
    await expect(deleteWorkspaceFiles('')).rejects.toBeInstanceOf(WorkspaceError);
    await expect(deleteWorkspaceFiles('relative/dir')).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('is idempotent when the path is already gone', async () => {
    await expect(deleteWorkspaceFiles(join(tmp, 'never-existed'))).resolves.toBeUndefined();
  });

  it('refuses to delete a file (non-directory) path', async () => {
    const file = join(tmp, 'plain.txt');
    await writeFile(file, 'x');
    await expect(deleteWorkspaceFiles(file)).rejects.toBeInstanceOf(WorkspaceError);
    // The file is left intact.
    expect((await stat(file)).isFile()).toBe(true);
  });

  it('deletes a real nested workspace directory recursively', async () => {
    const ws = join(tmp, 'ws');
    await mkdir(join(ws, 'sub'), { recursive: true });
    await writeFile(join(ws, 'sub', 'f.txt'), 'data');
    await deleteWorkspaceFiles(ws);
    await expect(stat(ws)).rejects.toBeTruthy();
  });

  it('refuses to delete a symlinked path and never follows it', async () => {
    if (!symlinksSupported) return;
    const realDir = join(tmp, 'real');
    await mkdir(realDir);
    await writeFile(join(realDir, 'keep.txt'), 'keep me');
    const link = join(tmp, 'link');
    await symlink(realDir, link);
    await expect(deleteWorkspaceFiles(link)).rejects.toBeInstanceOf(WorkspaceError);
    // The link target and its contents are untouched.
    expect((await stat(join(realDir, 'keep.txt'))).isFile()).toBe(true);
  });

  it('refuses the filesystem root', async () => {
    const { root } = parse(tmp);
    await expect(deleteWorkspaceFiles(root)).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('refuses a depth-1 OS directory under the root', async () => {
    const { root } = parse(tmp);
    // Pick an existing immediate child of the root (e.g. /home, /usr...).
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(root);
    expect(entries.length).toBeGreaterThan(0);
    const osDir = join(root, entries[0]!);
    await expect(deleteWorkspaceFiles(osDir)).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('refuses the home directory', async () => {
    await expect(deleteWorkspaceFiles(homedir())).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('refuses the app data directory (protected even when present on disk)', async () => {
    const appDir = appDataDir();
    // Only meaningful when the app data dir is under home (default XDG layout).
    if (!appDir.startsWith(homedir())) return;
    // The protected-path guard only fires once the target exists as a directory
    // (a missing path is treated as already-gone / idempotent). Materialize the
    // app data dir if absent so we genuinely exercise the blocklist, and remove
    // only what this test created afterwards.
    let created = false;
    try {
      await stat(appDir);
    } catch {
      await mkdir(appDir, { recursive: true });
      created = true;
    }
    try {
      await expect(deleteWorkspaceFiles(appDir)).rejects.toBeInstanceOf(WorkspaceError);
      // The directory must still be there — the delete was refused, not performed.
      expect((await stat(appDir)).isDirectory()).toBe(true);
    } finally {
      if (created) await rm(appDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});

describe('helpers', () => {
  it('isLocalWorkspace narrows on kind', () => {
    expect(isLocalWorkspace({ kind: 'local', path: '/x' })).toBe(true);
    expect(isLocalWorkspace({ kind: 'remote', runtimeId: 'r', path: '/x' })).toBe(false);
  });

  it('deriveProjectName uses the last path segment', () => {
    expect(deriveProjectName({ kind: 'local', path: '/a/b/my-app' })).toBe('my-app');
    expect(deriveProjectName({ kind: 'local', path: '/a/b/c/' })).toBe('c');
  });

  it('deriveProjectName falls back for an empty/root path', () => {
    expect(deriveProjectName({ kind: 'local', path: '/' })).toBe('Untitled project');
    expect(deriveProjectName({ kind: 'local', path: '' })).toBe('Untitled project');
  });
});
