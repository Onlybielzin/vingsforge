import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Workspace, PathEscapeError } from './workspace.js';
import { ToolExecutor, ReadTracker } from './executors.js';
import { orderedTools } from './schemas.js';

let root: string;
let exec: ToolExecutor;
let tracker: ReadTracker;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vf-tools-'));
  tracker = new ReadTracker();
  exec = new ToolExecutor(new Workspace(root), tracker);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('orderedTools', () => {
  it('is sorted by name and strict', () => {
    const names = orderedTools.map((t) => t.name);
    expect(names).toEqual([...names].sort());
    for (const t of orderedTools) {
      expect(t.input_schema.additionalProperties).toBe(false);
    }
  });
});

describe('workspace confinement', () => {
  it('rejects .. escape', () => {
    expect(() => new Workspace(root).resolveInput('../secret')).toThrow(PathEscapeError);
  });
  it('rejects absolute path outside root', () => {
    expect(() => new Workspace(root).resolveInput('/etc/passwd')).toThrow(PathEscapeError);
  });
  it('rejects symlink pointing outside root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'vf-out-'));
    writeFileSync(join(outside, 'target.txt'), 'secret');
    symlinkSync(join(outside, 'target.txt'), join(root, 'link.txt'));
    expect(() => new Workspace(root).resolveExisting('link.txt')).toThrow(PathEscapeError);
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('read/write/edit', () => {
  it('reads a range', async () => {
    writeFileSync(join(root, 'a.txt'), 'l1\nl2\nl3\nl4');
    const r = await exec.execute('read_file', { path: 'a.txt', range: [2, 3] });
    expect(r.isError).toBe(false);
    expect((r.output as { content: string }).content).toBe('l2\nl3');
  });

  it('write then edit succeeds', async () => {
    await exec.execute('write_file', { path: 'b.txt', content: 'hello world' });
    // write records the hash, so edit is considered fresh.
    const r = await exec.execute('edit_file', { path: 'b.txt', old_str: 'world', new_str: 'forge' });
    expect(r.isError).toBe(false);
  });

  it('edit without prior read is rejected', async () => {
    writeFileSync(join(root, 'c.txt'), 'abc');
    const r = await exec.execute('edit_file', { path: 'c.txt', old_str: 'a', new_str: 'x' });
    expect(r.isError).toBe(true);
    expect((r.output as { error: string }).error).toMatch(/read it first/);
  });

  it('edit_file staleness check fires after out-of-band change', async () => {
    writeFileSync(join(root, 'd.txt'), 'one');
    await exec.execute('read_file', { path: 'd.txt' });
    writeFileSync(join(root, 'd.txt'), 'changed'); // out-of-band
    const r = await exec.execute('edit_file', { path: 'd.txt', old_str: 'changed', new_str: 'x' });
    expect(r.isError).toBe(true);
    expect((r.output as { error: string }).error).toMatch(/changed since last read/);
  });

  it('write_file through a file symlink pointing outside the root is blocked', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'vf-out-'));
    const target = join(outside, 'target.txt');
    writeFileSync(target, 'original');
    // Final component already exists as a symlink to an external file.
    symlinkSync(target, join(root, 'evil.txt'));
    const r = await exec.execute('write_file', { path: 'evil.txt', content: 'PWNED' });
    expect(r.isError).toBe(true);
    expect((r.output as { error: string }).error).toMatch(/outside the workspace root/);
    // The external target must remain untouched.
    expect(readFileSync(target, 'utf8')).toBe('original');
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('grep/glob', () => {
  it('grep finds matches', async () => {
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'x.ts'), 'const foo = 1;\nconst bar = 2;');
    const r = await exec.execute('grep', { pattern: 'foo' });
    const out = r.output as { matches: { path: string; line: number }[] };
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]?.path).toBe('sub/x.ts');
  });
  it('glob matches by pattern', async () => {
    writeFileSync(join(root, 'a.ts'), '');
    writeFileSync(join(root, 'b.js'), '');
    const r = await exec.execute('glob', { pattern: '*.ts' });
    expect((r.output as { matches: string[] }).matches).toEqual(['a.ts']);
  });
});

describe('bash', () => {
  it('captures stdout and stderr', async () => {
    const r = await exec.execute('bash', { command: 'echo out; echo err 1>&2' });
    const out = r.output as { stdout: string; stderr: string; exitCode: number };
    expect(out.stdout).toContain('out');
    expect(out.stderr).toContain('err');
    expect(out.exitCode).toBe(0);
  });
  it('times out', async () => {
    const r = await exec.execute('bash', { command: 'sleep 5', timeout_ms: 100 });
    expect((r.output as { timedOut: boolean }).timedOut).toBe(true);
  });
});
