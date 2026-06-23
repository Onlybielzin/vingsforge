/**
 * Token/cost footer (Spec 06 §4): last-turn tokens + session accumulated, with
 * an optional estimated cost when the runtime reports it.
 */
import type { CSSProperties } from 'react';
import type { ModelId, Usage } from '@vingsforge/shared';
import { ContextMeter } from './ContextMeter.js';

export interface TokenFooterProps {
  turnUsage?: Usage;
  sessionUsage: Usage;
  showCost: boolean;
  /** Active model id; resolves the context-meter window. */
  model?: ModelId;
  /** Usage of the latest turn that has usage, for the context meter. */
  contextUsage?: Usage;
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function TokenFooter({
  turnUsage,
  sessionUsage,
  showCost,
  model,
  contextUsage,
}: TokenFooterProps): JSX.Element {
  return (
    <div style={shell}>
      <ContextMeter {...(contextUsage ? { usage: contextUsage } : {})} {...(model ? { model } : {})} />
      {turnUsage ? (
        <span style={group}>
          <span style={label}>turn</span>
          <span style={value}>
            {fmt(turnUsage.inputTokens)} in · {fmt(turnUsage.outputTokens)} out
          </span>
        </span>
      ) : null}
      <span style={group}>
        <span style={label}>session</span>
        <span style={value}>
          {fmt(sessionUsage.inputTokens)} in · {fmt(sessionUsage.outputTokens)} out
        </span>
      </span>
      {showCost && sessionUsage.estimatedCostUsd != null ? (
        <span style={group}>
          <span style={label}>est. cost</span>
          <span style={value}>${sessionUsage.estimatedCostUsd.toFixed(3)}</span>
        </span>
      ) : null}
    </div>
  );
}

const shell: CSSProperties = {
  display: 'flex',
  gap: 16,
  padding: '4px 14px',
  borderTop: '1px solid var(--vf-border)',
  background: 'var(--vf-bg)',
  fontSize: 11.5,
  color: 'var(--vf-text-muted)',
};
const group: CSSProperties = { display: 'inline-flex', gap: 6, alignItems: 'baseline' };
const label: CSSProperties = { color: 'var(--vf-text-faint)', textTransform: 'uppercase', letterSpacing: 0.5, fontSize: 10 };
const value: CSSProperties = { fontFamily: 'var(--vf-mono)' };
