/**
 * SSH tunnel host-key verification (Spec 05 §2). We mock `ssh2` to capture the
 * `ConnectConfig` and exercise its `hostVerifier` directly: it must pin on first
 * use (TOFU), accept a matching pinned key, reject a mismatch as a possible MITM,
 * and always set a `readyTimeout` so a black-holed host cannot hang forever.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectConfig } from 'ssh2';

let captured: ConnectConfig | undefined;

vi.mock('ssh2', () => {
  class FakeClient {
    on(): this {
      return this;
    }
    connect(config: ConnectConfig): void {
      captured = config;
      // Never emit 'ready'/'error': we only assert on the captured config.
    }
    end(): void {}
  }
  return { Client: FakeClient };
});

// Import after the mock is registered.
const { openSshTunnel, HostKeyMismatchError } = await import('./tunnel.js');

const SSH = { host: 'vps.example', port: 2222, user: 'root' };
const TARGET = { daemonHost: '127.0.0.1', daemonPort: 8717 };

function fingerprint(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

afterEach(() => {
  captured = undefined;
  vi.restoreAllMocks();
});

describe('openSshTunnel host verification (Spec 05 §2)', () => {
  it('sets a readyTimeout and a hostVerifier', () => {
    void openSshTunnel(SSH, TARGET);
    expect(captured?.readyTimeout).toBeGreaterThan(0);
    expect(typeof captured?.hostVerifier).toBe('function');
  });

  it('pins the fingerprint on first connect (TOFU) and accepts the key', () => {
    const pinned: string[] = [];
    void openSshTunnel(SSH, TARGET, { onPin: (fp) => pinned.push(fp) });
    const key = Buffer.from('host-key-bytes');
    const verifier = captured?.hostVerifier as (k: Buffer) => boolean;
    expect(verifier(key)).toBe(true);
    expect(pinned).toEqual([fingerprint(key)]);
  });

  it('accepts a key matching the pinned fingerprint', () => {
    const key = Buffer.from('host-key-bytes');
    void openSshTunnel(SSH, TARGET, { expectedFingerprint: fingerprint(key) });
    const verifier = captured?.hostVerifier as (k: Buffer) => boolean;
    expect(verifier(key)).toBe(true);
  });

  it('rejects a key that does not match the pinned fingerprint (MITM)', async () => {
    const expected = fingerprint(Buffer.from('the-real-host'));
    const promise = openSshTunnel(SSH, TARGET, { expectedFingerprint: expected });
    const verifier = captured?.hostVerifier as (k: Buffer) => boolean;
    expect(verifier(Buffer.from('attacker-host'))).toBe(false);
    await expect(promise).rejects.toBeInstanceOf(HostKeyMismatchError);
  });
});
