/**
 * Left sidebar (Spec 06 §3): projects grouped by runtime with local/VPS badges
 * and status, a "new project" action, and Settings access.
 */
import type { CSSProperties } from 'react';
import type { Project, RemoteRuntime, RemoteRuntimeStatus } from '@vingsforge/shared';
import { Icon } from './Icon.js';

const STATUS_COLOR: Record<RemoteRuntimeStatus, string> = {
  online: 'var(--vf-ok)',
  connecting: 'var(--vf-warn)',
  installing: 'var(--vf-warn)',
  offline: 'var(--vf-text-faint)',
  error: 'var(--vf-danger)',
};

export interface SidebarProps {
  projects: Project[];
  runtimes: RemoteRuntime[];
  activeProjectId: string | null;
  onSelectProject(id: string): void;
  onNewProject(): void;
  onOpenSettings(): void;
}

export function Sidebar({
  projects,
  runtimes,
  activeProjectId,
  onSelectProject,
  onNewProject,
  onOpenSettings,
}: SidebarProps): JSX.Element {
  const groups = groupByRuntime(projects, runtimes);

  return (
    <aside style={shell}>
      <header style={head}>
        <span style={brand}>VingsForge</span>
        <button style={iconBtn} onClick={onNewProject} title="New project" aria-label="New project">
          <Icon name="plus" />
        </button>
      </header>

      <div style={scroll}>
        {groups.map((g) => (
          <section key={g.id} style={{ marginBottom: 12 }}>
            <div style={groupHead}>
              <Icon name={g.kind === 'local' ? 'local' : 'cloud'} size={13} />
              <span>{g.label}</span>
              {g.status ? (
                <span style={{ ...statusDot, background: STATUS_COLOR[g.status] }} title={g.status} />
              ) : null}
            </div>
            {g.projects.length === 0 ? (
              <p style={emptyHint}>No projects</p>
            ) : (
              g.projects.map((p) => {
                const active = p.id === activeProjectId;
                return (
                  <button
                    key={p.id}
                    onClick={() => onSelectProject(p.id)}
                    style={{ ...projectRow, ...(active ? projectRowActive : null) }}
                  >
                    <Icon name="folder" size={15} style={{ color: active ? 'var(--vf-accent)' : 'var(--vf-text-muted)' }} />
                    <span style={projectName}>{p.name}</span>
                    <span style={badge}>{g.kind === 'local' ? 'local' : 'vps'}</span>
                  </button>
                );
              })
            )}
          </section>
        ))}
      </div>

      <footer style={foot}>
        <button style={settingsBtn} onClick={onOpenSettings}>
          <Icon name="settings" size={15} />
          <span>Settings</span>
        </button>
      </footer>
    </aside>
  );
}

interface RuntimeGroup {
  id: string;
  label: string;
  kind: 'local' | 'remote';
  status?: RemoteRuntimeStatus;
  projects: Project[];
}

function groupByRuntime(projects: Project[], runtimes: RemoteRuntime[]): RuntimeGroup[] {
  const groups: RuntimeGroup[] = [
    { id: 'local', label: 'Local', kind: 'local', projects: [] },
    ...runtimes.map<RuntimeGroup>((r) => ({
      id: r.id,
      label: r.label,
      kind: 'remote',
      status: r.status,
      projects: [],
    })),
  ];
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const p of projects) (byId.get(p.runtimeId) ?? groups[0]!).projects.push(p);
  return groups;
}

const shell: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  background: 'var(--vf-bg-raised)',
  borderRight: '1px solid var(--vf-border)',
};
const head: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '12px 14px',
  borderBottom: '1px solid var(--vf-border)',
};
const brand: CSSProperties = { fontWeight: 600, letterSpacing: 0.2 };
const iconBtn: CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--vf-border)',
  borderRadius: 6,
  color: 'var(--vf-text-muted)',
  width: 28,
  height: 28,
  display: 'grid',
  placeItems: 'center',
};
const scroll: CSSProperties = { flex: 1, overflowY: 'auto', padding: '10px 8px' };
const groupHead: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 8px',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  color: 'var(--vf-text-faint)',
};
const statusDot: CSSProperties = { width: 7, height: 7, borderRadius: '50%', marginLeft: 'auto' };
const emptyHint: CSSProperties = { margin: '2px 10px', fontSize: 12, color: 'var(--vf-text-faint)' };
const projectRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '7px 8px',
  border: 'none',
  borderRadius: 7,
  background: 'transparent',
  color: 'var(--vf-text)',
  textAlign: 'left',
};
const projectRowActive: CSSProperties = { background: 'var(--vf-accent-weak)' };
const projectName: CSSProperties = { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const badge: CSSProperties = {
  fontSize: 10,
  color: 'var(--vf-text-faint)',
  border: '1px solid var(--vf-border)',
  borderRadius: 4,
  padding: '0 5px',
};
const foot: CSSProperties = { borderTop: '1px solid var(--vf-border)', padding: 8 };
const settingsBtn: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '8px 10px',
  background: 'transparent',
  border: 'none',
  borderRadius: 7,
  color: 'var(--vf-text-muted)',
};
