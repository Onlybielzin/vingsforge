/**
 * App store + React context (Spec 06 §6 "persistir último projeto/chat"). Owns
 * selection of project/chat/runtime/model, loads data via the injected
 * IpcClient and folds the engine stream into the active conversation.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  AgentMode,
  ChatSummary,
  GlobalSettings,
  ModelId,
  ModelInfo,
  Project,
  RemoteRuntime,
} from '@vingsforge/shared';
import { agentModeToModes } from '@vingsforge/shared';
import type { IpcClient } from '../ipc/client.js';
import type { DetailContent } from '../components/RightPanel.js';
import {
  appendUserMessage,
  emptyConversation,
  hydrateHistory,
  reduceEvent,
  type ConversationState,
} from './conversation.js';

export interface AppStore {
  ipc: IpcClient;
  projects: Project[];
  runtimes: RemoteRuntime[];
  models: ModelInfo[];
  settings: GlobalSettings | null;
  activeProjectId: string | null;
  activeChatId: string | null;
  chats: ChatSummary[];
  conversation: ConversationState;
  /** Effective model for the input bar; may be overridden per chat. */
  model: ModelId;
  runtimeId: string;
  agentMode: AgentMode;
  rightPanel: 'explorer' | 'detail' | 'worktrees' | null;
  /** Content shown in the right panel's Detail tab (Spec 06 §3); null disables it. */
  detail: DetailContent | null;
  /** Whether the settings modal is open (Spec 07 §3). */
  settingsOpen: boolean;

  /** Re-reads global settings (e.g. after the API key is saved). */
  refreshSettings(): Promise<void>;
  selectProject(id: string): Promise<void>;
  selectChat(id: string): Promise<void>;
  newProject(): Promise<void>;
  newChat(): Promise<void>;
  sendMessage(text: string): Promise<void>;
  interrupt(): Promise<void>;
  resolvePermission(decision: 'allow' | 'deny', opts?: { reason?: string; remember?: boolean }): Promise<void>;
  setModel(model: ModelId): void;
  setRuntimeId(id: string): void;
  setAgentMode(m: AgentMode): void;
  setRightPanel(p: 'explorer' | 'detail' | 'worktrees' | null): void;
  /** Opens a tool's detail in the right panel and switches to the Detail tab. */
  setDetail(d: DetailContent | null): void;
  openSettings(): void;
  closeSettings(): void;
}

const StoreContext = createContext<AppStore | null>(null);

const LAST_PROJECT_KEY = 'vingsforge.lastProject';
const LAST_CHAT_KEY = 'vingsforge.lastChat';

export function StoreProvider({ ipc, children }: { ipc: IpcClient; children: ReactNode }): JSX.Element {
  const [projects, setProjects] = useState<Project[]>([]);
  const [runtimes, setRuntimes] = useState<RemoteRuntime[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [settings, setSettings] = useState<GlobalSettings | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [conversation, setConversation] = useState<ConversationState>(emptyConversation());
  const [model, setModel] = useState<ModelId>('claude-opus-4-8');
  const [runtimeId, setRuntimeId] = useState<string>('local');
  const [agentMode, setAgentMode] = useState<AgentMode>('default');
  const [rightPanel, setRightPanel] = useState<'explorer' | 'detail' | 'worktrees' | null>('explorer');
  const [detail, setDetail] = useState<DetailContent | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const activeChatRef = useRef<string | null>(null);
  activeChatRef.current = activeChatId;

  // Subscribe to the engine stream once; route events to the active conversation.
  useEffect(() => {
    return ipc.engine.onEvent((event) => {
      if ('chatId' in event && event.chatId !== activeChatRef.current) return;
      setConversation((prev) => reduceEvent(prev, event));
    });
  }, [ipc]);

  // Initial load.
  useEffect(() => {
    void (async () => {
      const [p, r, s, m] = await Promise.all([
        ipc.projects.list(),
        ipc.runtimes.list(),
        ipc.settings.get(),
        ipc.settings.models(),
      ]);
      setProjects(p);
      setRuntimes(r);
      setSettings(s);
      setModels(m);
      setModel(s.defaultModel);
      const last = localStorage.getItem(LAST_PROJECT_KEY);
      const target = p.find((x) => x.id === last) ?? p[0];
      if (target) await doSelectProject(target.id, p);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ipc]);

  const refreshSettings = useCallback(async () => {
    const s = await ipc.settings.get();
    setSettings(s);
  }, [ipc]);

  const doSelectProject = useCallback(
    async (id: string, known?: Project[]) => {
      const { project, chats: list } = await ipc.projects.open(id);
      const all = known ?? projects;
      const proj = all.find((p) => p.id === id) ?? project;
      setActiveProjectId(id);
      setChats(list);
      setRuntimeId(proj.runtimeId);
      if (proj.defaultModel) setModel(proj.defaultModel);
      localStorage.setItem(LAST_PROJECT_KEY, id);
      const lastChat = localStorage.getItem(`${LAST_CHAT_KEY}.${id}`);
      const targetChat = list.find((c) => c.id === lastChat) ?? null;
      if (targetChat) await doSelectChat(targetChat.id);
      else {
        setActiveChatId(null);
        setConversation(emptyConversation());
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ipc, projects],
  );

  const doSelectChat = useCallback(
    async (id: string) => {
      const history = await ipc.chats.history(id);
      activeChatRef.current = id;
      setActiveChatId(id);
      setConversation(hydrateHistory(id, history));
      if (activeProjectId) localStorage.setItem(`${LAST_CHAT_KEY}.${activeProjectId}`, id);
    },
    [ipc, activeProjectId],
  );

  const newProject = useCallback(async () => {
    // "+" = escolher a pasta do projeto. Usa o seletor de pasta nativo do Tauri;
    // no preview do navegador (sem Tauri), cai para um prompt de caminho.
    let dir: string | null = null;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ directory: true, multiple: false, title: 'Escolher pasta do projeto' });
      if (picked === null) return; // cancelou
      dir = Array.isArray(picked) ? (picked[0] ?? null) : picked;
    } catch {
      try {
        const entered = window.prompt('Caminho da pasta do projeto');
        if (!entered) return;
        dir = entered.trim();
      } catch {
        return;
      }
    }
    if (!dir) return;
    const name = dir.split('/').filter(Boolean).pop() ?? 'projeto';
    const project = await ipc.projects.create({ name, workspace: { kind: 'local', path: dir }, runtimeId: 'local' });
    const list = await ipc.projects.list();
    setProjects(list);
    await doSelectProject(project.id, list);
  }, [ipc, doSelectProject]);

  const newChat = useCallback(async () => {
    if (!activeProjectId) return;
    const chat = await ipc.chats.create(activeProjectId, { model, runtimeId });
    const list = await ipc.chats.list(activeProjectId);
    setChats(list);
    await doSelectChat(chat.id);
  }, [ipc, activeProjectId, model, runtimeId, doSelectChat]);

  const sendMessage = useCallback(
    async (text: string) => {
      const chatId = activeChatId;
      if (!chatId || !text.trim()) return;
      setConversation((prev) => appendUserMessage(prev, text));
      // Ship the per-turn modes derived from the chosen agent mode so the engine
      // actually gates tool calls (plan = read-only; accept-edits auto-approves
      // edits but asks for bash; bypass flips ask→allow). Not just CSS.
      await ipc.chats.send(chatId, text, agentModeToModes(agentMode));
    },
    [ipc, activeChatId, agentMode],
  );

  const interrupt = useCallback(async () => {
    if (activeChatId) await ipc.chats.interrupt(activeChatId);
  }, [ipc, activeChatId]);

  const resolvePermission = useCallback(
    async (decision: 'allow' | 'deny', opts?: { reason?: string; remember?: boolean }) => {
      const pending = conversation.pendingPermission;
      const chatId = activeChatId;
      if (!pending || !chatId) return;
      await ipc.engine.send({
        type: 'tool.permission.resolve',
        chatId,
        callId: pending.callId,
        decision,
        ...(opts?.reason ? { reason: opts.reason } : {}),
        ...(opts?.remember ? { remember: opts.remember } : {}),
      });
    },
    [ipc, activeChatId, conversation.pendingPermission],
  );

  const openDetail = useCallback((d: DetailContent | null) => {
    setDetail(d);
    if (d) setRightPanel('detail');
  }, []);

  const openSettings = useCallback(() => setSettingsOpen(true), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const store: AppStore = useMemo(
    () => ({
      ipc,
      projects,
      runtimes,
      models,
      settings,
      activeProjectId,
      activeChatId,
      chats,
      conversation,
      model,
      runtimeId,
      agentMode,
      rightPanel,
      detail,
      settingsOpen,
      refreshSettings,
      selectProject: (id) => doSelectProject(id),
      selectChat: doSelectChat,
      newProject,
      newChat,
      sendMessage,
      interrupt,
      resolvePermission,
      setModel,
      setRuntimeId,
      setAgentMode,
      setRightPanel,
      setDetail: openDetail,
      openSettings,
      closeSettings,
    }),
    [
      ipc,
      projects,
      runtimes,
      models,
      settings,
      activeProjectId,
      activeChatId,
      chats,
      conversation,
      model,
      runtimeId,
      agentMode,
      rightPanel,
      detail,
      settingsOpen,
      refreshSettings,
      openDetail,
      openSettings,
      closeSettings,
      doSelectProject,
      doSelectChat,
      newProject,
      newChat,
      sendMessage,
      interrupt,
      resolvePermission,
    ],
  );

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): AppStore {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within <StoreProvider>');
  return ctx;
}
