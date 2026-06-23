/**
 * Contract tests run against both DbStore implementations (in-memory + SQLite :memory:),
 * plus block serialization fidelity, cascade deletes, migrations and export.
 */
import { describe, expect, it } from 'vitest';
import type { Block, GlobalSettings } from '@vingsforge/shared';
import type { DbStore } from './store.js';
import { InMemoryDbStore } from './memory-store.js';
import { SqliteDbStore } from './sqlite-store.js';
import { CURRENT_SCHEMA_VERSION } from './migrations.js';
import { exportChatJson, exportChatMarkdown } from './export.js';
import { buildReplayMessages } from './replay.js';
import { defaultDbPath } from './paths.js';

const sampleBlocks: Block[] = [
  { kind: 'thinking', text: 'let me think', signature: 'sig-123' },
  { kind: 'text', text: 'Hello!' },
  { kind: 'tool_use', callId: 'c1', tool: 'bash', input: { cmd: 'ls' } },
  { kind: 'tool_result', callId: 'c1', output: { stdout: 'a\nb' }, isError: false },
];

const backends: Array<[string, () => DbStore]> = [
  ['InMemoryDbStore', () => new InMemoryDbStore()],
  ['SqliteDbStore(:memory:)', () => new SqliteDbStore({ path: ':memory:' })],
];

describe.each(backends)('DbStore contract — %s', (_name, make) => {
  it('reports the current schema version', () => {
    const store = make();
    expect(store.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    store.close();
  });

  it('creates and reads projects', () => {
    const store = make();
    const project = store.projects.create({
      name: 'Demo',
      workspace: { kind: 'local', path: '/home/u/demo' },
      permissionPolicy: { defaults: { bash: 'ask' } },
    });
    expect(project.runtimeId).toBe('local');
    const fetched = store.projects.get(project.id);
    expect(fetched?.workspace).toEqual({ kind: 'local', path: '/home/u/demo' });
    expect(fetched?.permissionPolicy).toEqual({ defaults: { bash: 'ask' } });
    expect(store.projects.list()).toHaveLength(1);
    store.close();
  });

  it('serializes all block kinds faithfully (incl. thinking signature)', () => {
    const store = make();
    const project = store.projects.create({
      name: 'P',
      workspace: { kind: 'local', path: '/w' },
    });
    const chat = store.chats.create({ projectId: project.id });
    store.messages.append({
      chatId: chat.id,
      role: 'assistant',
      blocks: sampleBlocks,
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    const [msg] = store.messages.list(chat.id);
    expect(msg?.blocks).toEqual(sampleBlocks);
    expect(msg?.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    store.close();
  });

  it('orders messages by seq, even with identical timestamps', () => {
    const store = make();
    const project = store.projects.create({
      name: 'P',
      workspace: { kind: 'local', path: '/w' },
    });
    const chat = store.chats.create({ projectId: project.id });
    for (let i = 0; i < 5; i++) {
      store.messages.append({
        chatId: chat.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        blocks: [{ kind: 'text', text: `m${i}` }],
      });
    }
    const texts = store.messages
      .list(chat.id)
      .map((m) => (m.blocks[0] as { text: string }).text);
    expect(texts).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    store.close();
  });

  it('records the producing model on append and reads it back', () => {
    const store = make();
    const project = store.projects.create({
      name: 'P',
      workspace: { kind: 'local', path: '/w' },
    });
    const chat = store.chats.create({ projectId: project.id });
    store.messages.append({
      chatId: chat.id,
      role: 'assistant',
      blocks: sampleBlocks,
      model: 'claude-opus-4-8',
    });
    expect(store.messages.list(chat.id)[0]?.model).toBe('claude-opus-4-8');
    store.close();
  });

  it('rejects persisting a thinking block without a signature (Spec 08 §4)', () => {
    const store = make();
    const project = store.projects.create({
      name: 'P',
      workspace: { kind: 'local', path: '/w' },
    });
    const chat = store.chats.create({ projectId: project.id });
    expect(() =>
      store.messages.append({
        chatId: chat.id,
        role: 'assistant',
        blocks: [{ kind: 'thinking', text: 'no sig' }],
        model: 'claude-opus-4-8',
      }),
    ).toThrow(/signature/i);
    store.close();
  });

  it('replay keeps thinking on the same model and drops it on a model switch', () => {
    const store = make();
    const project = store.projects.create({
      name: 'P',
      workspace: { kind: 'local', path: '/w' },
    });
    const chat = store.chats.create({ projectId: project.id });
    store.messages.append({
      chatId: chat.id,
      role: 'assistant',
      blocks: sampleBlocks,
      model: 'claude-opus-4-8',
    });

    const same = buildReplayMessages(store, chat.id, 'claude-opus-4-8');
    expect(same[0]?.blocks).toEqual(sampleBlocks);

    const switched = buildReplayMessages(store, chat.id, 'claude-sonnet-4-5');
    expect(switched[0]?.blocks.some((b) => b.kind === 'thinking')).toBe(false);
    // Non-thinking blocks survive the switch.
    expect(switched[0]?.blocks.map((b) => b.kind)).toEqual([
      'text',
      'tool_use',
      'tool_result',
    ]);
    store.close();
  });

  it('replay drops thinking when the producing model is unknown', () => {
    const store = make();
    const project = store.projects.create({
      name: 'P',
      workspace: { kind: 'local', path: '/w' },
    });
    const chat = store.chats.create({ projectId: project.id });
    // No model recorded (legacy row simulation).
    store.messages.append({
      chatId: chat.id,
      role: 'assistant',
      blocks: sampleBlocks,
    });
    const replay = buildReplayMessages(store, chat.id, 'claude-opus-4-8');
    expect(replay[0]?.blocks.some((b) => b.kind === 'thinking')).toBe(false);
    store.close();
  });

  it('cascades chat/message deletion when a project is removed', () => {
    const store = make();
    const project = store.projects.create({
      name: 'P',
      workspace: { kind: 'local', path: '/w' },
    });
    const chat = store.chats.create({ projectId: project.id });
    store.messages.append({
      chatId: chat.id,
      role: 'user',
      blocks: [{ kind: 'text', text: 'hi' }],
    });
    store.projects.remove(project.id);
    expect(store.projects.get(project.id)).toBeUndefined();
    expect(store.chats.get(chat.id)).toBeUndefined();
    expect(store.messages.list(chat.id)).toHaveLength(0);
    store.close();
  });

  it('lists chats with last-message preview and hides archived by default', () => {
    const store = make();
    const project = store.projects.create({
      name: 'P',
      workspace: { kind: 'local', path: '/w' },
    });
    const a = store.chats.create({ projectId: project.id, title: 'A' });
    const b = store.chats.create({ projectId: project.id, title: 'B' });
    store.messages.append({
      chatId: a.id,
      role: 'assistant',
      blocks: [{ kind: 'text', text: 'preview text' }],
    });
    store.chats.update(b.id, { archived: true });

    const visible = store.chats.listByProject(project.id);
    expect(visible.map((c) => c.id)).toEqual([a.id]);
    expect(visible[0]?.lastMessagePreview).toBe('preview text');
    expect(store.chats.listByProject(project.id, { includeArchived: true })).toHaveLength(2);
    store.close();
  });

  it('upserts runtimes and stores ssh/daemon as JSON', () => {
    const store = make();
    const rec = {
      id: 'rt1',
      label: 'VPS',
      ssh: { host: 'h', port: 22, user: 'root', keyPath: '/k' },
      daemon: { installPath: '/opt/d', version: '1.0.0' },
      apiKeyLocation: 'daemon' as const,
    };
    store.runtimes.upsert(rec);
    expect(store.runtimes.get('rt1')).toEqual(rec);
    store.runtimes.upsert({ ...rec, label: 'VPS-2' });
    expect(store.runtimes.get('rt1')?.label).toBe('VPS-2');
    expect(store.runtimes.list()).toHaveLength(1);
    store.close();
  });

  it('stores typed global settings as JSON', () => {
    const store = make();
    const settings: GlobalSettings = {
      authMode: 'plan',
      apiKeyPresent: false,
      defaultModel: 'claude-opus-4-8',
      defaultEffort: 'high',
      showThinking: true,
      permissionDefaults: { bash: 'ask' },
      theme: 'dark',
      showCost: true,
    };
    store.settings.setGlobal(settings);
    expect(store.settings.getGlobal()).toEqual(settings);
    store.close();
  });

  it('exports chat to JSON and Markdown without throwing', () => {
    const store = make();
    const project = store.projects.create({
      name: 'P',
      workspace: { kind: 'local', path: '/w' },
    });
    const chat = store.chats.create({ projectId: project.id, title: 'Export me' });
    store.messages.append({ chatId: chat.id, role: 'assistant', blocks: sampleBlocks });
    const json = exportChatJson(store, chat.id);
    expect(json.version).toBe(1);
    expect(json.messages[0]?.blocks).toEqual(sampleBlocks);
    const md = exportChatMarkdown(store, chat.id);
    expect(md).toContain('# Export me');
    expect(md).toContain('Hello!');
    store.close();
  });
});

describe('SqliteDbStore persistence', () => {
  it('reopens a file and reconstructs state', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'vf-persist-'));
    const path = join(dir, 'db.sqlite');
    try {
      const s1 = new SqliteDbStore({ path });
      const project = s1.projects.create({
        name: 'Persisted',
        workspace: { kind: 'local', path: '/w' },
      });
      const chat = s1.chats.create({ projectId: project.id });
      s1.messages.append({ chatId: chat.id, role: 'assistant', blocks: sampleBlocks });
      s1.close();

      const s2 = new SqliteDbStore({ path });
      expect(s2.projects.list().map((p) => p.name)).toEqual(['Persisted']);
      expect(s2.messages.list(chat.id)[0]?.blocks).toEqual(sampleBlocks);
      expect(s2.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
      s2.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('paths', () => {
  it('honours XDG_DATA_HOME', () => {
    expect(defaultDbPath({ XDG_DATA_HOME: '/custom/xdg' })).toBe(
      '/custom/xdg/vingsforge/vingsforge.db',
    );
  });
});
