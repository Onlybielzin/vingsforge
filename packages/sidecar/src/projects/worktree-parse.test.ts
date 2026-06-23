import { describe, expect, it } from 'vitest';
import { parseWorktreePorcelain } from './manager.js';

/**
 * Unit tests for the `git worktree list --porcelain` parser. These exercise the
 * pure parser directly with captured fixtures; no real git process is spawned.
 */
describe('parseWorktreePorcelain', () => {
  it('parses a single main worktree on a branch', () => {
    const out = ['worktree /home/u/repo', 'HEAD abc123', 'branch refs/heads/main', ''].join('\n');

    expect(parseWorktreePorcelain(out)).toEqual([
      { path: '/home/u/repo', head: 'abc123', branch: 'main', isMain: true },
    ]);
  });

  it('parses multiple worktrees and flags only the first as main', () => {
    const out = [
      'worktree /home/u/repo',
      'HEAD aaa111',
      'branch refs/heads/main',
      '',
      'worktree /home/u/repo-feature',
      'HEAD bbb222',
      'branch refs/heads/feature/login',
      '',
      'worktree /home/u/repo-hotfix',
      'HEAD ccc333',
      'branch refs/heads/hotfix',
      '',
    ].join('\n');

    const result = parseWorktreePorcelain(out);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({
      path: '/home/u/repo',
      head: 'aaa111',
      branch: 'main',
      isMain: true,
    });
    // Branch names with slashes keep everything after refs/heads/.
    expect(result[1]).toEqual({
      path: '/home/u/repo-feature',
      head: 'bbb222',
      branch: 'feature/login',
      isMain: false,
    });
    expect(result[2]!.isMain).toBe(false);
  });

  it('marks detached HEAD worktrees and omits the branch', () => {
    const out = [
      'worktree /home/u/repo',
      'HEAD aaa111',
      'branch refs/heads/main',
      '',
      'worktree /home/u/repo-detached',
      'HEAD ddd444',
      'detached',
      '',
    ].join('\n');

    const result = parseWorktreePorcelain(out);
    expect(result[1]).toEqual({
      path: '/home/u/repo-detached',
      head: 'ddd444',
      isMain: false,
      isDetached: true,
    });
    expect(result[1]!.branch).toBeUndefined();
  });

  it('flags locked worktrees, with or without a lock reason', () => {
    const out = [
      'worktree /home/u/repo',
      'HEAD aaa111',
      'branch refs/heads/main',
      '',
      'worktree /home/u/repo-locked',
      'HEAD eee555',
      'branch refs/heads/wip',
      'locked',
      '',
      'worktree /home/u/repo-locked-reason',
      'HEAD fff666',
      'branch refs/heads/wip2',
      'locked on external drive',
      '',
    ].join('\n');

    const result = parseWorktreePorcelain(out);
    expect(result[1]!.isLocked).toBe(true);
    expect(result[2]!.isLocked).toBe(true);
  });

  it('skips a bare repository and lets the first real worktree be main', () => {
    const out = [
      'worktree /home/u/repo.git',
      'bare',
      '',
      'worktree /home/u/repo-wt',
      'HEAD aaa111',
      'branch refs/heads/main',
      '',
    ].join('\n');

    const result = parseWorktreePorcelain(out);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      path: '/home/u/repo-wt',
      head: 'aaa111',
      branch: 'main',
      isMain: true,
    });
  });

  it('keeps a non-refs/heads branch ref verbatim', () => {
    const out = ['worktree /home/u/repo', 'HEAD aaa111', 'branch refs/tags/v1.0', ''].join('\n');

    expect(parseWorktreePorcelain(out)[0]!.branch).toBe('refs/tags/v1.0');
  });

  it('defaults head to an empty string when no HEAD line is present', () => {
    const out = ['worktree /home/u/repo', 'branch refs/heads/main', ''].join('\n');

    expect(parseWorktreePorcelain(out)[0]!.head).toBe('');
  });

  it('tolerates CRLF line endings and trailing blank lines', () => {
    const out = [
      'worktree /home/u/repo',
      'HEAD aaa111',
      'branch refs/heads/main',
      '',
      'worktree /home/u/repo-feature',
      'HEAD bbb222',
      'branch refs/heads/feature',
      '',
      '',
    ].join('\r\n');

    const result = parseWorktreePorcelain(out);
    expect(result).toHaveLength(2);
    expect(result[0]!.path).toBe('/home/u/repo');
    expect(result[1]!.path).toBe('/home/u/repo-feature');
  });

  it('returns an empty array for empty or whitespace-only output', () => {
    expect(parseWorktreePorcelain('')).toEqual([]);
    expect(parseWorktreePorcelain('\n\n')).toEqual([]);
  });

  it('ignores blocks that have no worktree path line', () => {
    const out = ['HEAD aaa111', 'branch refs/heads/main', ''].join('\n');

    expect(parseWorktreePorcelain(out)).toEqual([]);
  });
});
