/**
 * Collapsible reasoning panel per turn (Spec 06 §4): renders thinking.delta text
 * in a muted, monospace block, collapsed by default.
 */
import { useState, type CSSProperties } from 'react';
import { Icon } from './Icon.js';

export function ReasoningPanel({ text, defaultOpen = false }: { text: string; defaultOpen?: boolean }): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={shell}>
      <button style={header} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        <span>Reasoning</span>
        <span style={{ color: 'var(--vf-text-faint)', fontSize: 11 }}>{text.length} chars</span>
      </button>
      {open ? <div style={body}>{text}</div> : null}
    </div>
  );
}

const shell: CSSProperties = {
  border: '1px dashed var(--vf-border-strong)',
  borderRadius: 8,
  margin: '6px 0',
  background: 'var(--vf-bg-inset)',
};
const header: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  padding: '6px 10px',
  background: 'transparent',
  border: 'none',
  color: 'var(--vf-text-muted)',
  fontSize: 12,
  textAlign: 'left',
};
const body: CSSProperties = {
  padding: '8px 12px 10px',
  borderTop: '1px dashed var(--vf-border)',
  fontFamily: 'var(--vf-mono)',
  fontSize: 12,
  color: 'var(--vf-text-muted)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};
