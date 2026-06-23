/**
 * Context meter (Spec 06 §4): how full the active model's context window is for
 * the most recent request. Replicates the GSD meter but reads the stream-json
 * `usage` of the latest turn (NOT the accumulated session) — see shared
 * `context-usage.ts` for the pure calc and the per-model window table.
 */
import type { CSSProperties } from 'react';
import type { ModelId, Usage } from '@vingsforge/shared';
import {
  computeContextMeter,
  contextWindowFor,
  type ContextMeterState,
} from '@vingsforge/shared';

export interface ContextMeterProps {
  /** Usage of the latest turn that has usage; undefined renders an empty bar. */
  usage?: Usage;
  /** Active model id; resolves the context window. Ignored when `window` is set. */
  model?: ModelId;
  /** Explicit context window override (tokens); falls back to `model` lookup. */
  window?: number;
}

/** Compact token count: 1234 -> 1.2k, 1_000_000 -> 1M. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1000) {
    const k = n / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(n);
}

/** Color band per the GSD ranges; mirrors {@link ContextMeterState}. */
function barColor(state: ContextMeterState): string {
  switch (state) {
    case 'healthy':
      return 'var(--vf-ok)';
    case 'warning':
      return 'var(--vf-warn)';
    case 'critical':
      return '#e0853a';
    case 'danger':
      return 'var(--vf-danger)';
  }
}

export function ContextMeter({ usage, model, window }: ContextMeterProps): JSX.Element {
  const windowTokens = window ?? contextWindowFor(model);
  const meter = computeContextMeter(usage, windowTokens);
  const percent = meter?.percent ?? 0;
  const used = meter?.usedTokens ?? 0;
  const color = meter ? barColor(meter.state) : 'var(--vf-ok)';

  return (
    <span style={group} title={`${used} / ${windowTokens} tokens de contexto`}>
      <span style={label}>contexto</span>
      <span
        style={track}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="uso do contexto"
      >
        <span style={{ ...fill, width: `${percent}%`, background: color }} />
      </span>
      <span style={{ ...value, color }}>{percent}%</span>
      <span style={ratio}>
        {fmtTokens(used)}/{fmtTokens(windowTokens)}
      </span>
    </span>
  );
}

const group: CSSProperties = { display: 'inline-flex', gap: 6, alignItems: 'center' };
const label: CSSProperties = {
  color: 'var(--vf-text-faint)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  fontSize: 10,
};
const track: CSSProperties = {
  position: 'relative',
  display: 'inline-block',
  width: 72,
  height: 6,
  borderRadius: 3,
  background: 'var(--vf-border)',
  overflow: 'hidden',
};
const fill: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  borderRadius: 3,
  transition: 'width 0.2s ease, background 0.2s ease',
};
const value: CSSProperties = { fontFamily: 'var(--vf-mono)', fontVariantNumeric: 'tabular-nums' };
const ratio: CSSProperties = { fontFamily: 'var(--vf-mono)', color: 'var(--vf-text-faint)' };
