/**
 * Embedded bash terminal view (Spec 06 §4): shows the command line and its
 * captured output in a monospace, copyable block. Read-only render of a bash
 * tool card's input/output.
 */
import { useState, type CSSProperties } from 'react';
import { Icon } from './Icon.js';

export interface BashTerminalProps {
  command: string;
  output?: string;
  isError?: boolean;
}

export function BashTerminal({ command, output, isError }: BashTerminalProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(`$ ${command}\n${output ?? ''}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div style={shell}>
      <div style={bar}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--vf-text-muted)' }}>
          <Icon name="terminal" size={13} />
          <span style={{ fontSize: 11 }}>bash</span>
        </span>
        <button style={copyBtn} onClick={copy} title="Copy">
          <Icon name={copied ? 'check' : 'copy'} size={13} />
        </button>
      </div>
      <pre style={body}>
        <span style={{ color: 'var(--vf-accent)' }}>$ </span>
        <span>{command}</span>
        {output != null ? (
          <>
            {'\n'}
            <span style={{ color: isError ? 'var(--vf-danger)' : 'var(--vf-text)' }}>{output}</span>
          </>
        ) : null}
      </pre>
    </div>
  );
}

const shell: CSSProperties = {
  border: '1px solid var(--vf-border)',
  borderRadius: 8,
  overflow: 'hidden',
  background: '#07090c',
};
const bar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '4px 10px',
  borderBottom: '1px solid var(--vf-border)',
  background: 'var(--vf-bg-raised)',
};
const copyBtn: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--vf-text-muted)',
  display: 'grid',
  placeItems: 'center',
};
const body: CSSProperties = {
  margin: 0,
  padding: '10px 12px',
  fontFamily: 'var(--vf-mono)',
  fontSize: 12.5,
  lineHeight: 1.55,
  color: 'var(--vf-text)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 280,
  overflowY: 'auto',
};
