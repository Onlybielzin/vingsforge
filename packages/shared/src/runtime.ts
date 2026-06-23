/**
 * Remote runtime (VPS) model. Spec 05 §6.
 */

export type RemoteRuntimeStatus =
  | 'offline'
  | 'connecting'
  | 'online'
  | 'installing'
  | 'error';

export interface RemoteRuntime {
  id: string;
  label: string;
  ssh: {
    host: string;
    port: number;
    user: string;
    keyPath?: string;
    /**
     * SHA-256 fingerprint (base64, no `SHA256:` prefix) of the VPS host key,
     * pinned on first connect (TOFU) and verified on every reconnect to block
     * man-in-the-middle attacks on the SSH tunnel (Spec 05 §2).
     */
    hostFingerprint?: string;
  };
  daemon: {
    installPath: string;
    version?: string;
  };
  /** Where the Anthropic API key lives for this runtime (Spec 05 §2). */
  apiKeyLocation: 'app' | 'daemon';
  status: RemoteRuntimeStatus;
}

/** A filesystem entry returned by remote/local dir listing (Spec 05 §7 fsList). */
export interface DirEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir' | 'symlink';
  size?: number;
}
