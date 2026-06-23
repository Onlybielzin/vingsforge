/**
 * Anthropic ports for settings (Spec 07 §5): minimal, structurally-typed surfaces
 * the SettingsStore depends on for `testApiKey` and `models.list`. As with the
 * engine's client port, the real `@anthropic-ai/sdk` client is injected in prod
 * and a stub in tests — no real API call is ever made under test, and the SDK is
 * never imported here so the value never leaks into logs (Spec 07 §6).
 */
import type { ModelInfo } from '@vingsforge/shared';

/** A model row as returned by the Models API (`GET /v1/models`). */
export interface RawModelRow {
  id: string;
  display_name?: string;
}

/**
 * The injected validation surface. `factory(apiKey)` builds a per-call client
 * bound to the supplied key so the key is never stored on a long-lived object.
 * `ping` makes the cheapest possible authenticated request (Spec 07 §5: "1
 * request mínima") and `listModels` backs `models.list`.
 */
export interface SettingsClientPort {
  /**
   * Minimal authenticated probe. Resolves on success; rejects with an error
   * carrying a numeric `status` (401/403/429/…) on failure so the store can map
   * it to a typed {@link ApiKeyTestResult} (Spec 07 §6).
   */
  ping(apiKey: string): Promise<void>;
  /** List available models for `models.list` (Spec 07 §5). */
  listModels(apiKey: string): Promise<RawModelRow[]>;
}

/** An error exposing an HTTP-ish `status`, as thrown by the Anthropic SDK. */
export interface StatusError {
  status: number;
  message?: string;
}

/** True when `e` looks like an HTTP error from the SDK (has a numeric status). */
export function isStatusError(e: unknown): e is StatusError {
  return (
    typeof e === 'object' &&
    e !== null &&
    'status' in e &&
    typeof (e as { status: unknown }).status === 'number'
  );
}

/** Map a raw Models API row to the shared {@link ModelInfo}. */
export function toModelInfo(row: RawModelRow): ModelInfo {
  return {
    id: row.id,
    displayName: row.display_name ?? row.id,
  };
}
