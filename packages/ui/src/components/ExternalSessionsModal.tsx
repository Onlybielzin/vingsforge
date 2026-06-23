/**
 * "Continuar sessão do Claude" modal. Lists the Claude Code CLI sessions started
 * OUTSIDE the app for the active project's workspace (read from
 * `~/.claude/projects/<encoded-cwd>` by the sidecar via
 * `ipc.projects.externalSessions`) so the user can import one and continue it
 * in-app. Each row shows the first-message preview, the date, and the turn count,
 * with a "Continuar" button that imports + opens it.
 *
 * Presentational + async-state only: the actual import/open/reload is delegated
 * to the store's importExternalSession via the `onContinue` callback. No emoji —
 * iconography only (Spec 06 §2). Color-scheme dark, matching UpdateModal.
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import type { IpcClient } from '../ipc/client.js';
import { Icon } from './Icon.js';
import {
  errorSessions,
  formatSessionDate,
  loadingSessions,
  previewText,
  readySessions,
  turnsLabel,
  type ExternalSessionsState,
} from './externalSessions.js';

export interface ExternalSessionsModalProps {
  ipc: IpcClient;
  /** Project whose external sessions are listed; null disables the listing. */
  projectId: string | null;
  /** Import + open the session, returning when the chat is selected. */
  onContinue(sessionId: string): Promise<unknown>;
  onClose(): void;
}

export function ExternalSessionsModal({
  ipc,
  projectId,
  onContinue,
  onClose,
}: ExternalSessionsModalProps): JSX.Element {
  const [state, setState] = useState<ExternalSessionsState>(loadingSessions);
  /** sessionId currently being imported (disables its button + the others). */
  const [importing, setImporting] = useState<string | null>(null);
  /** Error raised by a failed import (distinct from a failed list load). */
  const [importError, setImportError] = useState<string | null>(null);

  // Load the project's external sessions on open / when the project changes.
  useEffect(() => {
    let cancelled = false;
    setState(loadingSessions);
    setImportError(null);
    if (!projectId) {
      setState(readySessions([]));
      return;
    }
    void (async () => {
      try {
        const sessions = await ipc.projects.externalSessions(projectId);
        if (!cancelled) setState(readySessions(sessions));
      } catch (err) {
        if (!cancelled) {
          setState(errorSessions(err instanceof Error ? err.message : String(err)));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ipc, projectId]);

  const handleContinue = useCallback(
    (sessionId: string) => {
      if (importing) return;
      setImporting(sessionId);
      setImportError(null);
      void (async () => {
        try {
          await onContinue(sessionId);
          onClose();
        } catch (err) {
          setImportError(err instanceof Error ? err.message : String(err));
          setImporting(null);
        }
      })();
    },
    [importing, onContinue, onClose],
  );

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label="Continuar sessão do Claude">
      <div style={card}>
        <div style={head}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="terminal" size={18} style={{ color: 'var(--vf-accent)' }} />
            <h2 style={{ margin: 0, fontSize: 16 }}>Continuar sessão do Claude</h2>
          </div>
          <button type="button" style={closeBtn} onClick={onClose} aria-label="Fechar">
            <Icon name="cross" size={16} />
          </button>
        </div>

        <div style={body}>
          {state.phase === 'loading' ? (
            <div style={centered} aria-live="polite">
              <Icon name="spinner" size={20} className="vf-pulse" style={{ color: 'var(--vf-text-muted)' }} />
              <span style={{ color: 'var(--vf-text-muted)', fontSize: 13 }}>Carregando sessões…</span>
            </div>
          ) : state.phase === 'error' ? (
            <div style={centered} role="alert">
              <Icon name="cross" size={20} style={{ color: 'var(--vf-danger)' }} />
              <span style={{ color: 'var(--vf-text)', fontSize: 13 }}>
                Não foi possível carregar as sessões.
              </span>
              {state.error ? <span style={errDetail}>{state.error}</span> : null}
            </div>
          ) : state.sessions.length === 0 ? (
            <div style={centered}>
              <Icon name="chat" size={24} style={{ color: 'var(--vf-text-faint)' }} />
              <span style={{ color: 'var(--vf-text-muted)', fontSize: 13 }}>
                Nenhuma sessão do Claude nesta pasta.
              </span>
            </div>
          ) : (
            <ul style={list}>
              {state.sessions.map((s) => {
                const turns = turnsLabel(s.turns);
                const date = formatSessionDate(s.updatedAt);
                const busy = importing === s.sessionId;
                return (
                  <li key={s.sessionId} style={rowItem} className="vf-fade-in">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={previewStyle}>{previewText(s.preview)}</span>
                      <span style={meta}>
                        {date ? <span>{date}</span> : null}
                        {date && turns ? <span aria-hidden="true">·</span> : null}
                        {turns ? <span>{turns}</span> : null}
                      </span>
                    </div>
                    <button
                      type="button"
                      style={continueBtn}
                      onClick={() => handleContinue(s.sessionId)}
                      disabled={importing !== null}
                    >
                      {busy ? (
                        <Icon name="spinner" size={14} className="vf-pulse" />
                      ) : (
                        <Icon name="chevron-right" size={14} />
                      )}
                      <span>{busy ? 'Importando…' : 'Continuar'}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {importError ? (
            <div style={importErrBox} role="alert">
              <Icon name="cross" size={14} style={{ color: 'var(--vf-danger)' }} />
              <span>{importError}</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 120,
};
const card: CSSProperties = {
  width: 'min(620px, calc(100vw - 32px))',
  maxHeight: 'calc(100vh - 48px)',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--vf-bg-raised)',
  border: '1px solid var(--vf-border)',
  borderRadius: 12,
  boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
  color: 'var(--vf-text)',
};
const head: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '16px 20px',
  borderBottom: '1px solid var(--vf-border)',
};
const closeBtn: CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--vf-border)',
  borderRadius: 6,
  color: 'var(--vf-text-muted)',
  width: 28,
  height: 28,
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
};
const body: CSSProperties = {
  padding: '14px 16px',
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};
const centered: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
  padding: '32px 12px',
  textAlign: 'center',
};
const errDetail: CSSProperties = {
  color: 'var(--vf-text-muted)',
  fontSize: 12,
  fontFamily: 'var(--vf-mono, monospace)',
  wordBreak: 'break-word',
};
const list: CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 };
const rowItem: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '11px 13px',
  border: '1px solid var(--vf-border)',
  borderRadius: 9,
  background: 'var(--vf-surface)',
};
const previewStyle: CSSProperties = {
  display: 'block',
  fontSize: 13.5,
  color: 'var(--vf-text)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const meta: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginTop: 3,
  fontSize: 12,
  color: 'var(--vf-text-muted)',
};
const continueBtn: CSSProperties = {
  flex: '0 0 auto',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '7px 12px',
  borderRadius: 7,
  border: '1px solid var(--vf-accent)',
  background: 'var(--vf-accent)',
  color: '#0b1020',
  fontSize: 12.5,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
};
const importErrBox: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '9px 11px',
  borderRadius: 8,
  fontSize: 12.5,
  border: '1px solid var(--vf-danger)',
  background: 'color-mix(in srgb, var(--vf-danger) 10%, var(--vf-surface))',
  color: 'var(--vf-text)',
};
