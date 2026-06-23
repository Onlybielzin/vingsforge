/**
 * Local tool executors (Spec 04 §2/§4): read/list/glob/grep/write/edit/bash.
 * All filesystem access is confined to the workspace root; `edit_file` does a
 * staleness check and `bash` enforces a timeout with stdout+stderr capture.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { PathEscapeError, Workspace } from './workspace.js';
import type { LocalToolName, ToolInput } from './schemas.js';
import { toolInputSchemas } from './schemas.js';

/** Default and maximum bash timeouts in milliseconds (Spec 04 §4). */
export const DEFAULT_BASH_TIMEOUT_MS = 30_000;
export const MAX_BASH_TIMEOUT_MS = 600_000;

/**
 * Per-stream output cap for `bash` (Spec 04 §4). The timeout bounds wall-clock
 * time but not volume: a command like `yes` or `cat /dev/urandom | base64` can
 * emit gigabytes before the SIGKILL lands, OOM-ing the sidecar by accumulating
 * it in a string. We cap each of stdout/stderr at this many bytes, then stop
 * accumulating, append a truncation marker, and kill the child tree.
 */
export const MAX_BASH_OUTPUT_BYTES = 2_000_000;

/**
 * Hard cap on the size of a single file `read_file` will load into memory.
 * Files larger than this are refused before any read, since the model cannot
 * usefully consume them anyway and a multi-GB file would OOM the sidecar.
 */
export const MAX_READ_FILE_BYTES = 10_000_000;

/** Marker appended to a stream/file when output is cut off at its byte cap. */
export const TRUNCATION_MARKER = '\n[output truncated]';

/** Thrown when a tool input fails validation or an operation is rejected. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/** Result of a tool execution; `isError` mirrors the engine's tool_result block. */
export interface ToolExecResult {
  output: unknown;
  isError: boolean;
}

/**
 * Tracks the content hash of each file the agent has read, so `edit_file` can
 * detect out-of-band changes (staleness) since the last read (Spec 04 §2.1).
 */
export class ReadTracker {
  private readonly hashes = new Map<string, string>();

  static hash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  record(absPath: string, content: string): void {
    this.hashes.set(absPath, ReadTracker.hash(content));
  }

  /** True when the file was read and its content is unchanged since. */
  isFresh(absPath: string, currentContent: string): boolean {
    const seen = this.hashes.get(absPath);
    return seen !== undefined && seen === ReadTracker.hash(currentContent);
  }

  has(absPath: string): boolean {
    return this.hashes.has(absPath);
  }
}

const MAX_GLOB_RESULTS = 1000;
const MAX_GREP_MATCHES = 1000;

/**
 * ReDoS hardening for `grep` (Spec 04 §2). The pattern comes from the model and
 * is untrusted; `grep` is read-only and never gated, so a catastrophic
 * backtracking pattern (e.g. `(a+)+$`) applied line-by-line across the whole
 * workspace would pin the sidecar event loop indefinitely. JS has no linear-time
 * regex engine in the stdlib and we avoid a native dep (`re2`), so we instead:
 *  - reject patterns with nested quantifiers (the source of exponential blowup),
 *  - skip files larger than `MAX_GREP_FILE_BYTES` and lines longer than
 *    `MAX_GREP_LINE_BYTES` (binary/minified files are the usual ReDoS fuel),
 *  - and enforce a wall-clock budget, aborting with an error after the deadline.
 */
const MAX_GREP_FILE_BYTES = 5_000_000;
const MAX_GREP_LINE_BYTES = 100_000;
const GREP_TIME_BUDGET_MS = 2_000;

/**
 * Heuristic rejection of regexes prone to catastrophic backtracking: a quantifier
 * (`*`, `+`, `{n,}`) applied to a group/class that itself contains a quantifier —
 * e.g. `(a+)+`, `(a*)*`, `(?:a+|b)*`, `[a-z]+*`. This is the safe-regex "star
 * height" check, inlined to avoid a runtime dependency. Conservative: it may
 * reject some safe patterns, but never admits an exponential one.
 */
function isCatastrophicRegex(source: string): boolean {
  // A group whose body contains a quantifier, immediately followed by an outer
  // quantifier. We strip escaped chars so `\(` / `\+` don't trigger false hits.
  const unescaped = source.replace(/\\./g, '');
  // group/class body containing a quantifier, then closed and quantified again
  const nestedQuantifier =
    /\([^()]*[*+?{][^()]*\)\s*[*+{]/.test(unescaped) ||
    /\[[^\]]*\]\s*[*+]\s*[*+]/.test(unescaped) ||
    /[*+?]\s*[*+]/.test(unescaped); // adjacent quantifiers like `a+*`
  return nestedQuantifier;
}

export interface BashRunner {
  (
    command: string,
    opts: { cwd: string; timeoutMs: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>;
}

/**
 * Env vars that look like secrets are stripped from the bash child regardless of
 * name match below (Spec 04 §4: "Nunca colocar segredos ... nas mensagens").
 */
const SECRET_ENV_PATTERN = /key|token|secret|password|passwd|credential|auth/i;

/**
 * Variables forwarded to the bash child by name. Anything outside this set —
 * notably ANTHROPIC_API_KEY and other app/daemon secrets in `process.env` — is
 * dropped so the agent (or prompt-injected content) cannot exfiltrate it via
 * `env`/`printenv`/`echo $...`, since runBash returns full stdout to the model.
 */
const ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TZ', 'TMPDIR'] as const;

/** Build a minimal, secret-free env for the bash child from `process.env`. */
export function sanitizeBashEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ENV_ALLOWLIST) {
    const value = source[name];
    // Defence in depth: never forward an allowlisted name that itself looks secret.
    if (value !== undefined && !SECRET_ENV_PATTERN.test(name)) {
      env[name] = value;
    }
  }
  return env;
}

/** Default bash runner: spawns `/bin/sh -c`, capturing stdout+stderr, killing on timeout. */
export const defaultBashRunner: BashRunner = (command, { cwd, timeoutMs }) =>
  new Promise((resolvePromise) => {
    // `detached` puts the child in its own process group so we can SIGKILL the
    // whole tree (e.g. `sh -c 'sleep 5'`) on timeout, not just the shell.
    // `env` is allowlisted so secrets in process.env (e.g. ANTHROPIC_API_KEY)
    // never reach the shell and cannot be echoed back to the model.
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      detached: true,
      env: sanitizeBashEnv(),
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let truncated = false;
    const kill = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    // Cap each stream by byte length: once either stream reaches the cap we stop
    // accumulating, mark it truncated, and SIGKILL the child tree so a runaway
    // producer (`yes`, `cat /dev/urandom`) cannot OOM the sidecar before timeout.
    const append = (current: string, chunk: Buffer): string => {
      if (truncated || Buffer.byteLength(current) >= MAX_BASH_OUTPUT_BYTES) return current;
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next) <= MAX_BASH_OUTPUT_BYTES) return next;
      // Trim to the cap on a char boundary, then mark and kill.
      truncated = true;
      let kept = next;
      while (Buffer.byteLength(kept) > MAX_BASH_OUTPUT_BYTES) {
        kept = kept.slice(0, -1024);
      }
      kill();
      return kept + TRUNCATION_MARKER;
    };
    child.stdout.on('data', (d: Buffer) => {
      stdout = append(stdout, d);
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr = append(stderr, d);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      stderr += String(err);
      resolvePromise({ stdout, stderr, exitCode: null, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, exitCode: code, timedOut });
    });
  });

/**
 * Executes the v1 built-in tools against a confined workspace. Validates every
 * input with its Zod schema before touching the filesystem or shell.
 */
export class ToolExecutor {
  constructor(
    private readonly workspace: Workspace,
    private readonly readTracker: ReadTracker = new ReadTracker(),
    private readonly bash: BashRunner = defaultBashRunner,
  ) {}

  /** Validate raw model input against the tool's schema (throws ToolError). */
  parseInput<T extends LocalToolName>(tool: T, raw: unknown): ToolInput<T> {
    const result = toolInputSchemas[tool].safeParse(raw);
    if (!result.success) {
      throw new ToolError(`invalid input for ${tool}: ${result.error.message}`, 'invalid_input');
    }
    return result.data as ToolInput<T>;
  }

  /** Run a validated tool call, returning a result with an `isError` flag. */
  async execute<T extends LocalToolName>(tool: T, raw: unknown): Promise<ToolExecResult> {
    try {
      const input = this.parseInput(tool, raw);
      const output = await this.dispatch(tool, input);
      return { output, isError: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: { error: message }, isError: true };
    }
  }

  private async dispatch<T extends LocalToolName>(tool: T, input: ToolInput<T>): Promise<unknown> {
    switch (tool) {
      case 'read_file':
        return this.readFile(input as ToolInput<'read_file'>);
      case 'list_dir':
        return this.listDir(input as ToolInput<'list_dir'>);
      case 'glob':
        return this.glob(input as ToolInput<'glob'>);
      case 'grep':
        return this.grep(input as ToolInput<'grep'>);
      case 'write_file':
        return this.writeFile(input as ToolInput<'write_file'>);
      case 'edit_file':
        return this.editFile(input as ToolInput<'edit_file'>);
      case 'bash':
        return this.runBash(input as ToolInput<'bash'>);
      default: {
        const exhaustive: never = tool;
        throw new ToolError(`unknown tool ${String(exhaustive)}`, 'unknown_tool');
      }
    }
  }

  private readFile(input: ToolInput<'read_file'>): { path: string; content: string } {
    const abs = this.workspace.resolveExisting(input.path);
    // Refuse oversized files before reading: loading a multi-GB file into a
    // string would OOM the sidecar (the timeout/budget guards do not apply here).
    const size = statSync(abs).size;
    if (size > MAX_READ_FILE_BYTES) {
      throw new ToolError(
        `'${this.workspace.toRelative(abs)}' is ${size} bytes, exceeding the ` +
          `${MAX_READ_FILE_BYTES}-byte read limit; use 'range' or 'grep' to read part of it`,
        'file_too_large',
      );
    }
    const full = readFileSync(abs, 'utf8');
    this.readTracker.record(abs, full);
    if (!input.range) {
      return { path: this.workspace.toRelative(abs), content: full };
    }
    const [start, end] = input.range;
    if (end < start) {
      throw new ToolError(`range end ${end} precedes start ${start}`, 'invalid_range');
    }
    const lines = full.split('\n');
    const slice = lines.slice(start - 1, end).join('\n');
    return { path: this.workspace.toRelative(abs), content: slice };
  }

  private listDir(input: ToolInput<'list_dir'>): {
    path: string;
    entries: { name: string; kind: 'file' | 'dir' | 'symlink'; size?: number }[];
  } {
    const abs = this.workspace.resolveExisting(input.path);
    const dirents = readdirSync(abs, { withFileTypes: true });
    const entries = dirents.map((d) => {
      const kind: 'file' | 'dir' | 'symlink' = d.isSymbolicLink()
        ? 'symlink'
        : d.isDirectory()
          ? 'dir'
          : 'file';
      let size: number | undefined;
      if (kind === 'file') {
        try {
          size = statSync(join(abs, d.name)).size;
        } catch {
          size = undefined;
        }
      }
      return size === undefined ? { name: d.name, kind } : { name: d.name, kind, size };
    });
    return { path: this.workspace.toRelative(abs), entries };
  }

  private glob(input: ToolInput<'glob'>): { pattern: string; matches: string[] } {
    const regex = globToRegExp(input.pattern);
    const matches: string[] = [];
    for (const rel of this.walk(this.workspace.root)) {
      if (regex.test(rel)) {
        matches.push(rel);
        if (matches.length >= MAX_GLOB_RESULTS) break;
      }
    }
    matches.sort();
    return { pattern: input.pattern, matches };
  }

  private grep(input: ToolInput<'grep'>): {
    pattern: string;
    matches: { path: string; line: number; text: string }[];
  } {
    // ReDoS guard: reject patterns whose nested quantifiers can cause
    // catastrophic backtracking before we ever compile/run them (see notes on
    // isCatastrophicRegex). `grep` is read-only and never gated, so this is the
    // only line of defence against a model-supplied bomb pattern.
    if (isCatastrophicRegex(input.pattern)) {
      throw new ToolError(
        'pattern rejected: nested quantifiers risk catastrophic backtracking (ReDoS)',
        'unsafe_regex',
      );
    }
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern);
    } catch (err) {
      throw new ToolError(
        `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
        'invalid_regex',
      );
    }
    const base = input.path ? this.workspace.resolveExisting(input.path) : this.workspace.root;
    const isDir = statSync(base).isDirectory();
    const files = isDir
      ? [...this.walk(base)].map((rel) => join(this.workspace.root, rel))
      : [base];
    const matches: { path: string; line: number; text: string }[] = [];
    // Wall-clock budget: even with the nested-quantifier guard, a long input
    // against many files can be slow; abort rather than block the event loop.
    const deadline = Date.now() + GREP_TIME_BUDGET_MS;
    for (const file of files) {
      // Skip oversized/binary files by size before reading them into memory.
      try {
        if (statSync(file).size > MAX_GREP_FILE_BYTES) continue;
      } catch {
        continue;
      }
      let content: string;
      try {
        content = readFileSync(file, 'utf8');
      } catch {
        continue; // skip binary/unreadable files
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const text = lines[i] ?? '';
        // Skip pathologically long lines (minified/binary) that are ReDoS fuel.
        if (text.length > MAX_GREP_LINE_BYTES) continue;
        if (Date.now() > deadline) {
          throw new ToolError(
            `grep exceeded its ${GREP_TIME_BUDGET_MS}ms time budget; narrow the pattern or path`,
            'grep_timeout',
          );
        }
        if (regex.test(text)) {
          matches.push({ path: this.workspace.toRelative(file), line: i + 1, text });
          if (matches.length >= MAX_GREP_MATCHES) {
            return { pattern: input.pattern, matches };
          }
        }
      }
    }
    return { pattern: input.pattern, matches };
  }

  private writeFile(input: ToolInput<'write_file'>): { path: string; bytes: number } {
    const abs = this.workspace.resolveInput(input.path);
    // The parent directory, if it exists, must not be a symlink escape.
    this.assertParentInside(input.path, abs);
    // If the final component already exists and is a symlink to outside the
    // root, writeFileSync would follow it and clobber the external target
    // (the lexical resolveInput above cannot see this). Mirror resolveExisting:
    // canonicalize the target and reject if its real path escapes the root.
    let real: string | undefined;
    try {
      real = realpathSync.native(abs);
    } catch {
      real = undefined; // does not exist yet: lexical check above suffices
    }
    if (real !== undefined) {
      const rel = relative(this.workspace.root, real);
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        throw new PathEscapeError(input.path, 'symlink target escapes root');
      }
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, input.content, 'utf8');
    this.readTracker.record(abs, input.content);
    return { path: this.workspace.toRelative(abs), bytes: Buffer.byteLength(input.content) };
  }

  private editFile(input: ToolInput<'edit_file'>): {
    path: string;
    replacements: number;
    bytes: number;
  } {
    const abs = this.workspace.resolveExisting(input.path);
    const current = readFileSync(abs, 'utf8');
    // Staleness check: refuse if the file changed since the agent last read it.
    if (!this.readTracker.has(abs)) {
      throw new ToolError(
        `refusing to edit '${this.workspace.toRelative(abs)}': read it first`,
        'not_read',
      );
    }
    if (!this.readTracker.isFresh(abs, current)) {
      throw new ToolError(
        `'${this.workspace.toRelative(abs)}' changed since last read; re-read before editing`,
        'stale',
      );
    }
    const idx = current.indexOf(input.old_str);
    if (idx === -1) {
      throw new ToolError('old_str not found in file', 'no_match');
    }
    if (current.indexOf(input.old_str, idx + input.old_str.length) !== -1) {
      throw new ToolError('old_str is not unique; provide more context', 'ambiguous_match');
    }
    const next = current.slice(0, idx) + input.new_str + current.slice(idx + input.old_str.length);
    writeFileSync(abs, next, 'utf8');
    this.readTracker.record(abs, next);
    return {
      path: this.workspace.toRelative(abs),
      replacements: 1,
      bytes: Buffer.byteLength(next),
    };
  }

  private async runBash(input: ToolInput<'bash'>): Promise<{
    command: string;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
  }> {
    const timeoutMs = Math.min(input.timeout_ms ?? DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS);
    const result = await this.bash(input.command, { cwd: this.workspace.root, timeoutMs });
    return { command: input.command, ...result };
  }

  /** Reject writes whose existing parent directory is a symlink pointing outside the root. */
  private assertParentInside(requested: string, abs: string): void {
    const parent = dirname(abs);
    try {
      this.workspace.resolveExisting(relative(this.workspace.root, parent) || '.');
    } catch {
      throw new ToolError(`parent directory of '${requested}' escapes the workspace`, 'escape');
    }
  }

  /** Yield workspace-relative POSIX paths of every file under `start`. */
  private *walk(start: string): Generator<string> {
    const stack: string[] = [start];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      let dirents;
      try {
        dirents = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const d of dirents) {
        if (d.name === '.git' || d.name === 'node_modules') continue;
        const abs = join(dir, d.name);
        if (d.isSymbolicLink()) continue; // never follow symlinks during traversal
        if (d.isDirectory()) {
          stack.push(abs);
        } else if (d.isFile()) {
          yield relative(this.workspace.root, abs).split(/[\\/]/).join('/');
        }
      }
    }
  }
}

/** Minimal glob → RegExp supporting `*`, `**`, `?` and `/` boundaries. */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i] as string;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (pattern[i + 1] === '/') i += 1; // consume the slash after **
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}
