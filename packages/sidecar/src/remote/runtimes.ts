/**
 * RemoteRuntimeStore (Spec 05 §6/§7): CRUD over the runtimes repo plus live
 * connection management. Implements the {@link RuntimesAPI} contract — add/list/
 * remove persist; connect/disconnect drive {@link RemoteRuntimeClient}s; fsList
 * proxies to the daemon. Status is in-memory (offline until a client connects).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type {
  ChatMessage,
  DirEntry,
  EngineEvent,
  RemoteRuntime,
  RemoteRuntimeStatus,
  RuntimesAPI,
} from '@vingsforge/shared';
import type { DbStore, RuntimeRecord } from '@vingsforge/persistence';
import {
  RemoteRuntimeClient,
  type RemoteClientOptions,
} from './client.js';

/** Raised when an operation targets a runtime id that is not registered. */
export class RemoteRuntimeNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`remote runtime not found: ${id}`);
    this.name = 'RemoteRuntimeNotFoundError';
  }
}

/**
 * List a local directory for the `local` runtime — powers the Explorer of a
 * local project. Directories first, then files, alphabetical. An empty/missing
 * path yields an empty listing rather than throwing (no project open yet).
 */
export async function listLocalDir(dir: string): Promise<DirEntry[]> {
  if (!dir) return [];
  const dirents = await readdir(dir, { withFileTypes: true });
  const entries: DirEntry[] = dirents.map((d) => ({
    name: d.name,
    path: join(dir, d.name),
    kind: d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : 'file',
  }));
  entries.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
  );
  return entries;
}

// --- Input validation (Spec 05 §7) -----------------------------------------

const sshSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
    user: z.string().min(1),
    keyPath: z.string().min(1).optional(),
  })
  .strict();

const daemonSchema = z
  .object({
    installPath: z.string().min(1),
    version: z.string().min(1).optional(),
  })
  .strict();

const addInputSchema = z
  .object({
    label: z.string().trim().min(1).max(200),
    ssh: sshSchema,
    daemon: daemonSchema,
    apiKeyLocation: z.enum(['app', 'daemon']),
  })
  .strict();

/** Input accepted by {@link RemoteRuntimeStore.add} (matches the IPC contract). */
export type AddRuntimeInput = z.infer<typeof addInputSchema>;

/**
 * A turn fragment the daemon streamed back for the app to persist (Spec 05 §4):
 * the fully-assembled assistant turn or the batched tool_result user turn. The
 * `kind` selects which store hook (`persistAssistant` / `persistToolResults`)
 * the runtime router invokes.
 */
export type RemotePersist =
  | { kind: 'assistant'; message: ChatMessage }
  | { kind: 'toolResults'; message: ChatMessage };

/** Host collaborators: event sink + a factory so clients are injectable in tests. */
export interface RemoteRuntimeStoreDeps {
  db: DbStore;
  /**
   * Optional sink for remote EngineEvents observed OUTSIDE a turn (e.g. status
   * telemetry). During a turn the {@link RemoteRuntimeStore.onTurnEvent} bridge
   * (used by the runtime router) is the sole path onto the chat bus, so this is
   * not the place to re-emit turn events — doing so would double-deliver them.
   */
  onEvent?(event: EngineEvent): void;
  /** Factory for a per-runtime client (defaults to the real ssh2/ws client). */
  makeClient?(
    record: RuntimeRecord,
    handlers: { onEvent(e: EngineEvent): void; onStatus(s: RemoteRuntimeStatus): void },
  ): RemoteRuntimeClient;
  /** Options passed to the default client factory. */
  clientOptions?: RemoteClientOptions;
}

/**
 * Manages the registry of remote runtimes and their live connections. A single
 * instance serves the whole app; status lives in memory and starts `offline`.
 */
export class RemoteRuntimeStore implements RuntimesAPI {
  private readonly clients = new Map<string, RemoteRuntimeClient>();
  private readonly statuses = new Map<string, RemoteRuntimeStatus>();
  /** Per-turn subscribers used by the runtime router to await `turn.end`. */
  private readonly turnListeners = new Set<(e: EngineEvent) => void>();
  /**
   * Per-turn subscribers for assembled turns to persist (Spec 05 §4). Kept
   * separate from {@link turnListeners} because these carry a full ChatMessage,
   * not an EngineEvent — the runtime router routes them to the store's persist
   * hooks so remote history is durable, signature-complete and replayable.
   */
  private readonly turnPersistListeners = new Set<(p: RemotePersist) => void>();

  constructor(private readonly deps: RemoteRuntimeStoreDeps) {}

  /**
   * Subscribe to every remote EngineEvent (deduped by the client). The runtime
   * router uses this to observe a remote turn's lifecycle without coupling to a
   * specific client; returns an unsubscribe function.
   */
  onTurnEvent(listener: (event: EngineEvent) => void): () => void {
    this.turnListeners.add(listener);
    return () => this.turnListeners.delete(listener);
  }

  private fanoutEvent(event: EngineEvent): void {
    this.deps.onEvent?.(event);
    for (const listener of this.turnListeners) listener(event);
  }

  /**
   * Subscribe to assembled turns the daemon streamed back for persistence
   * (Spec 05 §4). The runtime router uses this to drive the store's persist
   * hooks for a remote turn; returns an unsubscribe function.
   */
  onTurnPersist(listener: (persist: RemotePersist) => void): () => void {
    this.turnPersistListeners.add(listener);
    return () => this.turnPersistListeners.delete(listener);
  }

  private fanoutPersist(persist: RemotePersist): void {
    for (const listener of this.turnPersistListeners) listener(persist);
  }

  /** All registered runtimes with their current in-memory status (Spec 05 §7). */
  async list(): Promise<RemoteRuntime[]> {
    return this.deps.db.runtimes.list().map((r) => this.toRuntime(r));
  }

  /** Register a new VPS (Spec 05 RF-01). Persists offline; does not connect. */
  async add(input: AddRuntimeInput): Promise<RemoteRuntime> {
    const parsed = addInputSchema.parse(input);
    const id = randomUUID();
    // Build optional fields conditionally: the persisted shape uses exact
    // optionals, so we never set `keyPath`/`version` to an explicit `undefined`.
    const ssh: RuntimeRecord['ssh'] = {
      host: parsed.ssh.host,
      port: parsed.ssh.port,
      user: parsed.ssh.user,
    };
    if (parsed.ssh.keyPath !== undefined) ssh.keyPath = parsed.ssh.keyPath;
    const daemon: RuntimeRecord['daemon'] = { installPath: parsed.daemon.installPath };
    if (parsed.daemon.version !== undefined) daemon.version = parsed.daemon.version;
    const record: RuntimeRecord = {
      id,
      label: parsed.label,
      ssh,
      daemon,
      apiKeyLocation: parsed.apiKeyLocation,
      // Per-runtime daemon handshake secret (Spec 05 §2): generated here at add
      // time, persisted, and mirrored onto the VPS by the daemon bootstrap so the
      // daemon can reject any WS connection that doesn't present it.
      authToken: randomBytes(32).toString('base64url'),
    };
    const saved = this.deps.db.runtimes.upsert(record);
    this.statuses.set(saved.id, 'offline');
    return this.toRuntime(saved);
  }

  /** Open a connection to the runtime's daemon (Spec 05 RF-03). Idempotent. */
  async connect(id: string): Promise<void> {
    const record = this.requireRuntime(id);
    let client = this.clients.get(id);
    if (!client) {
      client = this.makeClient(record);
      this.clients.set(id, client);
    }
    await client.connect();
  }

  /** Close the connection and stop reconnecting (Spec 05 RF-03/RF-08). */
  async disconnect(id: string): Promise<void> {
    this.requireRuntime(id);
    const client = this.clients.get(id);
    if (client) {
      await client.disconnect();
      this.clients.delete(id);
    }
    this.statuses.set(id, 'offline');
  }

  /**
   * Install/update the daemon on the VPS (Spec 05 RF-02). Out of scope for this
   * feature (bootstrap script lands separately); marks the runtime `installing`
   * so the UI indicator is correct, then leaves it offline.
   */
  async installDaemon(id: string): Promise<void> {
    this.requireRuntime(id);
    this.statuses.set(id, 'installing');
    // The bootstrap-over-SSH script is implemented separately (Spec 05 RF-02);
    // this method owns only the status transition for now.
    this.statuses.set(id, 'offline');
  }

  /**
   * List a directory. For the `local` sentinel runtime this reads the local
   * filesystem directly (the Explorer of a local project); for a remote runtime
   * it proxies to the connected daemon on the VPS (Spec 05 RF-04/§7).
   */
  async fsList(id: string, path: string): Promise<DirEntry[]> {
    if (id === 'local') return listLocalDir(path);
    this.requireRuntime(id);
    const client = this.clients.get(id);
    if (!client) throw new Error(`runtime '${id}' is not connected`);
    return client.fsList(path);
  }

  /** Remove a runtime from the registry (Spec 05 §7). Disconnects first. */
  async remove(id: string): Promise<void> {
    this.requireRuntime(id);
    await this.disconnect(id);
    this.deps.db.transaction(() => this.deps.db.runtimes.remove(id));
    this.statuses.delete(id);
  }

  /** Live client for a runtime, if connected — used by executeTool resolution. */
  clientFor(id: string): RemoteRuntimeClient | undefined {
    return this.clients.get(id);
  }

  // --- internals ------------------------------------------------------------

  private requireRuntime(id: string): RuntimeRecord {
    const record = this.deps.db.runtimes.get(id);
    if (!record) throw new RemoteRuntimeNotFoundError(id);
    return record;
  }

  private makeClient(record: RuntimeRecord): RemoteRuntimeClient {
    const handlers = {
      onEvent: (e: EngineEvent) => this.fanoutEvent(e),
      onPersistAssistant: (m: ChatMessage) => this.fanoutPersist({ kind: 'assistant', message: m }),
      onPersistToolResults: (m: ChatMessage) =>
        this.fanoutPersist({ kind: 'toolResults', message: m }),
      onStatus: (s: RemoteRuntimeStatus) => this.statuses.set(record.id, s),
      // TOFU: persist the VPS host-key fingerprint pinned on first connect so
      // later reconnects verify against it and a MITM is rejected (Spec 05 §2).
      onPinHostKey: (fingerprint: string) => this.pinHostKey(record.id, fingerprint),
      onError: () => this.statuses.set(record.id, 'error'),
    };
    if (this.deps.makeClient) return this.deps.makeClient(record, handlers);
    return new RemoteRuntimeClient(record, handlers, this.deps.clientOptions ?? {});
  }

  /** Persist a freshly-pinned host-key fingerprint into the runtime record. */
  private pinHostKey(id: string, fingerprint: string): void {
    const current = this.deps.db.runtimes.get(id);
    if (!current || current.ssh.hostFingerprint !== undefined) return;
    const next: RuntimeRecord = {
      ...current,
      ssh: { ...current.ssh, hostFingerprint: fingerprint },
    };
    this.deps.db.transaction(() => this.deps.db.runtimes.upsert(next));
  }

  private toRuntime(record: RuntimeRecord): RemoteRuntime {
    const runtime: RemoteRuntime = {
      id: record.id,
      label: record.label,
      ssh: record.ssh,
      daemon: record.daemon,
      apiKeyLocation: record.apiKeyLocation,
      status: this.statuses.get(record.id) ?? 'offline',
    };
    return runtime;
  }
}
