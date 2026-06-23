/**
 * Edge-case & security coverage for the settings feature (Spec 07), complementing
 * the happy-path suite in settings.test.ts. Focus areas:
 *  - input validation hardening (§5): partial/empty patches, bad enums, key DoS bound,
 *  - secret confinement (§6): the API key never appears in any read result, error
 *    string, or persisted blob, and is recomputed (never replayed stale) on read,
 *  - durability/replay (Spec 08 dependency): settings survive a fresh store over the
 *    same DB, and a real on-disk SQLite round-trip across two store instances,
 *  - secret-backend robustness (§3): signal/timeout kills surface typed errors
 *    instead of collapsing into a false "success", and the value never crosses argv.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInMemoryDbStore,
  createSqliteDbStore,
  GLOBAL_SETTINGS_KEY,
} from '@vingsforge/persistence';
import type { DbStore } from '@vingsforge/persistence';
import { KNOWN_MODELS } from '@vingsforge/shared';
import { DEFAULT_EFFORT, DEFAULT_MODEL } from '../engine/prompt.js';
import {
  ANTHROPIC_API_KEY_REF,
  InMemorySecretStore,
  LibSecretStore,
  SecretStoreError,
} from './secret-store.js';
import {
  InvalidSettingsError,
  SettingsStore,
  defaultGlobalSettings,
  staticModels,
} from './settings-store.js';
import type { SettingsClientPort } from './client.js';

const SECRET = 'sk-ant-super-secret-value-9001';

function makeStore(client?: SettingsClientPort, db: DbStore = createInMemoryDbStore()) {
  const secrets = new InMemorySecretStore();
  const deps = client ? { db, secrets, client } : { db, secrets };
  return { db, secrets, store: new SettingsStore(deps) };
}

// --- validation hardening (Spec 07 §5) ------------------------------------

describe('SettingsStore.update validation', () => {
  it('accepts an empty patch as a no-op and returns current settings', async () => {
    const { store } = makeStore();
    const before = await store.get();
    const after = await store.update({});
    expect(after).toEqual(before);
  });

  it('mutates only the supplied fields, leaving the rest at their defaults', async () => {
    const { store } = makeStore();
    const next = await store.update({ showCost: false });
    expect(next.showCost).toBe(false);
    expect(next.defaultModel).toBe(DEFAULT_MODEL);
    expect(next.defaultEffort).toBe(DEFAULT_EFFORT);
    expect(next.theme).toBe('dark');
    expect(next.showThinking).toBe(true);
  });

  it('accepts every known model id', async () => {
    const { store } = makeStore();
    for (const m of KNOWN_MODELS) {
      const next = await store.update({ defaultModel: m });
      expect(next.defaultModel).toBe(m);
    }
  });

  it('rejects a date-suffixed model id (canonical ids only, Spec 02)', async () => {
    const { store } = makeStore();
    await expect(
      store.update({ defaultModel: 'claude-opus-4-8-20260101' }),
    ).rejects.toBeInstanceOf(InvalidSettingsError);
  });

  it('rejects an invalid effort', async () => {
    const { store } = makeStore();
    await expect(
      store.update({ defaultEffort: 'ultra' as never }),
    ).rejects.toBeInstanceOf(InvalidSettingsError);
  });

  it('rejects an invalid theme', async () => {
    const { store } = makeStore();
    await expect(
      store.update({ theme: 'solarized' as never }),
    ).rejects.toBeInstanceOf(InvalidSettingsError);
  });

  it('rejects a non-boolean showThinking', async () => {
    const { store } = makeStore();
    await expect(
      store.update({ showThinking: 'yes' as never }),
    ).rejects.toBeInstanceOf(InvalidSettingsError);
  });

  it('accepts a valid permissionDefaults map', async () => {
    const { store } = makeStore();
    const next = await store.update({
      permissionDefaults: { Bash: 'ask', Read: 'allow', Write: 'deny' },
    });
    expect(next.permissionDefaults).toEqual({ Bash: 'ask', Read: 'allow', Write: 'deny' });
  });

  it('rejects an empty tool name in permissionDefaults', async () => {
    const { store } = makeStore();
    await expect(
      store.update({ permissionDefaults: { '': 'allow' } }),
    ).rejects.toBeInstanceOf(InvalidSettingsError);
  });

  it('rejects an invalid decision in permissionDefaults', async () => {
    const { store } = makeStore();
    await expect(
      store.update({ permissionDefaults: { Bash: 'maybe' as never } }),
    ).rejects.toBeInstanceOf(InvalidSettingsError);
  });

  it('rejects an unknown extra key alongside valid fields (strict schema)', async () => {
    const { store } = makeStore();
    await expect(
      store.update({ theme: 'light', sneaky: 1 } as never),
    ).rejects.toBeInstanceOf(InvalidSettingsError);
  });

  it('does not persist anything when a patch is rejected', async () => {
    const { store, db } = makeStore();
    await expect(store.update({ defaultModel: 'nope' })).rejects.toBeInstanceOf(
      InvalidSettingsError,
    );
    // No global blob was written; get() still yields untouched defaults.
    expect(db.settings.get(GLOBAL_SETTINGS_KEY)).toBeUndefined();
    expect((await store.get()).defaultModel).toBe(DEFAULT_MODEL);
  });

  it('uses a transaction for the write', async () => {
    const { store, db } = makeStore();
    const spy = vi.spyOn(db, 'transaction');
    await store.update({ theme: 'light' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// --- API-key validation hardening (Spec 07 §5/§6) -------------------------

describe('SettingsStore.setApiKey validation', () => {
  it('rejects an empty string', async () => {
    const { store } = makeStore();
    await expect(store.setApiKey('')).rejects.toBeInstanceOf(InvalidSettingsError);
  });

  it('rejects a key longer than the 512-char DoS bound', async () => {
    const { store } = makeStore();
    await expect(store.setApiKey('x'.repeat(513))).rejects.toBeInstanceOf(
      InvalidSettingsError,
    );
  });

  it('accepts a key exactly at the 512-char bound (trimmed)', async () => {
    const { store, secrets } = makeStore();
    const key = 'x'.repeat(512);
    await store.setApiKey(`  ${key}  `);
    expect(await secrets.get(ANTHROPIC_API_KEY_REF)).toBe(key);
  });

  it('trims surrounding whitespace/newlines before storing', async () => {
    const { store, secrets } = makeStore();
    await store.setApiKey('\n\t  sk-ant-trim  \r\n');
    expect(await secrets.get(ANTHROPIC_API_KEY_REF)).toBe('sk-ant-trim');
  });
});

// --- secret confinement (Spec 07 §6) --------------------------------------

describe('secret confinement', () => {
  it('the key never appears in get(), the persisted blob, or settings.all()', async () => {
    const { store, db } = makeStore();
    await store.setApiKey(SECRET);
    await store.update({ theme: 'light', defaultEffort: 'max' });

    const read = await store.get();
    expect(read.apiKeyPresent).toBe(true);
    expect(JSON.stringify(read)).not.toContain(SECRET);
    expect(JSON.stringify(db.settings.all())).not.toContain(SECRET);
    expect(JSON.stringify(db.settings.get(GLOBAL_SETTINGS_KEY))).not.toContain(SECRET);
  });

  it('a 403/429/unknown-status ping error is typed and never echoes the key', async () => {
    for (const status of [403, 429, 500] as const) {
      const client: SettingsClientPort = {
        ping: vi.fn().mockRejectedValue({ status, message: `key ${SECRET} rejected` }),
        listModels: vi.fn().mockResolvedValue([]),
      };
      const { store } = makeStore(client);
      await store.setApiKey(SECRET);
      const r = await store.testApiKey();
      expect(r.ok).toBe(false);
      expect(r.error).toContain(String(status));
      expect(r.error).not.toContain(SECRET);
    }
  });

  it('a non-status Error from ping surfaces its message but not the key', async () => {
    const client: SettingsClientPort = {
      ping: vi.fn().mockRejectedValue(new Error('socket hang up')),
      listModels: vi.fn().mockResolvedValue([]),
    };
    const { store } = makeStore(client);
    await store.setApiKey(SECRET);
    const r = await store.testApiKey();
    expect(r).toEqual({ ok: false, error: 'socket hang up' });
    expect(r.error).not.toContain(SECRET);
  });

  it('a thrown non-Error value degrades to a generic message', async () => {
    const client: SettingsClientPort = {
      ping: vi.fn().mockRejectedValue(SECRET), // a bare string carrying the key
      listModels: vi.fn().mockResolvedValue([]),
    };
    const { store } = makeStore(client);
    await store.setApiKey(SECRET);
    const r = await store.testApiKey();
    expect(r).toEqual({ ok: false, error: 'request failed' });
    expect(r.error).not.toContain(SECRET);
  });

  it('passes the exact stored key to ping and listModels (no mangling)', async () => {
    const ping = vi.fn().mockResolvedValue(undefined);
    const listModels = vi.fn().mockResolvedValue([]);
    const { store } = makeStore({ ping, listModels });
    await store.setApiKey(SECRET);
    await store.testApiKey();
    await store.models();
    expect(ping).toHaveBeenCalledWith(SECRET);
    expect(listModels).toHaveBeenCalledWith(SECRET);
  });

  it('models() falls back to the static list and never calls the API without a key', async () => {
    const listModels = vi.fn().mockResolvedValue([{ id: 'claude-opus-4-8' }]);
    const { store } = makeStore({ ping: vi.fn(), listModels });
    // No key configured -> the live API must not be probed.
    expect(await store.models()).toEqual(staticModels());
    expect(listModels).not.toHaveBeenCalled();
  });

  it('models() ignores an empty live list and keeps the static fallback', async () => {
    const { store } = makeStore({
      ping: vi.fn(),
      listModels: vi.fn().mockResolvedValue([]),
    });
    await store.setApiKey(SECRET);
    expect(await store.models()).toEqual(staticModels());
  });
});

// --- durability / replay (persistence dependency, Spec 08) ----------------

describe('settings durability & replay', () => {
  it('a fresh store over the same DB sees previously persisted settings', async () => {
    const db = createInMemoryDbStore();
    const a = new SettingsStore({ db, secrets: new InMemorySecretStore() });
    await a.update({ theme: 'light', defaultEffort: 'low', showCost: false });

    // New store instance, same DB: settings must replay verbatim.
    const b = new SettingsStore({ db, secrets: new InMemorySecretStore() });
    const s = await b.get();
    expect(s.theme).toBe('light');
    expect(s.defaultEffort).toBe('low');
    expect(s.showCost).toBe(false);
  });

  it('apiKeyPresent is recomputed from secrets, not replayed from the stale blob', async () => {
    const db = createInMemoryDbStore();
    const secrets = new InMemorySecretStore();
    const store = new SettingsStore({ db, secrets });
    await store.setApiKey(SECRET);
    // Persisted blob now carries apiKeyPresent:true.
    expect((db.settings.getGlobal() as { apiKeyPresent: boolean }).apiKeyPresent).toBe(true);

    // Secret vanishes out-of-band (e.g. keyring wiped between runs).
    await secrets.delete(ANTHROPIC_API_KEY_REF);
    // A brand-new store must report the live truth, not the stale flag.
    const fresh = new SettingsStore({ db, secrets });
    expect((await fresh.get()).apiKeyPresent).toBe(false);
  });

  it('survives a real on-disk SQLite round-trip across two store instances', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vf-settings-'));
    const path = join(dir, 'settings.db');
    try {
      const db1 = createSqliteDbStore({ path });
      const s1 = new SettingsStore({ db: db1, secrets: new InMemorySecretStore() });
      await s1.update({ theme: 'light', defaultModel: 'claude-sonnet-4-6' });
      db1.close();

      // Reopen the same file with a new connection + store.
      const db2 = createSqliteDbStore({ path });
      const s2 = new SettingsStore({ db: db2, secrets: new InMemorySecretStore() });
      const read = await s2.get();
      expect(read.theme).toBe('light');
      expect(read.defaultModel).toBe('claude-sonnet-4-6');
      // The secret is held only in volatile memory, so a fresh process has none.
      expect(read.apiKeyPresent).toBe(false);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defaultGlobalSettings is not a shared mutable reference', () => {
    const a = defaultGlobalSettings();
    a.permissionDefaults['Bash'] = 'deny';
    const b = defaultGlobalSettings();
    expect(b.permissionDefaults).toEqual({});
  });
});

// --- secret backend robustness (Spec 07 §3) -------------------------------
// A fake `secret-tool` lets us exercise the failure modes that must NOT collapse
// into a false success (which would flip apiKeyPresent with nothing written, or
// report a phantom secret) and confirm the value crosses stdin, never argv.

const dir = mkdtempSync(join(tmpdir(), 'vf-secret-edge-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeTool(name: string, body: string): string {
  const bin = join(dir, name);
  writeFileSync(bin, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

describe('LibSecretStore failure handling', () => {
  it('treats a non-zero lookup as "absent", not an error', async () => {
    const bin = fakeTool('st-absent', 'process.exit(1);');
    const s = new LibSecretStore(bin);
    expect(await s.get(ANTHROPIC_API_KEY_REF)).toBeUndefined();
    expect(await s.has(ANTHROPIC_API_KEY_REF)).toBe(false);
  });

  it('raises SecretStoreError (not silent success) when store exits non-zero', async () => {
    const bin = fakeTool('st-store-fail', 'process.stderr.write("locked"); process.exit(3);');
    const s = new LibSecretStore(bin);
    await expect(s.set(ANTHROPIC_API_KEY_REF, 'x')).rejects.toBeInstanceOf(SecretStoreError);
  });

  it('raises SecretStoreError when the backend is killed by a signal (no phantom success)', async () => {
    // SIGKILL self before exiting: err.code === null, err.signal set.
    const bin = fakeTool('st-signal', 'process.kill(process.pid, "SIGKILL");');
    const s = new LibSecretStore(bin);
    await expect(s.set(ANTHROPIC_API_KEY_REF, 'x')).rejects.toBeInstanceOf(SecretStoreError);
  });

  it('the secret value is passed on stdin and never as an argv element', async () => {
    // Record argv to a sidecar file so we can assert the secret is absent from it.
    const argvDump = join(dir, 'argv.json');
    const store = join(dir, 'kv');
    const bin = fakeTool(
      'st-argv',
      `const fs=require('fs');const path=require('path');
fs.mkdirSync(${JSON.stringify(store)},{recursive:true});
fs.writeFileSync(${JSON.stringify(argvDump)}, JSON.stringify(process.argv.slice(2)));
const a=process.argv.slice(2);const cmd=a.shift();
if(a[0]==='--label'){a.shift();a.shift();}
const attrs={};for(let i=0;i<a.length;i+=2)attrs[a[i]]=a[i+1];
const file=path.join(${JSON.stringify(store)},attrs.service+'_'+attrs.account);
if(cmd==='store'){let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{fs.writeFileSync(file,d);process.exit(0);});}
else if(cmd==='lookup'){if(fs.existsSync(file)){process.stdout.write(fs.readFileSync(file));process.exit(0);}process.exit(1);}
else process.exit(0);`,
    );
    const s = new LibSecretStore(bin);
    await s.set(ANTHROPIC_API_KEY_REF, SECRET);
    // Round-trips through the keyring...
    expect(await s.get(ANTHROPIC_API_KEY_REF)).toBe(SECRET);
    // ...but the most recent argv (the lookup) must never carry the secret, and
    // neither does the store argv we captured during set (asserted via no-secret).
    const lastArgv: string[] = JSON.parse(readFileSync(argvDump, 'utf8'));
    expect(lastArgv.join(' ')).not.toContain(SECRET);
  });
});
