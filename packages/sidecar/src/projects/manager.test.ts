import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInMemoryDbStore, type DbStore } from '@vingsforge/persistence';
import { ProjectManager, ProjectNotFoundError, RuntimeNotFoundError } from './manager.js';
import { WorkspaceError } from './workspace-fs.js';

describe('ProjectManager', () => {
  let db: DbStore;
  let mgr: ProjectManager;
  let tmp: string;

  beforeEach(async () => {
    db = createInMemoryDbStore();
    mgr = new ProjectManager(db);
    tmp = await mkdtemp(join(tmpdir(), 'vf-projects-'));
  });

  afterEach(async () => {
    db.close();
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  it('creates a local project from an existing folder, defaulting the name to the folder', async () => {
    const ws = join(tmp, 'my-app');
    await mkdir(ws);
    const project = await mgr.create({ workspace: { kind: 'local', path: ws } });
    expect(project.name).toBe('my-app');
    expect(project.runtimeId).toBe('local');
    expect(project.workspace).toEqual({ kind: 'local', path: ws });
    expect(await mgr.list()).toHaveLength(1);
  });

  it('creates the folder when createFolder is set', async () => {
    const ws = join(tmp, 'fresh');
    await mgr.create({ workspace: { kind: 'local', path: ws }, createFolder: true });
    expect((await stat(ws)).isDirectory()).toBe(true);
  });

  it('rejects a missing folder without createFolder', async () => {
    await expect(
      mgr.create({ workspace: { kind: 'local', path: join(tmp, 'nope') } }),
    ).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('detects AGENTS.md on open and stamps lastOpenedAt', async () => {
    await writeFile(join(tmp, 'AGENTS.md'), '# rules');
    const project = await mgr.create({ workspace: { kind: 'local', path: tmp } });
    const opened = await mgr.open(project.id);
    expect(opened.instructions?.name).toBe('AGENTS.md');
    expect(opened.instructions?.content).toContain('# rules');
    expect(opened.project.lastOpenedAt).toBeTruthy();
    expect(opened.chats).toEqual([]);
  });

  it('renames the label only', async () => {
    const project = await mgr.create({ workspace: { kind: 'local', path: tmp } });
    await mgr.rename(project.id, 'Renamed');
    expect((await mgr.list())[0]!.name).toBe('Renamed');
  });

  it('rejects an empty rename', async () => {
    const project = await mgr.create({ workspace: { kind: 'local', path: tmp } });
    await expect(mgr.rename(project.id, '   ')).rejects.toBeTruthy();
  });

  it('updateConfig applies whitelisted fields and rejects unknown keys', async () => {
    const project = await mgr.create({ workspace: { kind: 'local', path: tmp } });
    const updated = await mgr.updateConfig(project.id, {
      defaultModel: 'claude-opus-4-8',
      systemPromptExtra: 'be terse',
    });
    expect(updated.defaultModel).toBe('claude-opus-4-8');
    expect(updated.systemPromptExtra).toBe('be terse');
    await expect(
      mgr.updateConfig(project.id, { bogus: 1 } as never),
    ).rejects.toBeTruthy();
  });

  it('remove keeps files by default', async () => {
    const project = await mgr.create({ workspace: { kind: 'local', path: tmp } });
    await mgr.remove(project.id, { deleteFiles: false });
    expect(await mgr.list()).toHaveLength(0);
    expect((await stat(tmp)).isDirectory()).toBe(true);
  });

  it('remove deletes files only when explicitly requested', async () => {
    const ws = join(tmp, 'to-delete');
    await mkdir(ws);
    await writeFile(join(ws, 'f.txt'), 'x');
    const project = await mgr.create({ workspace: { kind: 'local', path: ws } });
    await mgr.remove(project.id, { deleteFiles: true });
    await expect(stat(ws)).rejects.toBeTruthy();
  });

  it('throws ProjectNotFoundError for unknown ids', async () => {
    await expect(mgr.open('missing')).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(mgr.rename('missing', 'x')).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(
      mgr.remove('missing', { deleteFiles: false }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('records a remote workspace without touching disk', async () => {
    seedRuntime(db, 'vps-1');
    const project = await mgr.create({
      workspace: { kind: 'remote', runtimeId: 'vps-1', path: '/srv/app' },
    });
    expect(project.workspace).toEqual({ kind: 'remote', runtimeId: 'vps-1', path: '/srv/app' });
    expect(project.runtimeId).toBe('vps-1');
    // open() must not throw on a remote workspace; no instructions detected.
    const opened = await mgr.open(project.id);
    expect(opened.instructions).toBeUndefined();
  });

  it('rejects a remote workspace whose runtime does not exist', async () => {
    await expect(
      mgr.create({ workspace: { kind: 'remote', runtimeId: 'ghost', path: '/srv/app' } }),
    ).rejects.toBeInstanceOf(RuntimeNotFoundError);
  });

  it('rejects a relative or traversing remote path', async () => {
    seedRuntime(db, 'vps-1');
    await expect(
      mgr.create({ workspace: { kind: 'remote', runtimeId: 'vps-1', path: 'srv/app' } }),
    ).rejects.toBeTruthy();
    await expect(
      mgr.create({ workspace: { kind: 'remote', runtimeId: 'vps-1', path: '/srv/../etc' } }),
    ).rejects.toBeTruthy();
  });

  it('updateConfig rejects repointing to an unknown runtime', async () => {
    const project = await mgr.create({ workspace: { kind: 'local', path: tmp } });
    await expect(
      mgr.updateConfig(project.id, { runtimeId: 'ghost' }),
    ).rejects.toBeInstanceOf(RuntimeNotFoundError);
  });
});

function seedRuntime(db: DbStore, id: string): void {
  db.runtimes.upsert({
    id,
    label: id,
    ssh: { host: 'h', port: 22, user: 'root' },
    daemon: { installPath: '/opt/d' },
    apiKeyLocation: 'daemon',
  });
}
