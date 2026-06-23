/**
 * Pure context-meter helpers. Replicate the GSD context meter, but compute the
 * "context occupied right now" from the stream-json `usage` of the most recent
 * request (NOT the accumulated session). No I/O, no side effects — safe to use
 * from both the sidecar and the UI.
 */
import type { ModelId } from './common.js';
import type { Usage } from './common.js';

/** 1M-token context window models. */
const ONE_MILLION = 1_000_000;
/** Default / 200k-token context window models, and the unknown-id fallback. */
const TWO_HUNDRED_K = 200_000;

/**
 * Per-model context window (input) size in tokens. opus 4.8/4.7/4.6, sonnet 4.6
 * and fable 5 are 1M; haiku 4.5 is 200k. Unknown ids fall back to 200k.
 */
const CONTEXT_WINDOW_BY_MODEL: Record<string, number> = {
  'claude-opus-4-8': ONE_MILLION,
  'claude-opus-4-7': ONE_MILLION,
  'claude-opus-4-6': ONE_MILLION,
  'claude-opus-4-5': TWO_HUNDRED_K,
  'claude-opus-4-1': TWO_HUNDRED_K,
  'claude-sonnet-4-6': ONE_MILLION,
  'claude-sonnet-4-5': ONE_MILLION,
  'claude-fable-5': ONE_MILLION,
  'claude-mythos-5': ONE_MILLION,
  'claude-haiku-4-5': TWO_HUNDRED_K,
};

/** The fallback context window for unknown / unmapped model ids. */
export const DEFAULT_CONTEXT_WINDOW = TWO_HUNDRED_K;

/** Context-meter state band, mirroring the GSD color ranges. */
export type ContextMeterState = 'healthy' | 'warning' | 'critical' | 'danger';

/** A computed context meter: how full the model's window is right now. */
export interface ContextMeter {
  /** Tokens occupying the context window for the latest request. */
  usedTokens: number;
  /** Percentage of the window used, clamped to [0, 100]. */
  percent: number;
  /** Color band: <50 healthy, <65 warning, <80 critical, >=80 danger. */
  state: ContextMeterState;
}

/**
 * Context window (in tokens) for a model id, with a 200k fallback for unknown
 * ids (see {@link DEFAULT_CONTEXT_WINDOW}).
 */
export function contextWindowFor(modelId: ModelId | undefined): number {
  if (!modelId) return DEFAULT_CONTEXT_WINDOW;
  return CONTEXT_WINDOW_BY_MODEL[modelId] ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * Tokens occupying the context window for a single request: the request's input
 * plus cache-read and cache-creation input tokens. Tolerant of absent fields.
 */
export function usedContextTokens(usage: Usage | undefined): number {
  if (!usage) return 0;
  // Number.isFinite drops NaN/Infinity too (typeof NaN === 'number'), so a dirty
  // field never propagates into the percentage.
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return n(usage.inputTokens) + n(usage.cacheReadInputTokens) + n(usage.cacheCreationInputTokens);
}

/**
 * Total tokens spent for a `usage`: input + output + cache-read + cache-creation.
 * This is the headline "tokens gastos" number (everything the request moved),
 * unlike {@link usedContextTokens} which omits output (it measures occupancy).
 * Tolerant of absent/dirty fields.
 */
export function totalTokens(usage: Usage | undefined): number {
  if (!usage) return 0;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return (
    n(usage.inputTokens) +
    n(usage.outputTokens) +
    n(usage.cacheReadInputTokens) +
    n(usage.cacheCreationInputTokens)
  );
}

/** Map a used-percentage to its color band. */
function meterState(percent: number): ContextMeterState {
  if (percent < 50) return 'healthy';
  if (percent < 65) return 'warning';
  if (percent < 80) return 'critical';
  return 'danger';
}

/**
 * Compute the context meter for the latest request's `usage` against a model's
 * context `window`. Returns `null` when there is no usage to measure (so the UI
 * can hide the meter). `percent` is `min(100, round(used / window * 100))`.
 */
export function computeContextMeter(
  usage: Usage | undefined,
  window: number,
): ContextMeter | null {
  if (!usage) return null;
  const usedTokens = usedContextTokens(usage);
  const safeWindow = Number.isFinite(window) && window > 0 ? window : DEFAULT_CONTEXT_WINDOW;
  // Clamp both ends: usedTokens is already >=0, but a defensive [0,100] keeps the
  // contract even if the window table ever changes.
  const percent = Math.max(0, Math.min(100, Math.round((usedTokens / safeWindow) * 100)));
  return { usedTokens, percent, state: meterState(percent) };
}
