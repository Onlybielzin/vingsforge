/**
 * Animated "thinking" indicator (three dots rising in a wave). Shown while the
 * assistant turn is streaming — the animation lives in `.vf-think` (global.css).
 */
import type { CSSProperties } from 'react';

export function ThinkingDots({ label }: { label?: string }): JSX.Element {
  return (
    <span style={wrap} aria-label={label ?? 'pensando'} role="status">
      <span className="vf-think" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {label ? <span style={text}>{label}</span> : null}
    </span>
  );
}

const wrap: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 8 };
const text: CSSProperties = { fontSize: 12, color: 'var(--vf-text-muted)' };
