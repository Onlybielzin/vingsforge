/**
 * Chat export to JSON / Markdown (Spec 08 §6). Never includes secrets (no API keys).
 * Reads from any DbStore so it works with both backends.
 */
import type { Chat, ChatMessage } from '@vingsforge/shared';
import type { DbStore } from './store.js';

export interface ChatExport {
  version: 1;
  chat: Chat;
  messages: ChatMessage[];
  exportedAt: string;
}

/** Build a JSON-serializable export of a chat and its full history. */
export function exportChatJson(store: DbStore, chatId: string): ChatExport {
  const chat = store.chats.get(chatId);
  if (!chat) throw new Error(`Chat not found: ${chatId}`);
  return {
    version: 1,
    chat,
    messages: store.messages.list(chatId),
    exportedAt: new Date().toISOString(),
  };
}

/** Render a chat as Markdown (useful for the `createmd` skill). */
export function exportChatMarkdown(store: DbStore, chatId: string): string {
  const { chat, messages } = exportChatJson(store, chatId);
  const lines: string[] = [`# ${chat.title}`, ''];
  for (const msg of messages) {
    lines.push(`## ${msg.role === 'user' ? 'User' : 'Assistant'}`, '');
    for (const block of msg.blocks) {
      switch (block.kind) {
        case 'text':
          lines.push(block.text, '');
          break;
        case 'thinking':
          lines.push('> [!note]- Thinking', `> ${block.text.replace(/\n/g, '\n> ')}`, '');
          break;
        case 'tool_use':
          lines.push(
            `**Tool call** \`${block.tool}\` (\`${block.callId}\`)`,
            '',
            '```json',
            JSON.stringify(block.input, null, 2),
            '```',
            '',
          );
          break;
        case 'tool_result':
          lines.push(
            `**Tool result**${block.isError ? ' (error)' : ''} (\`${block.callId}\`)`,
            '',
            '```json',
            JSON.stringify(block.output, null, 2),
            '```',
            '',
          );
          break;
      }
    }
  }
  return lines.join('\n');
}
