/**
 * Security and edge-case coverage for the tool executors (Spec 04 §2/§4):
 * input validation, workspace confinement on writes, edit_file matching corners,
 * read/grep size & ReDoS guards, bash env sanitization, output truncation and
 * timeout clamping. Complements tools.test.ts (happy paths).
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workspace, PathEscapeError } from './workspace.js';
import {
  ToolExecutor,
  ReadTracker,
  sanitizeBashEnv,
  globToRegExp,
  MAX_READ_FILE_BYTES,
  MAX_BASH_OUTPUT_BYTES,
  MAX_BASH_TIMEOUT_MS,
  TRUNCATION_MARKER,
  type BashRunner,
} from './executors.js';

let root: string;
let exec: ToolExecutor;
let tracker: ReadTracker;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vf-sec-'));
  tracker = new ReadTracker();
  exec = new ToolExecutor(new Workspace(root), tracker);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function errOf(r: { output: unknown }): string {
  return (r.output as { error: string }).error;
}

describe('input validation (Zod, strict)', () => {
  it('rejects unknown extra properties (additionalProperties:false)', async () => {
    const r = await exec.execute('write_file', {
      path: 'a.txt',
      content: 'x',
      extra: true,
    } as never);
    expect(r.isError).toBe(true);
    expect(errOf(r)).toMatch(/invalid input for write_file/);
  });

  it('rejects an empty path', async () => {
    const r = await exec.execute('read_file', { path: '' });
    expect(r.isError).toBe(true);
    expect(errOf(r)).toMatch(/invalid input for read_file/);
  });

  it('rejects a non-positive / non-integer bash timeout', async () => {
    const r = await exec.execute('bash', { command: 'echo hi', timeout_ms: -5 });
    expect(r.isError).toBe(true);
    expect(errOf(r)).toMatch(/invalid input for bash/);
  });

  it('rejects an empty bash command', async () => {
    const r = await exec.execute('bash', { command: '' });
    expect(r.isError).toBe(true);
  });

  it('parseInput throws ToolError for malformed input', () => {
    expect(() => exec.parseInput('glob', { pattern: 123 })).toThrowError(/invalid input for glob/);
  });
});

describe('workspace confinement on write/read', () => {
  it('write_file rejects a .. escape', async () => {
    const r = await exec.execute('write_file', { path: '../escape.txt', content: 'x' });
    expect(r.isError).toBe(true);
    expect(errOf(r)).toMatch(/outside the workspace root/);
  });

  it('write_file rejects an absolute path outside the root', async () => {
    const r = await exec.execute('write_file', {
      path: '/tmp/vf-should-not-exist.txt',
      content: 'x',
    });
    expect(r.isError).toBe(true);
  });

  it('read_file rejects a symlink whose target escapes the root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'vf-out-'));
    writeFileSync(join(outside, 'secret'), 'top');
    symlinkSync(join(outside, 'secret'), join(root, 'leak'));
    const r = await exec.execute('read_file', { path: 'leak' });
    expect(r.isError).toBe(true);
    expect(errOf(r)).toMatch(/outside the workspace root/);
    rmSync(outside, { recursive: true, force: true });
  });

  it('write_file rejects writing through a directory symlink that escapes', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'vf-out-'));
    symlinkSync(outside, join(root, 'outlink')); // dir symlink to outside
    const r = await exec.execute('write_file', { path: 'outlink/pwn.txt', content: 'PWNED' });
    expect(r.isError).toBe(true);
    expect(errOf(r)).toMatch(/escapes the workspace|outside the workspace root/);
    rmSync(outside, { recursive: true, force: true });
  });

  it('write_file creates missing parent directories inside the root', async () => {
    const r = await exec.execute('write_file', { path: 'deep/nested/dir/file.txt', content: 'ok' });
    expect(r.isError).toBe(false);
    expect(readFileSync(join(root, 'deep/nested/dir/file.txt'), 'utf8')).toBe('ok');
  });
});

describe('read_file guards', () => {
  it('refuses files larger than the read cap', async () => {
    // Allocate just over the cap; content value is irrelevant.
    const big = 'a'.repeat(MAX_READ_FILE_BYTES + 1);
    writeFileSync(join(root, 'big.txt'), big);
    const r = await exec.execute('read_file', { path: 'big.txt' });
    expect(r.isError).toBe(true);
    expect(errOf(r)).toMatch(/exceeding the .* read limit/);
  });

  it('rejects an inverted range', async () => {
    writeFileSync(join(root, 'r.txt'), 'l1\nl2\nl3');
    const r = await exec.execute('read_file', { path: 'r.txt', range: [3, 1] });
    expect(r.isError).toBe(true);
    expect(errOf(r)).toMatch(/range end .* precedes start/);
  });
});

describe('edit_file matching corners', () => {
  beforeEach(() => writeFileSync(join(root, 'e.txt'), 'aXaXa'));

  it('rejects when old_str is not found', async () => {
    await exec.execute('read_file', { path: 'e.txt' });
    const r = await exec.execute('edit_file', { path: 'e.txt', old_str: 'ZZZ', new_str: 'q' });
    expect(r.isError).toBe(true);
    expect(errOf(r)).toMatch(/old_str not found/);
  });

  it('rejects an ambiguous (non-unique) old_str', async () => {
    await exec.execute('read_file', { path: 'e.txt' });
    const r = await exec.execute('edit_file', { path: 'e.txt', old_str: 'X', new_str: 'q' });
    expect(r.isError).toBe(true);
    expect(errOf(r)).toMatch(/not unique/);
  });

  it('a successful edit refreshes the tracker so a second edit is allowed', async () => {
    writeFileSync(join(root, 'seq.txt'), 'one two');
    await exec.execute('read_file', { path: 'seq.txt' });
    const r1 = await exec.execute('edit_file', { path: 'seq.txt', old_str: 'one', new_str: '1' });
    expect(r1.isError).toBe(false);
    // Tracker now holds the post-edit hash; editing the new content is fresh.
    const r2 = await exec.execute('edit_file', { path: 'seq.txt', old_str: 'two', new_str: '2' });
    expect(r2.isError).toBe(false);
    expect(readFileSync(join(root, 'seq.txt'), 'utf8')).toBe('1 2');
  });
});

describe('grep ReDoS and regex guards', () => {
  beforeEach(() => writeFileSync(join(root, 'g.txt'), 'hello\nworld'));

  it('rejects a nested-quantifier (catastrophic) pattern', async () => {
    const r = await exec.execute('grep', { pattern: '(a+)+$' });
    expect(r.isError).toBe(true);
    expect(errOf(r)).toMatch(/catastrophic backtracking|ReDoS/);
  });

  it('rejects adjacent quantifiers', async () => {
    const r = await exec.execute('grep', { pattern: 'a+*' });
    expect(r.isError).toBe(true);
    expect(errOf(r)).toMatch(/ReDoS|catastrophic/);
  });

  it('rejects an invalid regex', async () => {
    const r = await exec.execute('grep', { pattern: '([' });
    expect(r.isError).toBe(true);
    expect(errOf(r)).toMatch(/invalid regex/);
  });

  it('accepts a benign pattern and reports line numbers', async () => {
    const r = await exec.execute('grep', { pattern: 'world' });
    const out = r.output as { matches: { line: number }[] };
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]?.line).toBe(2);
  });
});

describe('glob traversal', () => {
  it('** matches nested files and excludes .git/node_modules', async () => {
    mkdirSync(join(root, 'src/a'), { recursive: true });
    mkdirSync(join(root, 'node_modules/x'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, 'src/a/deep.ts'), '');
    writeFileSync(join(root, 'node_modules/x/dep.ts'), '');
    writeFileSync(join(root, '.git/config'), '');
    const r = await exec.execute('glob', { pattern: '**/*.ts' });
    const matches = (r.output as { matches: string[] }).matches;
    expect(matches).toContain('src/a/deep.ts');
    expect(matches.some((m) => m.startsWith('node_modules/'))).toBe(false);
    expect(matches.some((m) => m.startsWith('.git/'))).toBe(false);
  });
});

describe('globToRegExp semantics', () => {
  it('* does not cross a path separator but ** does', () => {
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false);
    expect(globToRegExp('src/**/*.ts').test('src/a/b.ts')).toBe(true);
  });
  it('escapes regex metacharacters in literals', () => {
    expect(globToRegExp('a.b').test('a.b')).toBe(true);
    expect(globToRegExp('a.b').test('aXb')).toBe(false);
  });
});

describe('sanitizeBashEnv (secret stripping, Spec 04 §4)', () => {
  it('forwards only allowlisted vars and drops secrets', () => {
    const out = sanitizeBashEnv({
      PATH: '/usr/bin',
      HOME: '/home/u',
      LANG: 'C',
      ANTHROPIC_API_KEY: 'sk-leak',
      AWS_SECRET_ACCESS_KEY: 'leak',
      MY_TOKEN: 'leak',
      RANDOM_VAR: 'leak',
    });
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/u');
    expect(out.LANG).toBe('C');
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(out.MY_TOKEN).toBeUndefined();
    expect(out.RANDOM_VAR).toBeUndefined();
  });

  it('default invocation never leaks a process secret to the child', async () => {
    const sentinel = 'vf-secret-sentinel-value';
    process.env.SUPER_SECRET_TOKEN = sentinel;
    try {
      const r = await exec.execute('bash', { command: 'env' });
      const out = (r.output as { stdout: string }).stdout;
      expect(out).not.toContain(sentinel);
    } finally {
      delete process.env.SUPER_SECRET_TOKEN;
    }
  });
});

describe('bash runtime guards', () => {
  it('clamps an over-large timeout to the maximum', async () => {
    let seenTimeout = -1;
    const spyRunner: BashRunner = (_cmd, opts) => {
      seenTimeout = opts.timeoutMs;
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
    };
    const spied = new ToolExecutor(new Workspace(root), new ReadTracker(), spyRunner);
    await spied.execute('bash', { command: 'echo hi', timeout_ms: MAX_BASH_TIMEOUT_MS * 10 });
    expect(seenTimeout).toBe(MAX_BASH_TIMEOUT_MS);
  });

  it('runs the command in the workspace root', async () => {
    let seenCwd = '';
    const spyRunner: BashRunner = (_cmd, opts) => {
      seenCwd = opts.cwd;
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0, timedOut: false });
    };
    const spied = new ToolExecutor(new Workspace(root), new ReadTracker(), spyRunner);
    await spied.execute('bash', { command: 'pwd' });
    expect(seenCwd).toBe(new Workspace(root).root);
  });

  it('truncates and marks runaway stdout instead of OOMing', async () => {
    // Emit far more than the cap; the real runner must stop and mark truncation.
    const r = await exec.execute('bash', {
      command: `yes A | head -c ${MAX_BASH_OUTPUT_BYTES + 500_000}`,
      timeout_ms: 10_000,
    });
    const out = (r.output as { stdout: string }).stdout;
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(
      MAX_BASH_OUTPUT_BYTES + Buffer.byteLength(TRUNCATION_MARKER),
    );
    expect(out.endsWith(TRUNCATION_MARKER)).toBe(true);
  }, 15_000);

  it('a failing command reports a non-zero exit code without isError', async () => {
    const r = await exec.execute('bash', { command: 'exit 3' });
    expect(r.isError).toBe(false); // tool ran fine; the command failed
    expect((r.output as { exitCode: number }).exitCode).toBe(3);
  });
});

describe('Workspace direct API', () => {
  it('rejects a relative root', () => {
    expect(() => new Workspace('relative/path')).toThrowError(/must be absolute/);
  });
  it('canonicalRelative collapses equivalent spellings and throws on escape', () => {
    const ws = new Workspace(root);
    mkdirSync(join(root, 'd'));
    expect(ws.canonicalRelative('./d/../d/f')).toBe('d/f');
    expect(ws.canonicalRelative(join(root, 'd', 'f'))).toBe('d/f');
    expect(() => ws.canonicalRelative('../x')).toThrow(PathEscapeError);
  });
  it('toRelative maps the root itself to "."', () => {
    const ws = new Workspace(root);
    expect(ws.toRelative(ws.root)).toBe('.');
  });
});

describe('ReadTracker', () => {
  it('tracks freshness by content hash', () => {
    const t = new ReadTracker();
    expect(t.has('/x')).toBe(false);
    t.record('/x', 'v1');
    expect(t.has('/x')).toBe(true);
    expect(t.isFresh('/x', 'v1')).toBe(true);
    expect(t.isFresh('/x', 'v2')).toBe(false);
    expect(t.isFresh('/never', 'v1')).toBe(false);
  });
});
