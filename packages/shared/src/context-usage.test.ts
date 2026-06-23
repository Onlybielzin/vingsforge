/**
 * Pure unit tests for the context-meter helpers (no I/O, no side effects):
 *   - contextWindowFor: every mapped modelId + the unknown-id / undefined fallback.
 *   - usedContextTokens: with and without cache fields, undefined-tolerant.
 *   - computeContextMeter: 0%, the band boundaries (49/50/64/65/79/80/100),
 *     clamp >100, usage undefined -> null, and "never NaN" guarantees.
 */
import { describe, expect, it } from 'vitest';
import type { Usage } from './common.js';
import {
  DEFAULT_CONTEXT_WINDOW,
  computeContextMeter,
  contextWindowFor,
  totalTokens,
  usedContextTokens,
} from './context-usage.js';

const ONE_MILLION = 1_000_000;
const TWO_HUNDRED_K = 200_000;

/** Build a Usage object; inputTokens defaults to a value, others optional. */
function usage(partial: Partial<Usage> = {}): Usage {
  return { inputTokens: 0, outputTokens: 0, ...partial };
}

describe('contextWindowFor', () => {
  it.each([
    ['claude-opus-4-8', ONE_MILLION],
    ['claude-opus-4-7', ONE_MILLION],
    ['claude-opus-4-6', ONE_MILLION],
    ['claude-sonnet-4-6', ONE_MILLION],
    ['claude-fable-5', ONE_MILLION],
    ['claude-haiku-4-5', TWO_HUNDRED_K],
  ])('maps %s -> %d tokens', (modelId, expected) => {
    expect(contextWindowFor(modelId)).toBe(expected);
  });

  it('falls back to 200k for an unknown model id', () => {
    expect(contextWindowFor('claude-made-up-9')).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(contextWindowFor('')).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('falls back to 200k for undefined', () => {
    expect(contextWindowFor(undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('DEFAULT_CONTEXT_WINDOW is 200k', () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(TWO_HUNDRED_K);
  });

  it('never returns NaN / non-positive for any of these ids', () => {
    for (const id of [
      'claude-opus-4-8',
      'claude-haiku-4-5',
      'unknown',
      '',
      undefined,
    ]) {
      const w = contextWindowFor(id);
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThan(0);
    }
  });
});

describe('usedContextTokens', () => {
  it('returns 0 for undefined usage', () => {
    expect(usedContextTokens(undefined)).toBe(0);
  });

  it('returns inputTokens when no cache fields are present', () => {
    expect(usedContextTokens(usage({ inputTokens: 1234 }))).toBe(1234);
  });

  it('sums input + cacheRead + cacheCreation when all present', () => {
    expect(
      usedContextTokens(
        usage({
          inputTokens: 100,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 3,
        }),
      ),
    ).toBe(123);
  });

  it('counts only cacheRead when cacheCreation is absent', () => {
    expect(
      usedContextTokens(usage({ inputTokens: 10, cacheReadInputTokens: 5 })),
    ).toBe(15);
  });

  it('counts only cacheCreation when cacheRead is absent', () => {
    expect(
      usedContextTokens(usage({ inputTokens: 10, cacheCreationInputTokens: 7 })),
    ).toBe(17);
  });

  it('treats all-zero usage as 0', () => {
    expect(
      usedContextTokens(
        usage({
          inputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        }),
      ),
    ).toBe(0);
  });

  it('is tolerant of non-number fields (defends against bad stream-json)', () => {
    // The fields are typed as number|undefined, but real stream-json can be
    // sloppy; the impl guards with typeof checks, so a cast-in junk value must
    // be ignored rather than produce NaN.
    const dirty = {
      inputTokens: 'oops',
      outputTokens: 0,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: undefined,
    } as unknown as Usage;
    const result = usedContextTokens(dirty);
    expect(result).toBe(0);
    expect(Number.isNaN(result)).toBe(false);
  });
});

describe('computeContextMeter', () => {
  it('returns null when usage is undefined', () => {
    expect(computeContextMeter(undefined, ONE_MILLION)).toBeNull();
  });

  it('is 0% / healthy for all-zero usage', () => {
    const meter = computeContextMeter(usage(), ONE_MILLION);
    expect(meter).not.toBeNull();
    expect(meter!.usedTokens).toBe(0);
    expect(meter!.percent).toBe(0);
    expect(meter!.state).toBe('healthy');
  });

  it('reports usedTokens including cache fields', () => {
    const meter = computeContextMeter(
      usage({
        inputTokens: 100,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 50,
      }),
      ONE_MILLION,
    );
    expect(meter!.usedTokens).toBe(200);
  });

  // Boundary table: percent -> expected band. The window is 1000 tokens so
  // "used tokens" reads directly as the percentage.
  it.each([
    [0, 'healthy'],
    [49, 'healthy'],
    [50, 'warning'],
    [64, 'warning'],
    [65, 'critical'],
    [79, 'critical'],
    [80, 'danger'],
    [100, 'danger'],
  ] as const)('at %d%% the state is %s', (percent, state) => {
    const meter = computeContextMeter(usage({ inputTokens: percent }), 100);
    expect(meter!.percent).toBe(percent);
    expect(meter!.state).toBe(state);
  });

  it('clamps percent to 100 when usage exceeds the window', () => {
    const meter = computeContextMeter(usage({ inputTokens: 5_000 }), 1_000);
    expect(meter!.usedTokens).toBe(5_000);
    expect(meter!.percent).toBe(100);
    expect(meter!.state).toBe('danger');
  });

  it('rounds percent (half-up) rather than truncating', () => {
    // 497/1000 = 49.7% -> rounds to 50% -> warning band.
    const meter = computeContextMeter(usage({ inputTokens: 497 }), 1_000);
    expect(meter!.percent).toBe(50);
    expect(meter!.state).toBe('warning');
  });

  it('falls back to the default window when window is 0 (no division by zero)', () => {
    const meter = computeContextMeter(usage({ inputTokens: DEFAULT_CONTEXT_WINDOW }), 0);
    expect(meter!.percent).toBe(100);
    expect(Number.isNaN(meter!.percent)).toBe(false);
  });

  it('falls back to the default window when window is negative', () => {
    const meter = computeContextMeter(usage({ inputTokens: 1_000 }), -50);
    // 1000 / 200000 = 0.5% -> rounds to 1%.
    expect(meter!.percent).toBe(1);
    expect(Number.isNaN(meter!.percent)).toBe(false);
  });

  it('never produces a NaN percent across a range of inputs', () => {
    const windows = [ONE_MILLION, TWO_HUNDRED_K, 100, 1, 0, -1];
    const tokens = [0, 1, 99, 100, 999, 1_000_000, 50_000_000];
    for (const w of windows) {
      for (const t of tokens) {
        const meter = computeContextMeter(usage({ inputTokens: t }), w);
        expect(meter).not.toBeNull();
        expect(Number.isNaN(meter!.percent)).toBe(false);
        expect(meter!.percent).toBeGreaterThanOrEqual(0);
        expect(meter!.percent).toBeLessThanOrEqual(100);
      }
    }
  });

  it('integrates with contextWindowFor for a real 1M model at scale', () => {
    // 500k tokens against a 1M opus window => exactly 50% => warning.
    const meter = computeContextMeter(
      usage({ inputTokens: 500_000 }),
      contextWindowFor('claude-opus-4-8'),
    );
    expect(meter!.percent).toBe(50);
    expect(meter!.state).toBe('warning');
  });
});

describe('totalTokens', () => {
  it('returns 0 for undefined', () => {
    expect(totalTokens(undefined)).toBe(0);
  });

  it('sums input + output + cache-read + cache-creation', () => {
    expect(
      totalTokens(
        usage({
          inputTokens: 100,
          outputTokens: 40,
          cacheReadInputTokens: 1000,
          cacheCreationInputTokens: 7,
        }),
      ),
    ).toBe(1147);
  });

  it('includes output (unlike usedContextTokens, which omits it)', () => {
    const u = usage({ inputTokens: 100, outputTokens: 40 });
    expect(usedContextTokens(u)).toBe(100);
    expect(totalTokens(u)).toBe(140);
  });

  it('ignores dirty/negative/NaN fields (no NaN leak)', () => {
    const u = { inputTokens: 50, outputTokens: NaN, cacheReadInputTokens: -10 } as unknown as Usage;
    expect(totalTokens(u)).toBe(50);
  });
});
