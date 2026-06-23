/**
 * Conversation turn renderer (Spec 06 §4): user/assistant bubbles with markdown,
 * a collapsible reasoning panel and inline tool cards, in stream order. Shows a
 * typing indicator while the assistant turn is still streaming.
 */
import type { CSSProperties } from 'react';
import type { Turn } from '../state/conversation.js';
import type { DetailContent } from './RightPanel.js';
import { Markdown } from './Markdown.js';
import { ReasoningPanel } from './ReasoningPanel.js';
import { ToolCard } from './ToolCard.js';

export interface MessageBubbleProps {
  turn: Turn;
  showThinking: boolean;
  onOpenDetail(detail: DetailContent): void;
}

export function MessageBubble({ turn, showThinking, onOpenDetail }: MessageBubbleProps): JSX.Element {
  const isUser = turn.role === 'user';
  return (
    <div style={{ ...row, justifyContent: isUser ? 'flex-end' : 'flex-start' }} className="vf-fade-in">
      <div style={{ ...bubble, ...(isUser ? userBubble : assistantBubble) }}>
        {!isUser ? <div style={roleTag}>assistant</div> : null}
        {turn.items.map((item, i) => {
          if (item.kind === 'text') return <Markdown key={i} text={item.text} />;
          if (item.kind === 'thinking')
            return showThinking ? <ReasoningPanel key={i} text={item.text} /> : null;
          return <ToolCard key={item.card.callId} card={item.card} onOpenDetail={onOpenDetail} />;
        })}
        {turn.streaming ? (
          <span style={cursor} className="vf-pulse" aria-label="streaming">
            ●
          </span>
        ) : null}
      </div>
    </div>
  );
}

const row: CSSProperties = { display: 'flex', padding: '4px 0' };
const bubble: CSSProperties = {
  maxWidth: '82%',
  padding: '10px 14px',
  borderRadius: 12,
  border: '1px solid var(--vf-border)',
};
const userBubble: CSSProperties = {
  background: 'var(--vf-accent-weak)',
  borderColor: 'color-mix(in srgb, var(--vf-accent) 35%, transparent)',
  borderBottomRightRadius: 4,
};
const assistantBubble: CSSProperties = {
  background: 'var(--vf-bg-raised)',
  borderBottomLeftRadius: 4,
  width: '82%',
};
const roleTag: CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  color: 'var(--vf-text-faint)',
  marginBottom: 4,
};
const cursor: CSSProperties = { color: 'var(--vf-accent)', fontSize: 10, marginLeft: 2 };
