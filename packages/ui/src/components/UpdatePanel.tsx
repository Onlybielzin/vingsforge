/**
 * In-app auto-update UI (Objetivo 2). Two pieces:
 *
 *  - {@link UpdateBanner} — a discreet top strip shown when the boot probe found
 *    the checkout is behind upstream; its button opens the modal.
 *  - {@link UpdateModal} — runs `update.run()` and streams the build/install logs
 *    (update.log / update.done events) into a monospaced area with a live phase
 *    indicator. On success it tells the user the new .deb was installed and they
 *    may reopen the app.
 *
 * All event folding is delegated to the pure {@link reduceUpdate} reducer so this
 * component stays presentational. No emoji — status uses the icon set.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { UpdateStatus } from '@vingsforge/shared';
import type { IpcClient } from '../ipc/client.js';
import { Icon } from './Icon.js';
import {
  idleUpdate,
  reduceUpdate,
  startUpdate,
  updateBannerText,
  type UpdateRunState,
} from './updateState.js';

export interface UpdateBannerProps {
  status: UpdateStatus;
  onOpen(): void;
}

/** Discreet "an update is available" strip with an Atualizar action. */
export function UpdateBanner({ status, onOpen }: UpdateBannerProps): JSX.Element {
  return (
    <div style={banner} role="status">
      <Icon name="cloud" size={15} style={{ color: 'var(--vf-accent)' }} />
      <span style={bannerText}>
        {updateBannerText(status.behind)} — {status.current} → {status.latest}
      </span>
      <button type="button" style={bannerBtn} onClick={onOpen}>
        Atualizar
      </button>
    </div>
  );
}

export interface UpdateModalProps {
  ipc: IpcClient;
  status: UpdateStatus | null;
  onClose(): void;
}

/** Runs the updater and streams its logs (Objetivo 2). */
export function UpdateModal({ ipc, status, onClose }: UpdateModalProps): JSX.Element {
  const [run, setRun] = useState<UpdateRunState>(idleUpdate);
  const logRef = useRef<HTMLPreElement>(null);

  // Fold update.* events from the shared engine channel into the run state.
  useEffect(() => {
    return ipc.engine.onEvent((event) => {
      if (event.type === 'update.log' || event.type === 'update.done') {
        setRun((prev) => reduceUpdate(prev, event));
      }
    });
  }, [ipc]);

  // Keep the log scrolled to the newest line.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run.lines]);

  const start = (): void => {
    if (run.phase === 'running') return;
    setRun(startUpdate());
    void ipc.update.run().catch((err) => {
      setRun((prev) =>
        reduceUpdate(prev, {
          type: 'update.done',
          ok: false,
          message: err instanceof Error ? err.message : 'Falha ao iniciar a atualização.',
        }),
      );
    });
  };

  const phaseLabel = useMemo(() => PHASE_LABEL[run.phase], [run.phase]);

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label="Atualizar VingsForge">
      <div style={card}>
        <div style={head}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="cloud" size={18} style={{ color: 'var(--vf-accent)' }} />
            <h2 style={{ margin: 0, fontSize: 16 }}>Atualização</h2>
          </div>
          <button type="button" style={closeBtn} onClick={onClose} aria-label="Fechar">
            <Icon name="cross" size={16} />
          </button>
        </div>

        <div style={body}>
          {status ? (
            <p style={summary}>
              {updateBannerText(status.behind)} em <code style={code}>{status.repoDir}</code>
              <br />
              {status.current} → {status.latest}
            </p>
          ) : (
            <p style={summary}>Nenhum status de atualização disponível.</p>
          )}

          <div style={statusRow} aria-live="polite">
            <PhaseDot phase={run.phase} />
            <span style={{ fontSize: 13 }}>{phaseLabel}</span>
          </div>

          <pre ref={logRef} style={logArea} aria-label="Log da atualização">
            {run.lines.length === 0
              ? 'Os logs do build aparecem aqui.'
              : run.lines.map((l, i) => (
                  <span key={i} style={l.stream === 'stderr' ? logErr : undefined}>
                    {l.line}
                    {'\n'}
                  </span>
                ))}
          </pre>

          {run.message ? (
            <div
              style={{
                ...note,
                ...(run.phase === 'error' ? noteErr : noteOk),
              }}
            >
              <Icon name={run.phase === 'error' ? 'cross' : 'check'} size={14} />
              <span>{run.message}</span>
            </div>
          ) : null}
        </div>

        <div style={footer}>
          <button type="button" style={secondaryBtn} onClick={onClose}>
            Fechar
          </button>
          <button
            type="button"
            style={primaryBtn}
            onClick={start}
            disabled={run.phase === 'running'}
          >
            {run.phase === 'running'
              ? 'Atualizando…'
              : run.phase === 'done' || run.phase === 'error'
                ? 'Tentar de novo'
                : 'Iniciar atualização'}
          </button>
        </div>
      </div>
    </div>
  );
}

const PHASE_LABEL: Record<UpdateRunState['phase'], string> = {
  idle: 'Pronto para atualizar.',
  running: 'Atualizando (build + instalação)…',
  done: 'Concluído.',
  error: 'Erro na atualização.',
};

function PhaseDot({ phase }: { phase: UpdateRunState['phase'] }): JSX.Element {
  const color =
    phase === 'done'
      ? 'var(--vf-accent)'
      : phase === 'error'
        ? 'var(--vf-danger)'
        : phase === 'running'
          ? 'var(--vf-accent)'
          : 'var(--vf-text-faint)';
  return (
    <span
      style={{
        width: 9,
        height: 9,
        borderRadius: '50%',
        background: color,
        flex: '0 0 auto',
      }}
    />
  );
}

const banner: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '7px 14px',
  background: 'var(--vf-accent-weak)',
  borderBottom: '1px solid var(--vf-border)',
  color: 'var(--vf-text)',
  fontSize: 12.5,
};
const bannerText: CSSProperties = { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const bannerBtn: CSSProperties = {
  flex: '0 0 auto',
  background: 'var(--vf-accent)',
  color: '#0b1020',
  border: '1px solid var(--vf-accent)',
  borderRadius: 7,
  padding: '4px 12px',
  fontSize: 12.5,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
};
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
  width: 'min(640px, calc(100vw - 32px))',
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
const body: CSSProperties = { padding: '16px 20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 };
const summary: CSSProperties = { margin: 0, fontSize: 13, color: 'var(--vf-text-muted)', lineHeight: 1.5 };
const code: CSSProperties = { fontFamily: 'var(--vf-mono, monospace)', fontSize: 12 };
const statusRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
const logArea: CSSProperties = {
  margin: 0,
  height: 240,
  overflowY: 'auto',
  background: 'var(--vf-bg-inset)',
  border: '1px solid var(--vf-border)',
  borderRadius: 8,
  padding: '10px 12px',
  fontFamily: 'var(--vf-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--vf-text)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};
const logErr: CSSProperties = { color: 'var(--vf-danger)' };
const note: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '9px 11px',
  borderRadius: 8,
  fontSize: 13,
};
const noteOk: CSSProperties = {
  border: '1px solid var(--vf-accent)',
  background: 'var(--vf-accent-weak)',
  color: 'var(--vf-text)',
};
const noteErr: CSSProperties = {
  border: '1px solid var(--vf-danger)',
  background: 'color-mix(in srgb, var(--vf-danger) 10%, var(--vf-surface))',
  color: 'var(--vf-text)',
};
const footer: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  padding: '14px 20px',
  borderTop: '1px solid var(--vf-border)',
};
const baseBtn: CSSProperties = {
  borderRadius: 8,
  padding: '8px 14px',
  fontSize: 13,
  fontFamily: 'inherit',
  cursor: 'pointer',
  border: '1px solid var(--vf-border)',
};
const secondaryBtn: CSSProperties = { ...baseBtn, background: 'var(--vf-surface)', color: 'var(--vf-text)' };
const primaryBtn: CSSProperties = {
  ...baseBtn,
  background: 'var(--vf-accent)',
  color: '#0b1020',
  border: '1px solid var(--vf-accent)',
  fontWeight: 600,
};
