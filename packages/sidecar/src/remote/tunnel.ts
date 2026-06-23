/**
 * SSH tunnel to the VPS (Spec 05 §2): opens an `ssh2` connection using the
 * user's key and forwards a local loopback port to the daemon's loopback port on
 * the VPS, so the WebSocket never crosses a public network. No passwords are
 * handled — the key is read from `~/.ssh` or a configured path.
 *
 * Host-key verification (Spec 05 §2 — "sem expor porta pública" implies the VPS
 * must also be authenticated): `ssh2` accepts ANY host key by default, so without
 * a `hostVerifier` the tunnel is open to a man-in-the-middle who could terminate
 * the SSH session and proxy the WebSocket, capturing every `engine.send`, the
 * chat history shipped each turn (§4), tool outputs, and — when
 * `apiKeyLocation === 'app'` — the Anthropic key. We verify the presented key
 * against the user's `~/.ssh/known_hosts` and, failing that, against a fingerprint
 * pinned on first connect (TOFU) and persisted in the runtime record.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client, type ConnectConfig } from 'ssh2';
import type { RemoteRuntime } from '@vingsforge/shared';

/** How long to wait for the SSH handshake before giving up (Spec 05 §8). */
const READY_TIMEOUT_MS = 15_000;

/** A live tunnel: the local port the WebSocket client should connect to. */
export interface SshTunnel {
  /** Loopback port on the app machine forwarded to the daemon on the VPS. */
  readonly localPort: number;
  close(): Promise<void>;
}

/** The port the forge-daemon listens on inside the VPS (loopback). */
export interface TunnelTarget {
  /** Daemon host inside the VPS (always loopback in v1). */
  daemonHost: string;
  daemonPort: number;
}

/** Host-key pinning hooks so a tunnel can verify (and TOFU-pin) the VPS. */
export interface HostKeyOptions {
  /**
   * SHA-256 fingerprint (base64, no `SHA256:` prefix) pinned on a previous
   * connect. When set, the presented key MUST match it; otherwise the connect
   * is rejected as a possible MITM.
   */
  expectedFingerprint?: string;
  /**
   * Called once when a host is pinned for the first time (TOFU). The host wires
   * this to persist the fingerprint in the runtime record so reconnects compare.
   */
  onPin?: (fingerprint: string) => void;
}

/** Raised when the VPS host key does not match the pinned/known fingerprint. */
export class HostKeyMismatchError extends Error {
  constructor(host: string, expected: string, actual: string) {
    super(
      `SSH host key for ${host} does not match the pinned key — refusing to ` +
        `connect (possible man-in-the-middle). Expected SHA256:${expected}, ` +
        `got SHA256:${actual}. If the VPS key changed intentionally, remove and ` +
        `re-add the runtime.`,
    );
    this.name = 'HostKeyMismatchError';
  }
}

/** SHA-256 fingerprint (base64, no padding) of a presented host key. */
function fingerprintOf(key: Buffer): string {
  return createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

/**
 * Reads the private key for an SSH config. Returns `undefined` when no key path
 * is set, leaving `ssh2` to fall back to the agent (Spec 05 §2 — reuse ~/.ssh).
 */
function readKey(keyPath?: string): Buffer | undefined {
  if (!keyPath) return undefined;
  return readFileSync(keyPath);
}

/**
 * Collect the SHA-256 fingerprints recorded for `host` in `~/.ssh/known_hosts`.
 * Best-effort: a missing/unreadable file yields no fingerprints (we then fall
 * back to the pinned fingerprint / TOFU). `known_hosts` lines store the key as
 * `host[,host2] type base64key`; we hash the decoded key to compare with ssh2.
 */
function knownHostFingerprints(host: string, port: number): Set<string> {
  const result = new Set<string>();
  let raw: string;
  try {
    raw = readFileSync(join(homedir(), '.ssh', 'known_hosts'), 'utf8');
  } catch {
    return result;
  }
  // Non-default ports are recorded as `[host]:port` in known_hosts.
  const needle = port === 22 ? host : `[${host}]:${port}`;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('@')) continue;
    const [hosts, , keyB64] = trimmed.split(/\s+/);
    if (!hosts || !keyB64) continue;
    if (!hosts.split(',').includes(needle)) continue;
    try {
      result.add(fingerprintOf(Buffer.from(keyB64, 'base64')));
    } catch {
      // Skip malformed entries.
    }
  }
  return result;
}

/**
 * Open an SSH tunnel for a runtime and start a local TCP server that forwards
 * every accepted connection to `target` over the SSH session (port forwarding).
 * Resolves once both the SSH handshake and the local listener are ready.
 *
 * The VPS host key is verified before any traffic flows: it must match an entry
 * in `~/.ssh/known_hosts`, the `expectedFingerprint` pinned on a previous
 * connect, or — on the very first connect with neither available — it is pinned
 * via {@link HostKeyOptions.onPin} (TOFU). Mismatches reject with
 * {@link HostKeyMismatchError}.
 */
export function openSshTunnel(
  ssh: RemoteRuntime['ssh'],
  target: TunnelTarget,
  hostKey: HostKeyOptions = {},
): Promise<SshTunnel> {
  return new Promise<SshTunnel>((resolve, reject) => {
    const conn = new Client();
    let localServer: Server | undefined;
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      localServer?.close();
      conn.end();
      reject(err);
    };

    conn.on('error', fail);

    conn.on('ready', () => {
      localServer = createServer((socket) => {
        conn.forwardOut(
          '127.0.0.1',
          0,
          target.daemonHost,
          target.daemonPort,
          (err, stream) => {
            if (err) {
              socket.destroy();
              return;
            }
            socket.pipe(stream).pipe(socket);
            socket.on('error', () => stream.end());
            stream.on('error', () => socket.destroy());
          },
        );
      });

      localServer.on('error', fail);
      localServer.listen(0, '127.0.0.1', () => {
        const address = localServer?.address();
        const localPort = typeof address === 'object' && address ? address.port : 0;
        settled = true;
        resolve({
          localPort,
          close: () =>
            new Promise<void>((res) => {
              localServer?.close(() => {
                conn.end();
                res();
              });
            }),
        });
      });
    });

    const known = knownHostFingerprints(ssh.host, ssh.port);

    const config: ConnectConfig = {
      host: ssh.host,
      port: ssh.port,
      username: ssh.user,
      readyTimeout: READY_TIMEOUT_MS,
      // ssh2 hands us the raw host key; returning false aborts the handshake
      // before authentication, so a MITM never sees the private key or traffic.
      hostVerifier: (key: Buffer): boolean => {
        const actual = fingerprintOf(key);
        if (hostKey.expectedFingerprint) {
          if (actual === hostKey.expectedFingerprint) return true;
          fail(new HostKeyMismatchError(ssh.host, hostKey.expectedFingerprint, actual));
          return false;
        }
        if (known.size > 0) {
          if (known.has(actual)) return true;
          fail(new HostKeyMismatchError(ssh.host, [...known][0] ?? '', actual));
          return false;
        }
        // First contact, no known_hosts entry: trust on first use and pin it.
        hostKey.onPin?.(actual);
        return true;
      },
    };
    const key = readKey(ssh.keyPath);
    if (key !== undefined) config.privateKey = key;
    conn.connect(config);
  });
}
