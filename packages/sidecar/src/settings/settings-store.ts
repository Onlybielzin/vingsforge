/**
 * SettingsStore (Spec 07): layered configuration (global > project > chat, most
 * specific wins) plus API-key lifecycle over a {@link SecretStore} and online
 * model/key validation via an injected {@link SettingsClientPort}. Implements the
 * {@link SettingsAPI} contract. The API key value is held only in secure storage
 * and never persisted or logged here (Spec 07 §6).
 */
import { z } from 'zod';
import {
  isKnownModel,
  KNOWN_MODELS,
  type ApiKeyTestResult,
  type Decision,
  type Effort,
  type GlobalSettings,
  type ModelId,
  type ModelInfo,
  type SettingsAPI,
} from '@vingsforge/shared';
import type { DbStore } from '@vingsforge/persistence';
import { DEFAULT_EFFORT, DEFAULT_MODEL } from '../engine/prompt.js';
import {
  isStatusError,
  toModelInfo,
  type SettingsClientPort,
} from './client.js';
import {
  ANTHROPIC_API_KEY_REF,
  type SecretStore,
} from './secret-store.js';

/** Raised when `update`/`setApiKey` receives input that fails validation. */
export class InvalidSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSettingsError';
  }
}

// --- defaults & validation -------------------------------------------------

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly Effort[];
const DECISIONS = ['allow', 'ask', 'deny'] as const satisfies readonly Decision[];

/** Factory so each caller gets a fresh object (no shared-reference mutation). */
export function defaultGlobalSettings(): GlobalSettings {
  return {
    authMode: 'plan',
    apiKeyPresent: false,
    defaultModel: DEFAULT_MODEL,
    defaultEffort: DEFAULT_EFFORT,
    showThinking: true,
    permissionDefaults: {},
    theme: 'dark',
    showCost: true,
  };
}

const effortSchema = z.enum(EFFORTS);
const decisionSchema = z.enum(DECISIONS);

/**
 * A settings `update` patch (Spec 07 §5). `apiKeyPresent` is intentionally NOT
 * accepted: it is a derived flag owned by {@link SettingsStore.setApiKey} /
 * {@link SettingsStore.clearApiKey}, never set directly by a client.
 */
const updatePatchSchema = z
  .object({
    authMode: z.enum(['plan', 'apiKey']),
    defaultModel: z
      .string()
      .refine(isKnownModel, { message: 'unknown model' }),
    defaultEffort: effortSchema,
    showThinking: z.boolean(),
    permissionDefaults: z.record(z.string().min(1), decisionSchema),
    theme: z.enum(['dark', 'light']),
    showCost: z.boolean(),
    // Auto-updater checkout. Empty string clears it (back to the app default).
    repoDir: z.string().max(4096),
  })
  .partial()
  .strict();

/** A non-empty trimmed API key. Length-bounded to reject obvious garbage/DoS. */
const apiKeySchema = z.string().trim().min(1).max(512);

// --- store -----------------------------------------------------------------

/** Collaborators the store depends on (all injectable for tests). */
export interface SettingsStoreDeps {
  db: DbStore;
  secrets: SecretStore;
  /** Anthropic validation port (Spec 07 §5). Optional: when absent, `testApiKey`
   *  reports a typed "offline" error and `models` returns the static allowlist. */
  client?: SettingsClientPort;
}

/**
 * Global settings service. Stateless beyond its injected deps, so a single
 * instance serves the whole app. The persisted blob lives behind
 * `db.settings.getGlobal/setGlobal`; the key value lives in `secrets`.
 */
export class SettingsStore implements SettingsAPI {
  constructor(private readonly deps: SettingsStoreDeps) {}

  /**
   * The effective global settings (Spec 07 §4). `apiKeyPresent` is recomputed
   * from secure storage on every read so the flag can never drift from reality.
   */
  async get(): Promise<GlobalSettings> {
    const stored = this.deps.db.settings.getGlobal();
    // Default over the stored blob so a settings file written before `authMode`
    // existed still reads back a valid mode ('plan') instead of undefined.
    const base = { ...defaultGlobalSettings(), ...(stored ?? {}) };
    return { ...base, apiKeyPresent: await this.deps.secrets.has(ANTHROPIC_API_KEY_REF) };
  }

  /**
   * Merge a validated patch over the stored settings and persist (Spec 07 §5).
   * Unknown keys and `apiKeyPresent` are rejected by the schema; the returned
   * value carries the freshly recomputed `apiKeyPresent`.
   */
  async update(patch: Partial<GlobalSettings>): Promise<GlobalSettings> {
    const parsed = this.parse(updatePatchSchema, patch);
    const current = this.deps.db.settings.getGlobal() ?? defaultGlobalSettings();
    const next: GlobalSettings = { ...current };

    if (parsed.authMode !== undefined) next.authMode = parsed.authMode;
    if (parsed.defaultModel !== undefined) next.defaultModel = parsed.defaultModel;
    if (parsed.defaultEffort !== undefined) next.defaultEffort = parsed.defaultEffort;
    if (parsed.showThinking !== undefined) next.showThinking = parsed.showThinking;
    if (parsed.permissionDefaults !== undefined)
      next.permissionDefaults = parsed.permissionDefaults;
    if (parsed.theme !== undefined) next.theme = parsed.theme;
    if (parsed.showCost !== undefined) next.showCost = parsed.showCost;
    if (parsed.repoDir !== undefined) {
      // Empty string clears the override (fall back to the app default).
      const trimmed = parsed.repoDir.trim();
      if (trimmed.length > 0) next.repoDir = trimmed;
      else delete next.repoDir;
    }

    this.deps.db.transaction(() => this.deps.db.settings.setGlobal(next));
    return { ...next, apiKeyPresent: await this.deps.secrets.has(ANTHROPIC_API_KEY_REF) };
  }

  /**
   * Write the API key to OS secure storage (Spec 07 §3/§6). The value is never
   * persisted to the DB; only the `apiKeyPresent` flag is refreshed on the next
   * {@link get}. Validation strips whitespace and rejects empty input.
   */
  async setApiKey(key: string): Promise<void> {
    const value = this.parse(apiKeySchema, key);
    await this.deps.secrets.set(ANTHROPIC_API_KEY_REF, value);
    this.persistApiKeyPresent(true);
  }

  /** Remove the API key from secure storage (Spec 07 §5). Idempotent. */
  async clearApiKey(): Promise<void> {
    await this.deps.secrets.delete(ANTHROPIC_API_KEY_REF);
    this.persistApiKeyPresent(false);
  }

  /**
   * Validate the stored key with one minimal authenticated request (Spec 07 §5).
   * Errors are typed, not thrown: missing key, no online client, or an HTTP
   * status (401/403/429/…) all map to `{ ok: false, error }`. The key value is
   * never included in the result (Spec 07 §6).
   */
  async testApiKey(): Promise<ApiKeyTestResult> {
    const key = await this.deps.secrets.get(ANTHROPIC_API_KEY_REF);
    if (!key) return { ok: false, error: 'no API key configured' };
    if (!this.deps.client) return { ok: false, error: 'offline: cannot reach the Anthropic API' };
    try {
      await this.deps.client.ping(key);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  }

  /**
   * List models via the Models API when online (Spec 07 §5). Falls back to the
   * static {@link KNOWN_MODELS} allowlist when offline or unauthenticated, so the
   * UI always has a usable list. The live API is authoritative and may return a
   * superset; unknown ids are still rejected as chat/project overrides elsewhere
   * (see shared `isKnownModel`).
   */
  async models(): Promise<ModelInfo[]> {
    const key = await this.deps.secrets.get(ANTHROPIC_API_KEY_REF);
    if (key && this.deps.client) {
      try {
        const rows = await this.deps.client.listModels(key);
        if (rows.length > 0) return rows.map(toModelInfo);
      } catch {
        // Fall through to the static list on any network/auth failure.
      }
    }
    return staticModels();
  }

  // --- internals ------------------------------------------------------------

  /** Persist only the derived flag; the key value never touches the DB (§6). */
  private persistApiKeyPresent(present: boolean): void {
    const current = this.deps.db.settings.getGlobal() ?? defaultGlobalSettings();
    this.deps.db.transaction(() =>
      this.deps.db.settings.setGlobal({ ...current, apiKeyPresent: present }),
    );
  }

  private parse<T>(schema: z.ZodType<T>, input: unknown): T {
    const result = schema.safeParse(input);
    if (!result.success) {
      throw new InvalidSettingsError(result.error.issues[0]?.message ?? 'invalid settings input');
    }
    return result.data;
  }
}

/** The static allowlist as ModelInfo (offline fallback for {@link SettingsStore.models}). */
export function staticModels(): ModelInfo[] {
  return (KNOWN_MODELS as readonly ModelId[]).map((id) => ({ id, displayName: id }));
}

/** Map any thrown value to a short, key-free error string (Spec 07 §6). */
function describeError(err: unknown): string {
  if (isStatusError(err)) {
    switch (err.status) {
      case 401:
        return 'invalid API key (401 Unauthorized)';
      case 403:
        return 'API key lacks permission (403 Forbidden)';
      case 429:
        return 'rate limited (429 Too Many Requests)';
      default:
        return `request failed (HTTP ${err.status})`;
    }
  }
  if (err instanceof Error) return err.message;
  return 'request failed';
}
