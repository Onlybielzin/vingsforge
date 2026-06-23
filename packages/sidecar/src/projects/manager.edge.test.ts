/**
 * End-to-end edge/security coverage for the ProjectManager (Spec 01) that goes
 * through the full create/open/remove path, complementing the unit-level
 * confinement tests in workspace-fs.security.test.ts:
 *  - open() never leaks a symlinked AGENTS.md (indirect prompt injection);
 *  - remove(deleteFiles:true) is a no-op on disk for remote workspaces;
 *  - remote workspaces derive a default name from the path and skip disk I/O;
 *  - updateConfig can re-point a local workspace and re-validates the folder.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInMemoryDbStore, type DbStore } from '@vingsforge/persistence';
import { ProjectManager } from './manager.js';
import { WorkspaceError } from './workspace-fs.js';

let symlinksSupported = false;

describe('ProjectManager (edge / security)', () => {
  let db: DbStore;
  let mgr: ProjectManager;
  let tmp: string;

  beforeEach(async () => {
    db = createInMemoryDbStore();
    mgr = new ProjectManager(db);
    tmp = await mkdtemp(join(tmpdir(), 'vf-projects-edge-'));
    try {
      const t = join(tmp, '.probe');
      await writeFile(t, 'x');
      await symlink(t, join(tmp, '.probe-link'));
      symlinksSupported = true;
      await rm(join(tmp, '.probe-link'), { force: true });
      await rm(t, { force: true });
    } catch {
      symlinksSupported = false;
    }
  });

  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it('open() does not surface a symlinked AGENTS.md', async () => {
    if (!symlinksSupported) return;
    const secretDir = await mkdtemp(join(tmpdir(), 'vf-secret-'));
    const secret = join(secretDir, 'token');
    await writeFile(secret, 'SECRET');
    try {
      const ws = join(tmp, 'ws');
      await mkdir(ws);
      await symlink(secret, join(ws, 'AGENTS.md'));
      const project = await mgr.create({ workspace: { kind: 'local', path: ws } });
      const opened = await mgr.open(project.id);
      expect(opened.instructions).toBeUndefined();
    } finally {
      await rm(secretDir, { recursive: true, force: true });
    }
  });

  it('remove(deleteFiles:true) is a no-op on disk for a remote workspace', async () => {
    db.runtimes.upsert({
      id: 'vps-1',
      label: 'vps-1',
      ssh: { host: 'h', port: 22, user: 'root' },
      daemon: { installPath: '/opt/d' },
      apiKeyLocation: 'daemon',
    });
    const project = await mgr.create({
      workspace: { kind: 'remote', runtimeId: 'vps-1', path: '/srv/app' },
    });
    // Must resolve without attempting any local filesystem deletion.
    await expect(mgr.remove(project.id, { deleteFiles: true })).resolves.toBeUndefined();
    expect(await mgr.list()).toHaveLength(0);
  });

  it('derives the project name from a remote path segment', async () => {
    db.runtimes.upsert({
      id: 'vps-1',
      label: 'vps-1',
      ssh: { host: 'h', port: 22, user: 'root' },
      daemon: { installPath: '/opt/d' },
      apiKeyLocation: 'daemon',
    });
    const project = await mgr.create({
      workspace: { kind: 'remote', runtimeId: 'vps-1', path: '/srv/cool-service' },
    });
    expect(project.name).toBe('cool-service');
  });

  it('updateConfig re-points a local workspace and re-validates the folder', async () => {
    const project = await mgr.create({ workspace: { kind: 'local', path: tmp } });
    const next = join(tmp, 'moved');
    await mkdir(next);
    const updated = await mgr.updateConfig(project.id, {
      workspace: { kind: 'local', path: next },
    });
    expect(updated.workspace).toEqual({ kind: 'local', path: next });
    // Re-pointing to a non-existent folder is rejected (no createFolder here).
    await expect(
      mgr.updateConfig(project.id, { workspace: { kind: 'local', path: join(tmp, 'ghost') } }),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('rejects an over-long project name (>200 chars)', async () => {
    await expect(
      mgr.create({ name: 'x'.repeat(201), workspace: { kind: 'local', path: tmp } }),
    ).rejects.toBeTruthy();
  });

  it('trims a project name on create', async () => {
    const project = await mgr.create({
      name: '  Spaced  ',
      workspace: { kind: 'local', path: tmp },
    });
    expect(project.name).toBe('Spaced');
  });

  it('rejects unknown keys in create input (strict schema)', async () => {
    await expect(
      mgr.create({ workspace: { kind: 'local', path: tmp }, evil: true } as never),
    ).rejects.toBeTruthy();
  });
});
