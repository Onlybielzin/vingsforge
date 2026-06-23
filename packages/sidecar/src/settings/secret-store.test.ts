import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANTHROPIC_API_KEY_REF,
  InMemorySecretStore,
  LibSecretStore,
  SecretStoreError,
} from './secret-store.js';

describe('InMemorySecretStore', () => {
  it('round-trips, reports presence and deletes idempotently', async () => {
    const s = new InMemorySecretStore();
    expect(await s.has(ANTHROPIC_API_KEY_REF)).toBe(false);
    expect(await s.get(ANTHROPIC_API_KEY_REF)).toBeUndefined();

    await s.set(ANTHROPIC_API_KEY_REF, 'sk-1');
    expect(await s.has(ANTHROPIC_API_KEY_REF)).toBe(true);
    expect(await s.get(ANTHROPIC_API_KEY_REF)).toBe('sk-1');

    await s.set(ANTHROPIC_API_KEY_REF, 'sk-2'); // overwrite
    expect(await s.get(ANTHROPIC_API_KEY_REF)).toBe('sk-2');

    await s.delete(ANTHROPIC_API_KEY_REF);
    await s.delete(ANTHROPIC_API_KEY_REF); // idempotent
    expect(await s.has(ANTHROPIC_API_KEY_REF)).toBe(false);
  });

  it('namespaces by service+account', async () => {
    const s = new InMemorySecretStore();
    await s.set({ service: 'a', account: 'k' }, 'va');
    await s.set({ service: 'b', account: 'k' }, 'vb');
    expect(await s.get({ service: 'a', account: 'k' })).toBe('va');
    expect(await s.get({ service: 'b', account: 'k' })).toBe('vb');
  });
});

// A fake `secret-tool` that stores under $FAKE_STORE_DIR using attribute files.
// Verifies LibSecretStore's argv/stdin contract without a real keyring.
const dir = mkdtempSync(join(tmpdir(), 'vf-secret-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeSecretTool(): string {
  const bin = join(dir, 'secret-tool');
  const store = join(dir, 'store');
  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dir = ${JSON.stringify(store)};
fs.mkdirSync(dir, { recursive: true });
const [cmd, ...rest] = process.argv.slice(2);
// parse "service X account Y" (skipping --label LBL for store)
const args = [...rest];
let label;
if (args[0] === '--label') { args.shift(); label = args.shift(); }
const attrs = {};
for (let i = 0; i < args.length; i += 2) attrs[args[i]] = args[i + 1];
const file = path.join(dir, attrs.service + '__' + attrs.account);
if (cmd === 'store') {
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => { fs.writeFileSync(file, input); process.exit(0); });
} else if (cmd === 'lookup') {
  if (fs.existsSync(file)) { process.stdout.write(fs.readFileSync(file)); process.exit(0); }
  process.exit(1);
} else if (cmd === 'clear') {
  if (fs.existsSync(file)) fs.unlinkSync(file);
  process.exit(0);
} else { process.exit(2); }
`;
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return bin;
}

describe('LibSecretStore (against a fake secret-tool)', () => {
  it('stores via stdin, looks up, reports presence and clears', async () => {
    const s = new LibSecretStore(fakeSecretTool());
    expect(await s.has(ANTHROPIC_API_KEY_REF)).toBe(false);

    await s.set(ANTHROPIC_API_KEY_REF, 'sk-secret');
    expect(await s.get(ANTHROPIC_API_KEY_REF)).toBe('sk-secret');
    expect(await s.has(ANTHROPIC_API_KEY_REF)).toBe(true);

    await s.delete(ANTHROPIC_API_KEY_REF);
    expect(await s.get(ANTHROPIC_API_KEY_REF)).toBeUndefined();
  });

  it('raises SecretStoreError when the backend binary is missing', async () => {
    const s = new LibSecretStore(join(dir, 'does-not-exist'));
    await expect(s.set(ANTHROPIC_API_KEY_REF, 'x')).rejects.toBeInstanceOf(SecretStoreError);
  });
});
