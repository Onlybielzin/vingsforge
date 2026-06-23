/**
 * Chat list for a project (Spec 06 §3): shown in the main panel when no chat is
 * open. Rows show title + last-message preview; "new chat" CTA on top.
 */
import type { CSSProperties } from 'react';
import type { ChatSummary } from '@vingsforge/shared';
import { Icon } from './Icon.js';

export interface ChatListProps {
  projectName: string | null;
  chats: ChatSummary[];
  onSelectChat(id: string): void;
  onNewChat(): void;
}

export function ChatList({ projectName, chats, onSelectChat, onNewChat }: ChatListProps): JSX.Element {
  const visible = chats.filter((c) => !c.archived);
  return (
    <div style={shell}>
      <header style={head}>
        <h2 style={title}>{projectName ?? 'Chats'}</h2>
        <button style={newBtn} onClick={onNewChat}>
          <Icon name="plus" size={14} />
          <span>New chat</span>
        </button>
      </header>

      {visible.length === 0 ? (
        <div style={empty}>
          <Icon name="chat" size={28} style={{ color: 'var(--vf-text-faint)' }} />
          <p style={{ color: 'var(--vf-text-muted)' }}>No chats yet</p>
          <button style={newBtn} onClick={onNewChat}>
            <Icon name="plus" size={14} />
            <span>Start a chat</span>
          </button>
        </div>
      ) : (
        <ul style={list}>
          {visible.map((c) => (
            <li key={c.id}>
              <button style={row} onClick={() => onSelectChat(c.id)} className="vf-fade-in">
                <Icon name="chat" size={16} style={{ color: 'var(--vf-text-muted)', marginTop: 2 }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={rowTitle}>{c.title}</span>
                  {c.lastMessagePreview ? <span style={preview}>{c.lastMessagePreview}</span> : null}
                </span>
                <Icon name="chevron-right" size={15} style={{ color: 'var(--vf-text-faint)' }} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const shell: CSSProperties = { display: 'flex', flexDirection: 'column', height: '100%' };
const head: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '14px 18px',
  borderBottom: '1px solid var(--vf-border)',
};
const title: CSSProperties = { margin: 0, fontSize: 15, fontWeight: 600 };
const newBtn: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 12px',
  borderRadius: 7,
  border: '1px solid var(--vf-border)',
  background: 'var(--vf-surface)',
  color: 'var(--vf-text)',
  fontSize: 13,
};
const list: CSSProperties = { listStyle: 'none', margin: 0, padding: 10, overflowY: 'auto', flex: 1 };
const row: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  width: '100%',
  padding: '10px 12px',
  border: '1px solid transparent',
  borderRadius: 9,
  background: 'transparent',
  color: 'var(--vf-text)',
  textAlign: 'left',
};
const rowTitle: CSSProperties = { display: 'block', fontWeight: 500 };
const preview: CSSProperties = {
  display: 'block',
  marginTop: 2,
  fontSize: 12,
  color: 'var(--vf-text-muted)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: '46ch',
};
const empty: CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 12,
};
