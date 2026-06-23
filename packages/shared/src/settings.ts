/**
 * Global settings + model info. Spec 07.
 */
import type { Decision } from './permissions.js';
import type { Effort, ModelId } from './common.js';

export interface GlobalSettings {
  /**
   * How the Claude turn engine authenticates (Spec 07 §3):
   *  - `'plan'`   — use the machine's logged-in Claude Code subscription (no API
   *                 key needed). This is the default for new installs.
   *  - `'apiKey'` — use a stored ANTHROPIC_API_KEY.
   * The host reads this and selects the auth mode for the claude-cli-runner.
   */
  authMode: 'plan' | 'apiKey';
  /** Whether a key exists in secure storage; the value itself never lives here (Spec 07 §6). */
  apiKeyPresent: boolean;
  defaultModel: ModelId;
  defaultEffort: Effort;
  showThinking: boolean;
  /** Default permission decision per tool (Spec 04 §3). */
  permissionDefaults: Record<string, Decision>;
  theme: 'dark' | 'light';
  showCost: boolean;
}

/**
 * Allowlist of canonical model ids the app accepts as overrides (Spec 07 §5).
 * A chat/project `model` override must be one of these; the live Models API may
 * expose a superset, but unknown ids are rejected up front so a turn never runs
 * against a typo'd or unsupported model. Date suffixes are never used (Spec 02).
 */
export const KNOWN_MODELS = [
  'claude-fable-5',
  'claude-mythos-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-opus-4-1',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
] as const satisfies readonly ModelId[];

/** True when `model` is a recognized canonical model id (see {@link KNOWN_MODELS}). */
export function isKnownModel(model: string): model is ModelId {
  return (KNOWN_MODELS as readonly string[]).includes(model);
}

/** Model metadata from the Models API (Spec 07 §5 models.list). */
export interface ModelInfo {
  id: ModelId;
  displayName: string;
  /** Max output tokens supported, when known. */
  maxOutputTokens?: number;
  /** Whether the model supports adaptive thinking (Spec 03 §2). */
  supportsThinking?: boolean;
}

/** Result of validating the API key (Spec 07 §5 testApiKey). */
export interface ApiKeyTestResult {
  ok: boolean;
  error?: string;
}
