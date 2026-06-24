/**
 * Right panel (Spec 06 §3): toggles between the workspace file explorer and a
 * tool/diff detail view. Collapsible. Explorer entries come from the runtimes
 * fsList IPC; the detail view reuses DiffView.
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { DirEntry, Worktree } from '@vingsforge/shared';
import type { IpcClient } from '../ipc/client.js';
import type { ConversationState } from '../state/conversation.js';
import { Icon, type IconName } from './Icon.js';
import { DiffView } from './DiffView.js';
import { AgentsPanel } from './AgentsPanel.js';
import { countRunning, extractSubagents } from './agentsPanel.js';

export interface DetailContent {
  title: string;
  original: string;
  modified: string;
}

export type RightPanelMode = 'explorer' | 'detail' | 'worktrees' | 'agents' | null;

export interface RightPanelProps {
  ipc: IpcClient;
  runtimeId: string;
  rootPath: string | null;
  activeProjectId: string | null;
  mode: RightPanelMode;
  detail: DetailContent | null;
  /** Live conversation, used to derive the subagents shown in the Agentes tab. */
  conversation: ConversationState;
  /** Active model name, shown in finished agents' stats line. */
  model?: string;
  onModeChange(mode: RightPanelMode): void;
}

export function RightPanel({
  ipc,
  runtimeId,
  rootPath,
  activeProjectId,
  mode,
  detail,
  conversation,
  model,
  onModeChange,
}: RightPanelProps): JSX.Element | null {
  const agents = useMemo(() => extractSubagents(conversation), [conversation]);
  const runningAgents = countRunning(agents);
  // Badge prefers the running count (an at-a-glance "how many are working"),
  // falling back to the total when none are running but some exist.
  const agentsBadge = runningAgents > 0 ? runningAgents : agents.length;

  if (mode === null) {
    return (
      <button style={collapsedHandle} onClick={() => onModeChange('explorer')} title="Show panel" aria-label="Show panel">
        <Icon name="chevron-right" size={16} />
      </button>
    );
  }

  return (
    <aside style={shell}>
      <header style={head}>
        <Tab active={mode === 'explorer'} icon="folder" label="Explorer" onClick={() => onModeChange('explorer')} />
        <Tab active={mode === 'worktrees'} icon="folder" label="Worktrees" onClick={() => onModeChange('worktrees')} />
        <Tab
          active={mode === 'agents'}
          icon="chat"
          label="Agentes"
          onClick={() => onModeChange('agents')}
          {...(agentsBadge > 0 ? { badge: agentsBadge } : {})}
        />
        <Tab active={mode === 'detail'} icon="file" label="Detail" onClick={() => onModeChange('detail')} disabled={!detail} />
        <button style={collapseBtn} onClick={() => onModeChange(null)} title="Collapse" aria-label="Collapse panel">
          <Icon name="cross" size={14} />
        </button>
      </header>

      <div style={panelBody}>
        {mode === 'explorer' ? (
          <Explorer ipc={ipc} runtimeId={runtimeId} rootPath={rootPath} />
        ) : mode === 'worktrees' ? (
          <WorktreesPanel ipc={ipc} activeProjectId={activeProjectId} />
        ) : mode === 'agents' ? (
          <AgentsPanel agents={agents} {...(model ? { model } : {})} />
        ) : detail ? (
          <div>
            <p style={detailTitle}>{detail.title}</p>
            <DiffView original={detail.original} modified={detail.modified} height={'calc(100vh - 160px)'} />
          </div>
        ) : (
          <p style={hint}>Select a tool card to inspect it here.</p>
        )}
      </div>
    </aside>
  );
}

function Explorer({ ipc, runtimeId, rootPath }: { ipc: IpcClient; runtimeId: string; rootPath: string | null }): JSX.Element {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!rootPath) {
      setEntries([]);
      return;
    }
    let alive = true;
    void ipc.runtimes
      .fsList(runtimeId, rootPath)
      .then((list) => {
        if (alive) {
          setEntries(list);
          setError(null);
        }
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [ipc, runtimeId, rootPath]);

  if (!rootPath) return <p style={hint}>No workspace open.</p>;
  if (error) return <p style={{ ...hint, color: 'var(--vf-danger)' }}>{error}</p>;

  return (
    <ul style={fileList}>
      {entries.map((e) => (
        <li key={e.path} style={fileRow}>
          <Icon name={e.kind === 'dir' ? 'folder' : 'file'} size={14} style={{ color: 'var(--vf-text-muted)' }} />
          <span style={{ flex: 1 }}>{e.name}</span>
          {e.size != null ? <span style={sizeTag}>{e.size}b</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** Short 7-char form of a commit SHA for compact display. */
function shortHead(head: string): string {
  return head.slice(0, 7);
}

/** Last path segment (folder name) of an absolute worktree path. */
function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.at(-1) ?? p;
}

function WorktreesPanel({
  ipc,
  activeProjectId,
}: {
  ipc: IpcClient;
  activeProjectId: string | null;
}): JSX.Element {
  const [worktrees, setWorktrees] = useState<Worktree[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    (signal?: { alive: boolean }) => {
      if (!activeProjectId) {
        setWorktrees(null);
        setError(null);
        return;
      }
      setLoading(true);
      void ipc.projects
        .worktrees(activeProjectId)
        .then((list) => {
          if (signal && !signal.alive) return;
          setWorktrees(list);
          setError(null);
        })
        .catch((e: unknown) => {
          if (signal && !signal.alive) return;
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (signal && !signal.alive) return;
          setLoading(false);
        });
    },
    [ipc, activeProjectId],
  );

  useEffect(() => {
    const signal = { alive: true };
    load(signal);
    return () => {
      signal.alive = false;
    };
  }, [load]);

  if (!activeProjectId) return <p style={hint}>Nenhum projeto ativo.</p>;

  return (
    <div>
      <div style={wtToolbar}>
        <button style={refreshBtn} onClick={() => load()} disabled={loading} title="Atualizar" aria-label="Atualizar">
          <Icon name="chevron-down" size={14} />
          Atualizar
        </button>
      </div>

      {error ? (
        <p style={{ ...hint, color: 'var(--vf-danger)' }}>
          {/git/i.test(error) ? 'Projeto não é um repositório git' : error}
        </p>
      ) : worktrees === null ? (
        <p style={hint}>Carregando…</p>
      ) : worktrees.length === 0 ? (
        <p style={hint}>Sem worktrees</p>
      ) : (
        <ul style={fileList}>
          {worktrees.map((wt) => (
            <li key={wt.path} style={wtRow}>
              <div style={wtRowMain}>
                <Icon name="folder" size={14} style={{ color: 'var(--vf-text-muted)' }} />
                <span style={wtName} title={wt.path}>
                  {basename(wt.path)}
                </span>
                {wt.isMain ? <span style={wtBadge}>principal</span> : null}
                {wt.isLocked ? (
                  <span style={wtBadge}>
                    <Icon name="lock" size={11} style={{ marginRight: 3 }} />
                    bloqueado
                  </span>
                ) : null}
              </div>
              <div style={wtMeta}>
                <span style={wtBranch}>{wt.isDetached || !wt.branch ? 'detached' : wt.branch}</span>
                <span style={wtSha}>{shortHead(wt.head)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Tab({
  active,
  icon,
  label,
  onClick,
  disabled,
  badge,
}: {
  active: boolean;
  icon: IconName;
  label: string;
  onClick(): void;
  disabled?: boolean;
  /** Optional count shown as a pill on the tab (e.g. subagents running). */
  badge?: number;
}): JSX.Element {
  return (
    <button onClick={onClick} disabled={disabled} style={{ ...tab, ...(active ? tabActive : null) }}>
      <Icon name={icon} size={14} />
      {label}
      {badge != null && badge > 0 ? <span style={tabBadge}>{badge}</span> : null}
    </button>
  );
}

const shell: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  background: 'var(--vf-bg-raised)',
  borderLeft: '1px solid var(--vf-border)',
};
const head: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  padding: '8px 10px',
  borderBottom: '1px solid var(--vf-border)',
};
const tab: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 10px',
  borderRadius: 7,
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--vf-text-muted)',
  fontSize: 12.5,
};
const tabActive: CSSProperties = { background: 'var(--vf-surface)', color: 'var(--vf-text)', borderColor: 'var(--vf-border)' };
const tabBadge: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  minWidth: 16,
  height: 16,
  padding: '0 4px',
  borderRadius: 999,
  fontSize: 10,
  fontWeight: 700,
  lineHeight: 1,
  background: 'var(--vf-accent-weak)',
  border: '1px solid color-mix(in srgb, var(--vf-accent) 35%, transparent)',
  color: 'var(--vf-accent)',
};
const collapseBtn: CSSProperties = {
  marginLeft: 'auto',
  background: 'transparent',
  border: 'none',
  color: 'var(--vf-text-muted)',
  display: 'grid',
  placeItems: 'center',
};
const collapsedHandle: CSSProperties = {
  width: 28,
  height: '100%',
  background: 'var(--vf-bg-raised)',
  borderLeft: '1px solid var(--vf-border)',
  color: 'var(--vf-text-muted)',
  border: 'none',
  display: 'grid',
  placeItems: 'center',
};
const panelBody: CSSProperties = { flex: 1, overflow: 'auto', padding: 12 };
const fileList: CSSProperties = { listStyle: 'none', margin: 0, padding: 0 };
const fileRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '5px 8px',
  borderRadius: 6,
  fontSize: 13,
};
const sizeTag: CSSProperties = { color: 'var(--vf-text-faint)', fontSize: 11, fontFamily: 'var(--vf-mono)' };
const hint: CSSProperties = { color: 'var(--vf-text-muted)', fontSize: 13 };
const detailTitle: CSSProperties = { margin: '0 0 8px', fontFamily: 'var(--vf-mono)', fontSize: 12, color: 'var(--vf-text-muted)' };
const wtToolbar: CSSProperties = { display: 'flex', justifyContent: 'flex-end', marginBottom: 8 };
const refreshBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  padding: '4px 9px',
  borderRadius: 7,
  border: '1px solid var(--vf-border)',
  background: 'var(--vf-surface)',
  color: 'var(--vf-text-muted)',
  fontSize: 12,
};
const wtRow: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '8px 8px',
  borderRadius: 6,
  borderBottom: '1px solid var(--vf-border)',
};
const wtRowMain: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 };
const wtName: CSSProperties = {
  flex: 1,
  fontSize: 13,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const wtBadge: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  fontSize: 10.5,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  padding: '1px 6px',
  borderRadius: 999,
  background: 'var(--vf-surface)',
  border: '1px solid var(--vf-border)',
  color: 'var(--vf-text-muted)',
};
const wtMeta: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 22 };
const wtBranch: CSSProperties = { fontSize: 12, color: 'var(--vf-text-muted)' };
const wtSha: CSSProperties = { fontSize: 11, fontFamily: 'var(--vf-mono)', color: 'var(--vf-text-faint)' };
