/**
 * Common primitives shared across specs.
 */

/** Effort level for the model output (Spec 03 §2, Spec 07). */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Canonical model id, e.g. 'claude-opus-4-8' (no date suffix). */
export type ModelId = string;

/** ISO-8601 timestamp string. */
export type IsoDateString = string;

/**
 * Token usage / cost accounting for a turn (Spec 02 RF-10, Spec 03).
 * Field names mirror the Anthropic API usage object plus an optional cost estimate.
 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /** Estimated cost in USD, when known (Spec 07 showCost). */
  estimatedCostUsd?: number;
}
