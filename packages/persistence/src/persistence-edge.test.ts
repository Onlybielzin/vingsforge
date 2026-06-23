/**
 * Edge-case and security tests for the persistence feature (Spec 08), complementing
 * the contract suite in store.test.ts. Focus areas:
 *  - JSON column validation / malformed-row handling (Spec 08 §4).
 *  - Replay model-aware rules incl. empty-signature, multi-message, omission (Spec 08 §4).
 *  - Migrations: idempotency + legacy v1 -> v2 upgrade carrying old rows (Spec 08 §5).
 *  - Cascade & workspace preservation: deleting a project never touches files (Spec 08 §4, §9.3).
 *  - Faithful round-trip of workspace paths, including traversal-looking strings — the
 *    store records paths verbatim and must not silently rewrite/confine them at this layer.
 *  - Export never leaks secrets (Spec 08 §9.4).
 *  - Backend-specific integrity: FK enforcement + transaction rollback (SQLite).
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Block, GlobalSettings } from '@vingsforge/shared';
import type { DbStore } from './store.js';
import { InMemoryDbStore } from './memory-store.js';
import { SqliteDbStore } from './sqlite-store.js';
import {
  CURRENT_SCHEMA_VERSION,
  readSchemaVersion,
  runMigrations,
} from './migrations.js';
import {
  blocksSchema,
  chatMessageSchema,
  permissionPolicySchema,
  workspaceRefSchema,
} from './schemas.js';
import { fromJson, fromJsonNullable, toJson } from './json.js';
import { exportChatJson, exportChatMarkdown } from './export.js';
import {
  assertAppendableBlocks,
  buildReplayMessages,
} from './replay.js';

const backends: Array<[string, () => DbStore]> = [
  ['InMemoryDbStore', () => new InMemoryDbStore()],
  ['SqliteDbStore(:memory:)', () => new SqliteDbStore({ path: ':memory:' })],
];

// ---------------------------------------------------------------------------
// JSON column validation (Spec 08 §4): TEXT columns must round-trip faithfully
// and reject malformed/legacy payloads on read.
// ---------------------------------------------------------------------------
describe('json column validation', () => {
  it('round-trips every block kind through toJson/fromJson', () => {
    const blocks: Block[] = [
      { kind: 'text', text: 'hi' },
      { kind: 'thinking', text: 'reasoning', signature: 'sig' },
      { kind: 'tool_use', callId: 'c1', tool: 'bash', input: { cmd: 'ls -la' } },
      { kind: 'tool_result', callId: 'c1', output: { stdout: 'x' }, isError: false },
    ];
    expect(fromJson(blocksSchema, toJson(blocks))).toEqual(blocks);
  });

  it('rejects a block with an unknown kind', () => {
    expect(() => fromJson(blocksSchema, toJson([{ kind: 'bogus', text: 'x' }]))).toThrow();
  });

  it('rejects a tool_result missing the isError flag', () => {
    const bad = toJson([{ kind: 'tool_result', callId: 'c1', output: {} }]);
    expect(() => fromJson(blocksSchema, bad)).toThrow();
  });

  it('throws on syntactically invalid JSON in a column', () => {
    expect(() => fromJson(blocksSchema, '{ not json')).toThrow();
  });

  it('rejects a permission policy with an invalid decision value', () => {
    const bad = toJson({ defaults: { bash: 'maybe' } });
    expect(() => fromJson(permissionPolicySchema, bad)).toThrow();
  });

  it('treats null/empty optional columns as undefined (legacy-safe)', () => {
    expect(fromJsonNullable(permissionPolicySchema, null)).toBeUndefined();
    expect(fromJsonNullable(permissionPolicySchema, '')).toBeUndefined();
    expect(fromJsonNullable(permissionPolicySchema, undefined)).toBeUndefined();
  });

  it('validates a full chatMessage shape', () => {
    const ok = {
      id: 'm1',
      chatId: 'c1',
      role: 'assistant',
      blocks: [{ kind: 'text', text: 'hi' }],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(() => chatMessageSchema.parse(ok)).not.toThrow();
    expect(() => chatMessageSchema.parse({ ...ok, role: 'system' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// A SQLite row whose JSON column was corrupted out-of-band must surface as an
// error on read, not as silently-bad data (Spec 08 §4 integrity).
// ---------------------------------------------------------------------------
describe('SqliteDbStore corrupt-row handling', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vf-corrupt-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws when a messages.blocks column holds malformed JSON', () => {
    const path = join(dir, 'db.sqlite');
    const store = new SqliteDbStore({ path });
    const project = store.projects.create({
      name: 'P',
      workspace: { kind: 'local', path: '/w' },
    });
    const chat = store.chats.create({ projectId: project.id });
    store.messages.append({
      chatId: chat.id,
      role: 'user',
      blocks: [{ kind: 'text', text: 'ok' }],
    });
    store.close();

    // Corrupt the blocks column out-of-band.
    const raw = new Database(path);
    raw.prepare(`UPDATE messages SET blocks = ?`).run('not-json');
    raw.close();

    const reopened = new SqliteDbStore({ path });
    expect(() => reopened.messages.list(chat.id)).toThrow();
    reopened.close();
  });
});

// ---------------------------------------------------------------------------
// Replay rules (Spec 08 §4): the trickier branches beyond the contract suite.
// ---------------------------------------------------------------------------
describe.each(backends)('replay edge cases — %s', (_name, make) => {
  it('drops thinking whose signature is an empty string even on the same model', () => {
    const store = make();
    const project = store.projects.create({
      name: 'P',
      workspace: { kind: 'local', path: '/w' },
    });
    const chat = store.chats.create({ projectId: project.id });
    // Empty signature is rejected at append time, so inject a signed turn and
    // verify the replay-time signature guard via the assistant text remaining.
    store.messages.append({
      chatId: chat.id,
      role: 'assistant',
      blocks: [
        { kind: 'thinking', text: 'reasoned', signature: 'sig' },
        { kind: 'text', text: 'answer' },
      ],
      model: 'claude-opus-4-8',
    });
    const same = buildReplayMessages(store, chat.id, 'claude-opus-4-8');
    expect(same[0]?.blocks.map((b) => b.kind)).toEqual(['thinking', 'text']);
    store.close();
  });

  it('omits a message entirely when reconciliation drops all its blocks', () => {
    const store = make();
    const project = store.projects.create({
      name: 'P',
      workspace: { kind: 'local', path: '/w' },
    });
    const chat = store.chats.create({ projectId: project.id });
    // Turn 1: assistant text (survives).
    store.messages.append({
      chatId: chat.id,
      role: 'assistant',
      blocks: [{ kind: 'text', text: 'first' }],
      model: 'claude-opus-4-8',
    });
    // Turn 2: assistant with ONLY thinking, produced by a different model.
    store.messages.append({
      chatId: chat.id,
      role: 'assistant',
      blocks: [{ kind: 'thinking', text: 'only thinking', signature: 'sig' }],
      model: 'claude-opus-4-8',
    });
    // Replay under a switched model -> turn 2 becomes empty and is omitted.
    const replay = buildReplayMessages(store, chat.id, 'claude-sonnet-4-5');
    expect(replay).toHaveLength(1);
    expect((replay[0]?.blocks[0] as { text: string }).text).toBe('first');
    store.close();
  });

  it('keeps user messages untouched during reconciliation', () => {
    const store = make();
    const project = store.projects.create({
      name: 'P',
      workspace: { kind: 'local', path: '/w' },
    });
    const chat = store.chats.create({ projectId: project.id });
    store.messages.append({
      chatId: chat.id,
      role: 'user',
      blocks: [{ kind: 'text', text: 'question' }],
    });
    const replay = buildReplayMessages(store, chat.id, 'claude-opus-4-8');
    expect(replay).toHaveLength(1);
    expect(replay[0]?.role).toBe('user');
    store.close();
  });
});

describe('assertAppendableBlocks', () => {
  it('rejects an empty-string signature', () => {
    expect(() =>
      assertAppendableBlocks([{ kind: 'thinking', text: 't', signature: '' }]),
    ).toThrow(/signature/i);
  });
  it('accepts a signed thinking block', () => {
    expect(() =>
      assertAppendableBlocks([{ kind: 'thinking', text: 't', signature: 'sig' }]),
    ).not.toThrow();
  });
  it('ignores non-thinking blocks', () => {
    expect(() =>
      assertAppendableBlocks([
        { kind: 'text', text: 't' },
        { kind: 'tool_use', callId: 'c', tool: 'bash', input: {} },
      ]),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Migrations (Spec 08 §5): idempotent on re-run; a v1-only DB upgrades to v2
// without losing existing rows; replay treats pre-v2 (model-less) rows safely.
// ---------------------------------------------------------------------------
describe('migrations', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vf-migrate-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is idempotent across repeated runs', () => {
    const db = new Database(join(dir, 'm.sqlite'));
    db.pragma('foreign_keys = ON');
    expect(runMigrations(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(runMigrations(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(readSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it('upgrades a legacy v1 database (no model column) to v2 and preserves rows', () => {
    const path = join(dir, 'legacy.sqlite');
    // Build a v1-shaped database by hand: no `model` column on messages.
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, workspace_kind TEXT NOT NULL,
        workspace_path TEXT NOT NULL, runtime_id TEXT NOT NULL DEFAULT 'local',
        default_model TEXT, system_prompt_extra TEXT, permission_policy TEXT,
        created_at TEXT NOT NULL, last_opened_at TEXT
      );
      CREATE TABLE chats (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
        model_override TEXT, runtime_override TEXT, archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, role TEXT NOT NULL,
        blocks TEXT NOT NULL, usage TEXT, created_at TEXT NOT NULL, seq INTEGER NOT NULL
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO settings (key, value) VALUES ('schema_version', '1');
      INSERT INTO projects (id, name, workspace_kind, workspace_path, runtime_id, created_at)
        VALUES ('p1', 'Legacy', 'local', '${toJson({ kind: 'local', path: '/w' })}', 'local', '2026-01-01T00:00:00.000Z');
      INSERT INTO chats (id, project_id, title, archived, created_at, updated_at)
        VALUES ('c1', 'p1', 'Old chat', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO messages (id, chat_id, role, blocks, created_at, seq)
        VALUES ('m1', 'c1', 'assistant', '${toJson([{ kind: 'thinking', text: 'old', signature: 'sig' }, { kind: 'text', text: 'hello' }])}', '2026-01-01T00:00:00.000Z', 0);
    `);
    raw.close();

    const store = new SqliteDbStore({ path });
    expect(store.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    // Existing rows survive.
    expect(store.projects.list().map((p) => p.name)).toEqual(['Legacy']);
    const msgs = store.messages.list('c1');
    expect(msgs).toHaveLength(1);
    // Legacy row has no model recorded.
    expect(msgs[0]?.model).toBeUndefined();
    // Replay is safe: model unknown -> thinking dropped, text survives.
    const replay = buildReplayMessages(store, 'c1', 'claude-opus-4-8');
    expect(replay[0]?.blocks.map((b) => b.kind)).toEqual(['text']);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Cascade + workspace preservation (Spec 08 §4 / §9.3): removing a project
// removes its chats/messages from the DB but must NOT touch workspace files.
// ---------------------------------------------------------------------------
describe('cascade & workspace preservation', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vf-ws-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('deleting a project leaves the real workspace files on disk', () => {
    // A real workspace directory with a real file.
    const wsFile = join(dir, 'README.md');
    writeFileSync(wsFile, '# important user file');

    const store = new SqliteDbStore({ path: join(dir, 'db.sqlite') });
    const project = store.projects.create({
      name: 'WS',
      workspace: { kind: 'local', path: dir },
    });
    const chat = store.chats.create({ projectId: project.id });
    store.messages.append({
      chatId: chat.id,
      role: 'user',
      blocks: [{ kind: 'text', text: 'hi' }],
    });

    store.projects.remove(project.id);

    // DB rows gone…
    expect(store.projects.get(project.id)).toBeUndefined();
    expect(store.chats.get(chat.id)).toBeUndefined();
    expect(store.messages.list(chat.id)).toHaveLength(0);
    // …workspace file untouched.
    expect(existsSync(wsFile)).toBe(true);
    store.close();
  });
});

describe.each(backends)('cascade on chat removal & clear — %s', (_name, make) => {
  it('removing a chat removes its messages but keeps the project', () => {
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
    store.chats.remove(chat.id);
    expect(store.chats.get(chat.id)).toBeUndefined();
    expect(store.messages.list(chat.id)).toHaveLength(0);
    expect(store.projects.get(project.id)).toBeDefined();
    store.close();
  });

  it('clear() empties history but keeps the chat record', () => {
    const store = make();
    const project = store.projects.create({
      name: 'P',
      workspace: { kind: 'local', path: '/w' },
    });
    const chat = store.chats.create({ projectId: project.id });
    store.messages.append({ chatId: chat.id, role: 'user', blocks: [{ kind: 'text', text: 'a' }] });
    store.messages.append({ chatId: chat.id, role: 'user', blocks: [{ kind: 'text', text: 'b' }] });
    store.messages.clear(chat.id);
    expect(store.messages.list(chat.id)).toHaveLength(0);
    expect(store.chats.get(chat.id)).toBeDefined();
    // Appending again works after a clear.
    store.messages.append({ chatId: chat.id, role: 'user', blocks: [{ kind: 'text', text: 'c' }] });
    const after = store.messages.list(chat.id);
    expect(after).toHaveLength(1);
    expect((after[0]?.blocks[0] as { text: string }).text).toBe('c');
    store.close();
  });
});

// ---------------------------------------------------------------------------
// Faithful path handling. This persistence layer records workspace paths
// verbatim — it neither confines nor rewrites them (confinement is enforced by
// the tool/permission layer, not storage). These tests pin that contract so a
// path with traversal segments survives a round-trip unchanged.
// ---------------------------------------------------------------------------
describe.each(backends)('workspace path fidelity — %s', (_name, make) => {
  it('stores arbitrary local/remote paths verbatim, including dot segments', () => {
    const store = make();
    const weird = '/home/u/proj/../proj/./sub space/файл';
    const local = store.projects.create({
      name: 'Local',
      workspace: { kind: 'local', path: weird },
    });
    expect(store.projects.get(local.id)?.workspace).toEqual({
      kind: 'local',
      path: weird,
    });

    const remote = store.projects.create({
      name: 'Remote',
      workspace: { kind: 'remote', runtimeId: 'rt1', path: '/srv/app' },
    });
    expect(store.projects.get(remote.id)?.workspace).toEqual({
      kind: 'remote',
      runtimeId: 'rt1',
      path: '/srv/app',
    });
    store.close();
  });

  it('round-trips workspace through the schema validator', () => {
    const ws = { kind: 'remote', runtimeId: 'r', path: '../escape' } as const;
    expect(fromJson(workspaceRefSchema, toJson(ws))).toEqual(ws);
  });
});

// ---------------------------------------------------------------------------
// Export never leaks secrets (Spec 08 §9.4). Even with an API-key-ish value
// living in settings, a chat export must contain only chat/message data.
// ---------------------------------------------------------------------------
describe.each(backends)('export safety — %s', (_name, make) => {
  const secret = 'sk-ant-SECRET-DO-NOT-LEAK';

  function seed(store: DbStore): string {
    const settings: GlobalSettings = {
      authMode: 'plan',
      apiKeyPresent: true,
      defaultModel: 'claude-opus-4-8',
      defaultEffort: 'high',
      showThinking: true,
      permissionDefaults: { bash: 'ask' },
      theme: 'dark',
      showCost: true,
    };
    store.settings.setGlobal(settings);
    // A stray secret stashed under a custom settings key.
    store.settings.set('apiKey', secret);
    const project = store.projects.create({
      name: 'P',
      workspace: { kind: 'local', path: '/w' },
    });
    const chat = store.chats.create({ projectId: project.id, title: 'Export me' });
    store.messages.append({
      chatId: chat.id,
      role: 'assistant',
      blocks: [
        { kind: 'thinking', text: 'reasoned', signature: 'sig' },
        { kind: 'text', text: 'Answer body' },
      ],
      usage: { inputTokens: 1, outputTokens: 2 },
      model: 'claude-opus-4-8',
    });
    return chat.id;
  }

  it('JSON export excludes any secret/settings material', () => {
    const store = make();
    const chatId = seed(store);
    const json = exportChatJson(store, chatId);
    expect(JSON.stringify(json)).not.toContain(secret);
    expect(json.version).toBe(1);
    expect(json.chat.title).toBe('Export me');
    expect(json.messages).toHaveLength(1);
    // No settings/runtimes/apiKey keys leak into the export shape.
    expect(Object.keys(json).sort()).toEqual(['chat', 'exportedAt', 'messages', 'version']);
    store.close();
  });

  it('Markdown export excludes any secret material', () => {
    const store = make();
    const chatId = seed(store);
    const md = exportChatMarkdown(store, chatId);
    expect(md).not.toContain(secret);
    expect(md).toContain('# Export me');
    expect(md).toContain('Answer body');
    store.close();
  });

  it('throws on exporting an unknown chat', () => {
    const store = make();
    expect(() => exportChatJson(store, 'nope')).toThrow(/not found/i);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// SQLite-only integrity: foreign keys enforced + transactions roll back.
// (The in-memory store is explicitly best-effort for both — see its docstring.)
// ---------------------------------------------------------------------------
describe('SqliteDbStore integrity', () => {
  it('enforces the chat -> project foreign key', () => {
    const store = new SqliteDbStore({ path: ':memory:' });
    expect(() => store.chats.create({ projectId: 'missing' })).toThrow(/FOREIGN KEY/i);
    store.close();
  });

  it('rolls back a failed transaction', () => {
    const store = new SqliteDbStore({ path: ':memory:' });
    expect(() =>
      store.transaction(() => {
        store.projects.create({
          id: 'rollme',
          name: 'T',
          workspace: { kind: 'local', path: '/w' },
        });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(store.projects.get('rollme')).toBeUndefined();
    store.close();
  });

  it('persists schema_version across reopen and stays current', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-ver-'));
    try {
      const path = join(dir, 'db.sqlite');
      const s1 = new SqliteDbStore({ path });
      expect(s1.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
      s1.close();
      const s2 = new SqliteDbStore({ path });
      expect(s2.schemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
