/**
 * Permission gate card (Spec 06 §4, Spec 04 §3.1): highlighted block that blocks
 * the flow until the user picks Allow once / Always allow / Deny (with optional
 * reason). Maps to a tool.permission.resolve EngineCommand.
 */
import { useState, type CSSProperties } from 'react';
import { z } from 'zod';
import type { PendingPermission } from '../state/conversation.js';
import { Icon } from './Icon.js';

const reasonSchema = z.string().trim().max(280).optional();

export interface PermissionDecision {
  decision: 'allow' | 'deny';
  remember?: boolean;
  reason?: string;
}

export interface PermissionCardProps {
  request: PendingPermission;
  onResolve(decision: PermissionDecision): void;
}

export function PermissionCard({ request, onResolve }: PermissionCardProps): JSX.Element {
  const [reason, setReason] = useState('');
  const detail = describe(request.input);

  const allow = (remember: boolean): void => onResolve({ decision: 'allow', remember });
  const deny = (): void => {
    const parsed = reasonSchema.safeParse(reason);
    const clean = parsed.success ? parsed.data : undefined;
    onResolve({ decision: 'deny', ...(clean ? { reason: clean } : {}) });
  };

  return (
    <div style={shell} role="alertdialog" aria-label="Permission request" className="vf-fade-in">
      <div style={head}>
        <Icon name="lock" size={16} style={{ color: 'var(--vf-warn)' }} />
        <span style={{ fontWeight: 600 }}>Permission required</span>
        <code style={toolTag}>{request.tool}</code>
      </div>

      {detail ? <pre style={detailBox}>{detail}</pre> : null}

      <input
        style={reasonInput}
        placeholder="Reason (optional, sent to the agent on deny)"
        value={reason}
        maxLength={280}
        onChange={(e) => setReason(e.target.value)}
      />

      <div style={actions}>
        <button style={{ ...btn, ...allowBtn }} onClick={() => allow(false)}>
          <Icon name="check" size={14} />
          Allow once
        </button>
        <button style={{ ...btn, ...alwaysBtn }} onClick={() => allow(true)}>
          Always allow
        </button>
        <button style={{ ...btn, ...denyBtn }} onClick={deny}>
          <Icon name="cross" size={14} />
          Deny
        </button>
      </div>
    </div>
  );
}

function describe(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

const shell: CSSProperties = {
  border: '1px solid var(--vf-warn)',
  borderRadius: 10,
  background: 'color-mix(in srgb, var(--vf-warn) 8%, var(--vf-surface))',
  padding: 12,
  margin: '8px 0',
  boxShadow: '0 0 0 1px color-mix(in srgb, var(--vf-warn) 30%, transparent)',
};
const head: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 };
const toolTag: CSSProperties = {
  marginLeft: 'auto',
  fontFamily: 'var(--vf-mono)',
  fontSize: 11,
  background: 'var(--vf-bg-inset)',
  borderRadius: 5,
  padding: '1px 7px',
};
const detailBox: CSSProperties = {
  margin: '0 0 8px',
  padding: '8px 10px',
  background: 'var(--vf-bg-inset)',
  border: '1px solid var(--vf-border)',
  borderRadius: 7,
  fontFamily: 'var(--vf-mono)',
  fontSize: 12,
  maxHeight: 160,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
};
const reasonInput: CSSProperties = {
  width: '100%',
  padding: '7px 10px',
  marginBottom: 10,
  borderRadius: 7,
  border: '1px solid var(--vf-border)',
  background: 'var(--vf-bg-inset)',
  color: 'var(--vf-text)',
  fontSize: 13,
};
const actions: CSSProperties = { display: 'flex', gap: 8 };
const btn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '7px 12px',
  borderRadius: 7,
  border: '1px solid var(--vf-border)',
  background: 'var(--vf-surface)',
  color: 'var(--vf-text)',
  fontSize: 13,
  fontWeight: 500,
};
const allowBtn: CSSProperties = { borderColor: 'var(--vf-ok)', color: 'var(--vf-ok)' };
const alwaysBtn: CSSProperties = { borderColor: 'var(--vf-border-strong)' };
const denyBtn: CSSProperties = { borderColor: 'var(--vf-danger)', color: 'var(--vf-danger)', marginLeft: 'auto' };
