/**
 * Tests for the Sidebar project-tree logic used by the store's
 * `toggleProjectExpanded` (Spec 06 §6): expand/collapse toggling plus the lazy
 * load + cache of a project's chats via `ipc.chats.list`. Runs under the
 * package's node-env vitest (no DOM), matching the other UI unit tests.
 *
 * The pure helpers mirror exactly what the store orchestrates, so a small
 * harness reproduces the store flow (toggle -> conditionally fetch -> cache)
 * against a mocked ipc.chats.list, which is what we assert here.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ChatSummary } from '@vingsforge/shared';
import {
  cacheChats,
  shouldLoadChats,
  toggleExpanded,
  willExpand,
} from './projectTree.js';

function chat(id: string, projectId: string): ChatSummary {
  return {
    id,
    projectId,
    title: `chat ${id}`,
    updatedAt: '2026-06-23T00:00:00.000Z',
    archived: false,
  };
}

/**
 * Reproduces the store's toggleProjectExpanded orchestration over the pure
 * helpers, so a test can assert the observable effects (expanded set, cache,
 * and how many times ipc.chats.list was called).
 */
async function runToggle(
  state: { expanded: string[]; cache: Record<string, ChatSummary[]> },
  id: string,
  list: (projectId: string) => Promise<ChatSummary[]>,
): Promise<void> {
  const expanding = willExpand(state.expanded, id);
  state.expanded = toggleExpanded(state.expanded, id);
  if (!expanding) return;
  if (!shouldLoadChats(state.cache, id, true)) return;
  const fetched = await list(id);
  state.cache = cacheChats(state.cache, id, fetched);
}

describe('toggleExpanded / willExpand', () => {
  it('expands a collapsed project (id added)', () => {
    expect(willExpand([], 'p1')).toBe(true);
    expect(toggleExpanded([], 'p1')).toEqual(['p1']);
  });

  it('collapses an expanded project (id removed)', () => {
    expect(willExpand(['p1'], 'p1')).toBe(false);
    expect(toggleExpanded(['p1'], 'p1')).toEqual([]);
  });

  it('toggles independently without disturbing siblings', () => {
    expect(toggleExpanded(['p1', 'p2'], 'p3')).toEqual(['p1', 'p2', 'p3']);
    expect(toggleExpanded(['p1', 'p2'], 'p1')).toEqual(['p2']);
  });

  it('does not mutate the input array', () => {
    const input = ['p1'];
    toggleExpanded(input, 'p2');
    expect(input).toEqual(['p1']);
  });
});

describe('shouldLoadChats', () => {
  it('loads only when expanding and the cache is empty for that id', () => {
    expect(shouldLoadChats({}, 'p1', true)).toBe(true);
  });

  it('does not load while collapsing', () => {
    expect(shouldLoadChats({}, 'p1', false)).toBe(false);
  });

  it('does not load when the project is already cached', () => {
    expect(shouldLoadChats({ p1: [] }, 'p1', true)).toBe(false);
  });

  it('treats a cached empty list as cached (no refetch)', () => {
    // An empty array is a real, cached answer — not "uncached".
    expect(shouldLoadChats({ p1: [] }, 'p1', true)).toBe(false);
  });
});

describe('cacheChats', () => {
  it('folds a fetched list under its project id without touching others', () => {
    const prev: Record<string, ChatSummary[]> = { p2: [chat('b', 'p2')] };
    const next = cacheChats(prev, 'p1', [chat('a', 'p1')]);
    expect(next.p1).toEqual([chat('a', 'p1')]);
    expect(next.p2).toEqual([chat('b', 'p2')]);
    expect(prev.p1).toBeUndefined(); // immutability
  });
});

describe('toggleProjectExpanded flow (store orchestration)', () => {
  it('expanding loads and caches the project chats via ipc.chats.list', async () => {
    const rows = [chat('c1', 'p1'), chat('c2', 'p1')];
    const list = vi.fn(async () => rows);
    const state = { expanded: [] as string[], cache: {} as Record<string, ChatSummary[]> };

    await runToggle(state, 'p1', list);

    expect(state.expanded).toEqual(['p1']);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith('p1');
    expect(state.cache.p1).toEqual(rows);
  });

  it('collapsing removes the project but keeps the cache and skips ipc', async () => {
    const list = vi.fn(async () => [chat('c1', 'p1')]);
    const state = {
      expanded: ['p1'],
      cache: { p1: [chat('c1', 'p1')] } as Record<string, ChatSummary[]>,
    };

    await runToggle(state, 'p1', list);

    expect(state.expanded).toEqual([]);
    expect(list).not.toHaveBeenCalled(); // collapse never fetches
    expect(state.cache.p1).toEqual([chat('c1', 'p1')]); // cache survives collapse
  });

  it('re-expanding a previously loaded project serves the cache (no second fetch)', async () => {
    const rows = [chat('c1', 'p1')];
    const list = vi.fn(async () => rows);
    const state = { expanded: [] as string[], cache: {} as Record<string, ChatSummary[]> };

    await runToggle(state, 'p1', list); // expand -> fetch
    await runToggle(state, 'p1', list); // collapse
    await runToggle(state, 'p1', list); // re-expand -> cached

    expect(state.expanded).toEqual(['p1']);
    expect(list).toHaveBeenCalledTimes(1); // fetched exactly once across re-expands
    expect(state.cache.p1).toEqual(rows);
  });

  it('expanding distinct projects fetches each one independently', async () => {
    const list = vi.fn(async (projectId: string) => [chat(`${projectId}-c`, projectId)]);
    const state = { expanded: [] as string[], cache: {} as Record<string, ChatSummary[]> };

    await runToggle(state, 'p1', list);
    await runToggle(state, 'p2', list);

    expect(state.expanded).toEqual(['p1', 'p2']);
    expect(list).toHaveBeenCalledTimes(2);
    expect(state.cache.p1).toEqual([chat('p1-c', 'p1')]);
    expect(state.cache.p2).toEqual([chat('p2-c', 'p2')]);
  });
});
