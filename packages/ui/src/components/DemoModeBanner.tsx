/**
 * Discreet banner shown when the UI fell back to the in-memory mock because the
 * sidecar WebSocket was unreachable (Spec 06 §7). Purely informational; it does
 * not block interaction with the (mocked) app.
 */
import { useState, type CSSProperties } from 'react';
import { Icon } from './Icon.js';

export function DemoModeBanner(): JSX.Element | null {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div style={bar} role="status">
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Icon name="cloud" size={13} style={{ color: 'var(--vf-text-faint)' }} />
        modo demo (sidecar offline)
      </span>
      <button
        type="button"
        aria-label="Dispensar"
        style={close}
        onClick={() => setDismissed(true)}
      >
        <Icon name="cross" size={12} />
      </button>
    </div>
  );
}

const bar: CSSProperties = {
  position: 'fixed',
  bottom: 8,
  left: '50%',
  transform: 'translateX(-50%)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  background: 'var(--vf-surface)',
  border: '1px solid var(--vf-border)',
  borderRadius: 999,
  padding: '5px 8px 5px 12px',
  fontSize: 12,
  color: 'var(--vf-text-muted)',
  boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
  zIndex: 90,
};
const close: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 20,
  height: 20,
  borderRadius: 999,
  border: 'none',
  background: 'transparent',
  color: 'var(--vf-text-faint)',
  cursor: 'pointer',
};
