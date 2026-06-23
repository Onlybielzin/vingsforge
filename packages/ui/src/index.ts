/**
 * @vingsforge/ui public surface (Spec 06). Exports the app shell, the store,
 * the IPC client port + mock, theme helpers and every conversation component so
 * the desktop app (or tests) can compose or swap pieces.
 */
export { App } from './App.js';
export { AppShell } from './components/AppShell.js';

// State
export { StoreProvider, useStore, type AppStore } from './state/store.js';
export {
  emptyConversation,
  hydrateHistory,
  reduceEvent,
  appendUserMessage,
  type ConversationState,
  type Turn,
  type TurnItem,
  type ToolCard as ToolCardModel,
  type ToolState,
  type PendingPermission,
} from './state/conversation.js';

// IPC
export type { IpcClient, EngineChannel, Unsubscribe } from './ipc/client.js';
export { createMockIpcClient } from './ipc/mock.js';
export {
  createRealIpcClient,
  type RealIpcClient,
  type RealIpcOptions,
} from './ipc/real.js';
export {
  connectIpc,
  type IpcBootstrap,
  type IpcMode,
  type ConnectIpcOptions,
} from './ipc/bootstrap.js';

// Theme
export { applyTheme, THEMES, type ThemeName } from './theme/tokens.js';

// Components
export { Sidebar, type SidebarProps } from './components/Sidebar.js';
export { ChatList, type ChatListProps } from './components/ChatList.js';
export { Conversation, type ConversationProps } from './components/Conversation.js';
export { MessageBubble, type MessageBubbleProps } from './components/MessageBubble.js';
export { ReasoningPanel } from './components/ReasoningPanel.js';
export { ToolCard } from './components/ToolCard.js';
export { BashTerminal, type BashTerminalProps } from './components/BashTerminal.js';
export { DiffView, type DiffViewProps } from './components/DiffView.js';
export {
  PermissionCard,
  type PermissionCardProps,
  type PermissionDecision,
} from './components/PermissionCard.js';
export { InputBar, type InputBarProps } from './components/InputBar.js';
export { TokenFooter, type TokenFooterProps } from './components/TokenFooter.js';
export { RightPanel, type RightPanelProps, type DetailContent } from './components/RightPanel.js';
export { Markdown, CodeBlock } from './components/Markdown.js';
export { Icon, type IconName, type IconProps } from './components/Icon.js';
export { ApiKeyOnboarding, type ApiKeyOnboardingProps } from './components/ApiKeyOnboarding.js';
export { DemoModeBanner } from './components/DemoModeBanner.js';
