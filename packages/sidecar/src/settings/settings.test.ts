import { describe, expect, it, vi } from 'vitest';
import { createInMemoryDbStore } from '@vingsforge/persistence';
import { DEFAULT_EFFORT, DEFAULT_MODEL } from '../engine/prompt.js';
import { InMemorySecretStore, ANTHROPIC_API_KEY_REF } from './secret-store.js';
import {
  InvalidSettingsError,
  SettingsStore,
  defaultGlobalSettings,
  staticModels,
} from './settings-store.js';
import type { SettingsClientPort } from './client.js';

function makeStore(client?: SettingsClientPort) {
  const db = createInMemoryDbStore();
  const secrets = new InMemorySecretStore();
  const deps = client ? { db, secrets, client } : { db, secrets };
  return { db, secrets, store: new SettingsStore(deps) };
}

describe('SettingsStore.get/update', () => {
  it('returns defaults with apiKeyPresent=false when nothing is stored', async () => {
    const { store } = makeStore();
    const s = await store.get();
    expect(s).toMatchObject({
      authMode: 'plan',
      apiKeyPresent: false,
      defaultModel: DEFAULT_MODEL,
      defaultEffort: DEFAULT_EFFORT,
      theme: 'dark',
    });
  });

  it('persists authMode through update and reads it back', async () => {
    const { store } = makeStore();
    const next = await store.update({ authMode: 'apiKey' });
    expect(next.authMode).toBe('apiKey');
    expect((await store.get()).authMode).toBe('apiKey');
  });

  it('rejects an invalid authMode value', async () => {
    const { store } = makeStore();
    await expect(
      store.update({ authMode: 'subscription' } as never),
    ).rejects.toBeInstanceOf(InvalidSettingsError);
  });

  it('merges a valid patch and persists it', async () => {
    const { store } = makeStore();
    const next = await store.update({ defaultEffort: 'max', theme: 'light' });
    expect(next.defaultEffort).toBe('max');
    expect(next.theme).toBe('light');
    // defaultModel untouched
    expect(next.defaultModel).toBe(DEFAULT_MODEL);
    const again = await store.get();
    expect(again.theme).toBe('light');
  });

  it('rejects an unknown model', async () => {
    const { store } = makeStore();
    await expect(store.update({ defaultModel: 'gpt-9' })).rejects.toBeInstanceOf(
      InvalidSettingsError,
    );
  });

  it('rejects unknown keys (including apiKeyPresent)', async () => {
    const { store } = makeStore();
    await expect(
      store.update({ apiKeyPresent: true } as never),
    ).rejects.toBeInstanceOf(InvalidSettingsError);
  });
});

describe('SettingsStore API key lifecycle', () => {
  it('setApiKey writes to secure storage, never to the DB, and flips apiKeyPresent', async () => {
    const { store, db, secrets } = makeStore();
    await store.setApiKey('  sk-ant-secret  ');
    // value lives only in the secret store, trimmed
    expect(await secrets.get(ANTHROPIC_API_KEY_REF)).toBe('sk-ant-secret');
    // never persisted in plaintext anywhere in the settings blob
    expect(JSON.stringify(db.settings.all())).not.toContain('sk-ant-secret');
    expect((await store.get()).apiKeyPresent).toBe(true);
  });

  it('rejects an empty key', async () => {
    const { store } = makeStore();
    await expect(store.setApiKey('   ')).rejects.toBeInstanceOf(InvalidSettingsError);
  });

  it('clearApiKey removes it and resets the flag (idempotent)', async () => {
    const { store } = makeStore();
    await store.setApiKey('sk-ant-x');
    await store.clearApiKey();
    await store.clearApiKey();
    expect((await store.get()).apiKeyPresent).toBe(false);
  });

  it('recomputes apiKeyPresent from secure storage, not the persisted flag', async () => {
    const { store, secrets } = makeStore();
    await store.setApiKey('sk-ant-x');
    // Remove the secret out-of-band; the persisted flag is now stale-true.
    await secrets.delete(ANTHROPIC_API_KEY_REF);
    expect((await store.get()).apiKeyPresent).toBe(false);
  });
});

describe('SettingsStore.testApiKey', () => {
  it('reports a typed error when no key is configured', async () => {
    const { store } = makeStore();
    expect(await store.testApiKey()).toEqual({ ok: false, error: 'no API key configured' });
  });

  it('reports offline when no client is injected', async () => {
    const { store } = makeStore();
    await store.setApiKey('sk-ant-x');
    const r = await store.testApiKey();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/offline/);
  });

  it('ok:true on a successful ping', async () => {
    const client: SettingsClientPort = {
      ping: vi.fn().mockResolvedValue(undefined),
      listModels: vi.fn().mockResolvedValue([]),
    };
    const { store } = makeStore(client);
    await store.setApiKey('sk-ant-x');
    expect(await store.testApiKey()).toEqual({ ok: true });
    expect(client.ping).toHaveBeenCalledWith('sk-ant-x');
  });

  it('maps a 401 to a typed error without leaking the key', async () => {
    const client: SettingsClientPort = {
      ping: vi.fn().mockRejectedValue({ status: 401, message: 'sk-ant-x is bad' }),
      listModels: vi.fn().mockResolvedValue([]),
    };
    const { store } = makeStore(client);
    await store.setApiKey('sk-ant-x');
    const r = await store.testApiKey();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/401/);
    expect(r.error).not.toContain('sk-ant-x');
  });
});

describe('SettingsStore.models', () => {
  it('returns the live list when online', async () => {
    const client: SettingsClientPort = {
      ping: vi.fn(),
      listModels: vi
        .fn()
        .mockResolvedValue([{ id: 'claude-opus-4-8', display_name: 'Opus 4.8' }]),
    };
    const { store } = makeStore(client);
    await store.setApiKey('sk-ant-x');
    const models = await store.models();
    expect(models).toEqual([
      { id: 'claude-opus-4-8', displayName: 'Opus 4.8', contextWindow: 1_000_000 },
    ]);
  });

  it('falls back to the static allowlist offline', async () => {
    const { store } = makeStore();
    expect(await store.models()).toEqual(staticModels());
  });

  it('falls back to the static allowlist when the live call throws', async () => {
    const client: SettingsClientPort = {
      ping: vi.fn(),
      listModels: vi.fn().mockRejectedValue(new Error('network')),
    };
    const { store } = makeStore(client);
    await store.setApiKey('sk-ant-x');
    expect(await store.models()).toEqual(staticModels());
  });
});

describe('helpers', () => {
  it('defaultGlobalSettings returns a fresh object each call', () => {
    expect(defaultGlobalSettings()).not.toBe(defaultGlobalSettings());
  });
});
