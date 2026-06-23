/**
 * Pure, framework-free logic for the expandable Sidebar project tree
 * (Spec 06 §6). Extracted from the React store so the toggle/expand/collapse
 * and lazy chat-loading rules can be unit-tested under the package's node-env
 * vitest (no DOM), mirroring chatStatus.ts / externalSessions.ts.
 *
 * The store's `toggleProjectExpanded` is a thin wrapper over these helpers:
 * it flips expansion with `toggleExpanded`, and — only when the project is
 * newly expanded and its chats aren't cached yet — fetches `ipc.chats.list`
 * and folds the result in with `cacheChats`.
 */
import type { ChatSummary } from '@vingsforge/shared';

/** Toggle a project id in the expanded-ids list (add when absent, remove when present). */
export function toggleExpanded(expanded: readonly string[], id: string): string[] {
  return expanded.includes(id) ? expanded.filter((p) => p !== id) : [...expanded, id];
}

/** Whether toggling `id` against `expanded` will EXPAND it (vs collapse). */
export function willExpand(expanded: readonly string[], id: string): boolean {
  return !expanded.includes(id);
}

/**
 * Whether a project's chats still need to be fetched: only when the project is
 * being expanded AND there is no cached entry for it yet. Drives the lazy load
 * so a re-expand never re-hits the IPC.
 */
export function shouldLoadChats(
  cache: Record<string, ChatSummary[]>,
  id: string,
  expanding: boolean,
): boolean {
  return expanding && cache[id] === undefined;
}

/** Fold a freshly-fetched chat list into the per-project cache, replacing any prior entry. */
export function cacheChats(
  cache: Record<string, ChatSummary[]>,
  id: string,
  list: ChatSummary[],
): Record<string, ChatSummary[]> {
  return { ...cache, [id]: list };
}
