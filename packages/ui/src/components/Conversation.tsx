/**
 * Conversation view (Spec 06 §4): scrollable turn list, blocking permission
 * card, error banner, then the input bar and token footer. Auto-scrolls on new
 * content and preserves nothing the store doesn't already own.
 */
import { useEffect, useRef, type CSSProperties } from 'react';
import type { AgentMode, ModelInfo, RemoteRuntime } from '@vingsforge/shared';
import type { ConversationState } from '../state/conversation.js';
import type { DetailContent } from './RightPanel.js';
import { MessageBubble } from './MessageBubble.js';
import { PermissionCard, type PermissionDecision } from './PermissionCard.js';
import { InputBar } from './InputBar.js';
import { TokenFooter } from './TokenFooter.js';
import { Icon } from './Icon.js';

export interface ConversationProps {
  title: string;
  conversation: ConversationState;
  models: ModelInfo[];
  runtimes: RemoteRuntime[];
  model: string;
  runtimeId: string;
  agentMode: AgentMode;
  showThinking: boolean;
  showCost: boolean;
  /** CLI-advertised slash commands for the input `/` popup (Objetivo 1). */
  slashCommands: string[];
  /** CLI-advertised skills for the input `/` popup (Objetivo 1). */
  skills: string[];
  onModelChange(model: string): void;
  onRuntimeChange(id: string): void;
  onAgentModeChange(m: AgentMode): void;
  onSend(text: string): void;
  onInterrupt(): void;
  onResolvePermission(decision: PermissionDecision): void;
  /** Opens a tool card's content in the right panel's Detail tab. */
  onOpenDetail(detail: DetailContent): void;
}

export function Conversation(props: ConversationProps): JSX.Element {
  const { conversation } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastTurn = conversation.turns[conversation.turns.length - 1];

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversation.turns, conversation.pendingPermission, conversation.error]);

  return (
    <div style={shell}>
      <header style={head}>
        <h2 style={title}>{props.title}</h2>
        {conversation.streaming ? <span style={streamTag}>streaming…</span> : null}
      </header>

      <div style={scroll} ref={scrollRef}>
        {conversation.turns.map((turn) => (
          <MessageBubble
            key={turn.id}
            turn={turn}
            showThinking={props.showThinking}
            onOpenDetail={props.onOpenDetail}
          />
        ))}

        {conversation.pendingPermission ? (
          <PermissionCard request={conversation.pendingPermission} onResolve={props.onResolvePermission} />
        ) : null}

        {conversation.error ? (
          <div style={errorBanner} role="alert">
            <Icon name="cross" size={15} style={{ color: 'var(--vf-danger)' }} />
            <span>{conversation.error}</span>
          </div>
        ) : null}
      </div>

      <InputBar
        models={props.models}
        runtimes={props.runtimes}
        model={props.model}
        runtimeId={props.runtimeId}
        agentMode={props.agentMode}
        streaming={conversation.streaming}
        slashCommands={props.slashCommands}
        skills={props.skills}
        onModelChange={props.onModelChange}
        onRuntimeChange={props.onRuntimeChange}
        onAgentModeChange={props.onAgentModeChange}
        onSend={props.onSend}
        onInterrupt={props.onInterrupt}
      />
      <TokenFooter
        {...(lastTurn?.usage ? { turnUsage: lastTurn.usage } : {})}
        sessionUsage={conversation.sessionUsage}
        showCost={props.showCost}
      />
    </div>
  );
}

const shell: CSSProperties = { display: 'flex', flexDirection: 'column', height: '100%' };
const head: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '12px 18px',
  borderBottom: '1px solid var(--vf-border)',
};
const title: CSSProperties = { margin: 0, fontSize: 14, fontWeight: 600 };
const streamTag: CSSProperties = { fontSize: 11, color: 'var(--vf-accent)' };
const scroll: CSSProperties = { flex: 1, overflowY: 'auto', padding: '14px 18px' };
const errorBanner: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '10px 12px',
  margin: '8px 0',
  borderRadius: 8,
  border: '1px solid var(--vf-danger)',
  background: 'color-mix(in srgb, var(--vf-danger) 10%, var(--vf-surface))',
  color: 'var(--vf-text)',
};
