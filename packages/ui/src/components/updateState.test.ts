/**
 * Tests for the auto-update view-model reducer (Objetivo 2). Pure module; runs
 * in the `node` test environment.
 */
import { describe, expect, it } from 'vitest';
import type { EngineEvent } from '@vingsforge/shared';
import {
  idleUpdate,
  reduceUpdate,
  startUpdate,
  updateBannerText,
} from './updateState.js';

const log = (line: string, stream: 'stdout' | 'stderr' = 'stdout'): EngineEvent => ({
  type: 'update.log',
  line,
  stream,
});

describe('reduceUpdate', () => {
  it('appends log lines and flips idle to running on the first line', () => {
    let s = idleUpdate();
    expect(s.phase).toBe('idle');
    s = reduceUpdate(s, log('git pull --ff-only'));
    expect(s.phase).toBe('running');
    expect(s.lines).toEqual([{ stream: 'stdout', line: 'git pull --ff-only' }]);
    s = reduceUpdate(s, log('pnpm install'));
    expect(s.lines).toHaveLength(2);
  });

  it('preserves an explicit running phase across logs', () => {
    let s = startUpdate();
    s = reduceUpdate(s, log('building'));
    expect(s.phase).toBe('running');
  });

  it('tags stderr lines distinctly', () => {
    const s = reduceUpdate(startUpdate(), log('warning: x', 'stderr'));
    expect(s.lines[0]).toEqual({ stream: 'stderr', line: 'warning: x' });
  });

  it('marks done with the default success note on ok', () => {
    const s = reduceUpdate(startUpdate(), { type: 'update.done', ok: true });
    expect(s.phase).toBe('done');
    expect(s.message).toMatch(/Reabra o app/i);
  });

  it('marks error with the default failure note on !ok', () => {
    const s = reduceUpdate(startUpdate(), { type: 'update.done', ok: false });
    expect(s.phase).toBe('error');
    expect(s.message).toMatch(/falhou/i);
  });

  it('uses the provided message over the default', () => {
    const s = reduceUpdate(startUpdate(), {
      type: 'update.done',
      ok: false,
      message: 'exit code 1',
    });
    expect(s.message).toBe('exit code 1');
  });

  it('ignores unrelated events (chat traffic on the same channel)', () => {
    const s = startUpdate();
    const next = reduceUpdate(s, {
      type: 'message.delta',
      chatId: 'c-1',
      text: 'hi',
    });
    expect(next).toBe(s); // same reference, untouched
  });
});

describe('updateBannerText', () => {
  it('uses the singular for one commit', () => {
    expect(updateBannerText(1)).toMatch(/\(1 commit\)/);
  });
  it('uses the plural otherwise', () => {
    expect(updateBannerText(3)).toMatch(/\(3 commits\)/);
  });
});
