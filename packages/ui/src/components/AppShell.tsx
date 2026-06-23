/**
 * Three-column shell (Spec 06 §3): sidebar | main (chat list or conversation) |
 * right panel (explorer/detail). Reads everything from the store and wires the
 * IPC-backed callbacks; owns no server state of its own.
 */
import { type CSSProperties } from 'react';
import { useStore } from '../state/store.js';
import { Sidebar } from './Sidebar.js';
import { ChatList } from './ChatList.js';
import { Conversation } from './Conversation.js';
import { RightPanel } from './RightPanel.js';
import { ApiKeyOnboarding } from './ApiKeyOnboarding.js';
import { SettingsScreen } from './SettingsScreen.js';
import { Icon } from './Icon.js';

export function AppShell(): JSX.Element {
  const store = useStore();
  const activeProject = store.projects.find((p) => p.id === store.activeProjectId) ?? null;
  const activeChat = store.chats.find((c) => c.id === store.activeChatId) ?? null;
  const rootPath = activeProject?.workspace.path ?? null;

  // Spec 07 §3: gate the app on auth onboarding. Only once settings have loaded
  // (so we don't flash the modal during the initial fetch). Two cases block:
  //   - apiKey mode selected but no key is stored yet;
  //   - authMode is undefined (a fresh install that has never been onboarded).
  // In plan mode we DO NOT block — the machine's Claude login is used.
  const needsOnboarding =
    store.settings !== null &&
    ((store.settings.authMode === 'apiKey' && !store.settings.apiKeyPresent) ||
      store.settings.authMode === undefined);

  const gridStyle: CSSProperties = {
    ...grid,
    gridTemplateColumns:
      store.rightPanel === null
        ? 'minmax(220px, 260px) minmax(0, 1fr) 28px'
        : 'minmax(220px, 260px) minmax(0, 1fr) minmax(0, 380px)',
  };

  return (
    <>
    {needsOnboarding && (
      <ApiKeyOnboarding
        ipc={store.ipc}
        authMode={store.settings?.authMode}
        onSaved={() => store.refreshSettings()}
      />
    )}
    {store.settingsOpen && (
      <SettingsScreen
        ipc={store.ipc}
        settings={store.settings}
        models={store.models}
        onChanged={() => store.refreshSettings()}
        onClose={() => store.closeSettings()}
      />
    )}
    <div style={gridStyle}>
      <Sidebar
        projects={store.projects}
        runtimes={store.runtimes}
        activeProjectId={store.activeProjectId}
        onSelectProject={(id) => void store.selectProject(id)}
        onNewProject={() => void store.newProject()}
        onOpenSettings={() => store.openSettings()}
      />

      <main style={mainCol}>
        {store.projects.length === 0 ? (
          <EmptyProjects />
        ) : store.activeChatId ? (
          <Conversation
            title={activeChat?.title ?? 'Conversation'}
            conversation={store.conversation}
            models={store.models}
            runtimes={store.runtimes}
            model={store.model}
            runtimeId={store.runtimeId}
            agentMode={store.agentMode}
            showThinking={store.settings?.showThinking ?? true}
            showCost={store.settings?.showCost ?? true}
            onModelChange={store.setModel}
            onRuntimeChange={store.setRuntimeId}
            onAgentModeChange={store.setAgentMode}
            onSend={(text) => void store.sendMessage(text)}
            onInterrupt={() => void store.interrupt()}
            onOpenDetail={store.setDetail}
            onResolvePermission={({ decision, reason, remember }) =>
              void store.resolvePermission(decision, {
                ...(reason ? { reason } : {}),
                ...(remember ? { remember } : {}),
              })
            }
          />
        ) : (
          <ChatList
            projectName={activeProject?.name ?? null}
            chats={store.chats}
            onSelectChat={(id) => void store.selectChat(id)}
            onNewChat={() => void store.newChat()}
          />
        )}
      </main>

      <RightPanel
        ipc={store.ipc}
        runtimeId={store.runtimeId}
        rootPath={rootPath}
        activeProjectId={store.activeProjectId}
        mode={store.rightPanel}
        detail={store.detail}
        onModeChange={store.setRightPanel}
      />
    </div>
    </>
  );
}

function EmptyProjects(): JSX.Element {
  return (
    <div style={empty}>
      <Icon name="folder" size={32} style={{ color: 'var(--vf-text-faint)' }} />
      <h2 style={{ margin: 0 }}>No projects yet</h2>
      <p style={{ color: 'var(--vf-text-muted)', margin: 0 }}>Create a project to start a chat.</p>
    </div>
  );
}

const grid: CSSProperties = {
  display: 'grid',
  height: '100%',
};
const mainCol: CSSProperties = { minWidth: 0, height: '100%', background: 'var(--vf-bg)' };
const empty: CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
};
