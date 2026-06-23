/**
 * Left sidebar (Spec 06 §3): projects grouped by runtime with local/VPS badges
 * and status, a "new project" action, and Settings access.
 *
 * Projects are expandable (chevron-right collapsed / chevron-down expanded):
 * expanding reveals that project's chats nested below it (lazy-loaded into the
 * store's chatsByProject cache). Clicking the project NAME selects it (main
 * panel shows its ChatList); clicking the chevron only toggles the sub-tree.
 * Clicking a nested chat opens it. Each chat row carries a status dot
 * (green pulsing for the active+streaming chat, neutral otherwise).
 */
import type { CSSProperties } from 'react';
import type { ChatSummary, Project, RemoteRuntime, RemoteRuntimeStatus } from '@vingsforge/shared';
import { Icon } from './Icon.js';
import { ChatStatusDot } from './ChatStatusDot.js';
import { chatStatus } from './chatStatus.js';

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
  /** Currently open chat, for highlighting + status in the tree. */
  activeChatId: string | null;
  /** Whether the active conversation is streaming a turn (drives the dot). */
  streaming: boolean;
  /** Per-project chat lists for the expandable tree (store.chatsByProject). */
  chatsByProject: Record<string, ChatSummary[]>;
  /** Ids of projects whose chat sub-tree is expanded. */
  expandedProjects: string[];
  onSelectProject(id: string): void;
  /** Toggle a project's expanded state (lazily loads its chats). */
  onToggleProjectExpanded(id: string): void;
  /** Open a nested chat (selecting its project first if needed). */
  onSelectChat(id: string): void;
  onNewProject(): void;
  onOpenSettings(): void;
}

export function Sidebar({
  projects,
  runtimes,
  activeProjectId,
  activeChatId,
  streaming,
  chatsByProject,
  expandedProjects,
  onSelectProject,
  onToggleProjectExpanded,
  onSelectChat,
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
                const expanded = expandedProjects.includes(p.id);
                const chats = (chatsByProject[p.id] ?? []).filter((c) => !c.archived);
                return (
                  <div key={p.id}>
                    <div style={{ ...projectRow, ...(active ? projectRowActive : null) }}>
                      <button
                        type="button"
                        onClick={() => onToggleProjectExpanded(p.id)}
                        style={chevronBtn}
                        title={expanded ? 'Collapse' : 'Expand'}
                        aria-label={expanded ? 'Collapse project' : 'Expand project'}
                        aria-expanded={expanded}
                      >
                        <Icon
                          name={expanded ? 'chevron-down' : 'chevron-right'}
                          size={14}
                          style={{ color: 'var(--vf-text-faint)' }}
                        />
                      </button>
                      <button type="button" onClick={() => onSelectProject(p.id)} style={projectNameBtn}>
                        <Icon
                          name="folder"
                          size={15}
                          style={{ color: active ? 'var(--vf-accent)' : 'var(--vf-text-muted)' }}
                        />
                        <span style={projectName}>{p.name}</span>
                      </button>
                      <span style={badge}>{g.kind === 'local' ? 'local' : 'vps'}</span>
                    </div>

                    {expanded ? (
                      chats.length === 0 ? (
                        <p style={chatEmptyHint}>No chats</p>
                      ) : (
                        <ul style={chatTree}>
                          {chats.map((c) => {
                            const chatActive = c.id === activeChatId;
                            const status = chatStatus(c.id, activeChatId, streaming);
                            return (
                              <li key={c.id}>
                                <button
                                  type="button"
                                  onClick={() => onSelectChat(c.id)}
                                  style={{ ...chatRow, ...(chatActive ? chatRowActive : null) }}
                                  title={c.title}
                                >
                                  <ChatStatusDot status={status} />
                                  <span style={chatName}>{c.title}</span>
                                  {c.lastMessagePreview ? (
                                    <span style={chatPreview}>{c.lastMessagePreview}</span>
                                  ) : null}
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      )
                    ) : null}
                  </div>
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
  gap: 4,
  width: '100%',
  padding: '4px 8px 4px 2px',
  borderRadius: 7,
  background: 'transparent',
  color: 'var(--vf-text)',
};
const projectRowActive: CSSProperties = { background: 'var(--vf-accent-weak)' };
const chevronBtn: CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 4,
  display: 'grid',
  placeItems: 'center',
  color: 'var(--vf-text-faint)',
  cursor: 'pointer',
  borderRadius: 5,
  flexShrink: 0,
};
const projectNameBtn: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flex: 1,
  minWidth: 0,
  padding: '3px 0',
  border: 'none',
  background: 'transparent',
  color: 'var(--vf-text)',
  textAlign: 'left',
  cursor: 'pointer',
};
const projectName: CSSProperties = { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const badge: CSSProperties = {
  fontSize: 10,
  color: 'var(--vf-text-faint)',
  border: '1px solid var(--vf-border)',
  borderRadius: 4,
  padding: '0 5px',
  flexShrink: 0,
};
const chatTree: CSSProperties = {
  listStyle: 'none',
  margin: '2px 0 4px',
  padding: '0 0 0 22px',
};
const chatEmptyHint: CSSProperties = {
  margin: '2px 0 4px 24px',
  fontSize: 11,
  color: 'var(--vf-text-faint)',
};
const chatRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  width: '100%',
  padding: '5px 8px',
  border: 'none',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--vf-text-muted)',
  textAlign: 'left',
  cursor: 'pointer',
};
const chatRowActive: CSSProperties = { background: 'var(--vf-accent-weak)', color: 'var(--vf-text)' };
const chatName: CSSProperties = {
  flexShrink: 0,
  maxWidth: '11ch',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 12.5,
};
const chatPreview: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: 11,
  color: 'var(--vf-text-faint)',
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
