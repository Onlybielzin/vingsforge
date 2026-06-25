/**
 * UpdateAPI implementation — the in-app git auto-updater.
 *
 * `status()` probes the VingsForge checkout against its upstream with read-only
 * git plumbing (`fetch`, `rev-list --count`, `rev-parse --short`); `run()` spawns
 * the build/install pipeline in `scripts/update.sh` (rebuild + install the
 * AppImage on Omarchy/Arch) and streams its stdout/stderr to the UI as
 * `update.log` / `update.done` engine events.
 *
 * SECURITY: the repo directory is the ONLY external input and it comes from
 * settings, not from a chat. It is validated (absolute path, exists, contains a
 * `.git`) and passed as a single argv to `git -C <dir>` / `bash update.sh <dir>`
 * — never interpolated into a shell string (no `shell: true`). The script and the
 * git binary are fixed. A failing git/script NEVER crashes the host: errors are
 * surfaced as a thrown RPC error (status) or an `update.done {ok:false}` event (run).
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineEvent, UpdateStatus } from '@vingsforge/shared';

/** Built-in default checkout used when Settings `repoDir` is empty. */
export const DEFAULT_REPO_DIR = '/home/vings/vingsforge';

/**
 * Parse the "behind" commit count from the raw stdout of
 * `git rev-list --count HEAD..@{u}`. Pure and total: the raw output is a single
 * integer line, but git/CRLF/empty-upstream edge cases can yield blanks, stray
 * whitespace, or non-numeric noise. Any value that is not a finite, non-negative
 * integer collapses to `0` (treated as "up to date") so a malformed probe never
 * reports a bogus update as available.
 */
export function parseBehindCount(raw: string): number {
  const behind = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(behind) && behind >= 0 ? behind : 0;
}

/** Resolve the bundled `scripts/update.sh` relative to this compiled file. */
function defaultUpdateScript(): string {
  // dist/host/updater.js -> repo scripts/update.sh (../../../scripts/update.sh
  // from packages/sidecar/dist/host). Resolved from import.meta.url so a path
  // with spaces / non-ASCII still works.
  const here = fileURLToPath(new URL('.', import.meta.url));
  return join(here, '..', '..', '..', '..', 'scripts', 'update.sh');
}

/** Collaborators the updater depends on (all injectable for tests). */
export interface UpdaterDeps {
  /**
   * Resolve the repo directory to operate on (typically from Settings, falling
   * back to {@link DEFAULT_REPO_DIR}). Returned value is validated before use.
   */
  resolveRepoDir(): string | Promise<string>;
  /** Emit an engine event (update.log / update.done) onto the UI channel. */
  emit(event: EngineEvent): void;
  /** stderr-only logger. */
  log(message: string): void;
  /** Absolute path to `update.sh`. Defaults to the bundled script. */
  scriptPath?: string;
  /** Spawn hook (tests inject a fake). Defaults to node's `spawn`. */
  spawn?: typeof spawn;
  /** execFile hook (tests inject a fake). Defaults to node's `execFile`. */
  execFile?: typeof execFile;
}

/** Raised when the configured repo directory is not a usable git checkout. */
export class InvalidRepoDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRepoDirError';
  }
}

export class Updater {
  private running = false;

  constructor(private readonly deps: UpdaterDeps) {}

  /**
   * Probe the checkout against its upstream. Runs `git fetch` then counts the
   * commits HEAD is behind `@{u}` and resolves the short SHAs. Throws a typed
   * error if the repo dir is invalid or git fails — the host stays up.
   */
  async status(): Promise<UpdateStatus> {
    const repoDir = await this.validatedRepoDir();
    const git = (...args: string[]): Promise<string> => this.git(repoDir, args);

    // Refresh remote refs (best-effort; a fetch failure still lets us report the
    // local vs. last-known-upstream delta rather than crashing).
    try {
      await git('fetch', '--quiet');
    } catch (err) {
      this.deps.log(`update.status: fetch failed: ${errMsg(err)}`);
    }

    const current = (await git('rev-parse', '--short', 'HEAD')).trim();
    const latest = (await git('rev-parse', '--short', '@{u}')).trim();
    const behindRaw = await git('rev-list', '--count', 'HEAD..@{u}');
    const behindSafe = parseBehindCount(behindRaw);

    return {
      behind: behindSafe,
      current,
      latest,
      repoDir,
      available: behindSafe > 0,
    };
  }

  /**
   * Start the update pipeline. Spawns `bash scripts/update.sh <repoDir>` (NO
   * shell), streams stdout/stderr line-by-line as `update.log`, and emits a
   * terminal `update.done`. Refuses to start a second concurrent run. Never
   * throws for a script failure — the failure rides the `update.done` event.
   */
  async run(): Promise<void> {
    if (this.running) {
      this.deps.emit({ type: 'update.done', ok: false, message: 'update already in progress' });
      return;
    }

    let repoDir: string;
    try {
      repoDir = await this.validatedRepoDir();
    } catch (err) {
      this.deps.emit({ type: 'update.done', ok: false, message: errMsg(err) });
      return;
    }

    const script = this.deps.scriptPath ?? defaultUpdateScript();
    this.running = true;
    this.deps.log(`update.run: bash ${script} ${repoDir}`);
    this.deps.emit({ type: 'update.log', stream: 'stdout', line: `Updating ${repoDir}…` });

    const doSpawn = this.deps.spawn ?? spawn;
    let child: ChildProcess;
    try {
      // No shell: argv is fixed (bash + script + repoDir), so the repoDir can
      // never break out into a shell command.
      child = doSpawn('bash', [script, repoDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.running = false;
      this.deps.emit({ type: 'update.done', ok: false, message: errMsg(err) });
      return;
    }

    const pipe = (
      readable: NodeJS.ReadableStream | null,
      stream: 'stdout' | 'stderr',
    ): void => {
      if (readable === null) return;
      const rl = createInterface({ input: readable });
      rl.on('line', (line: string) => {
        this.deps.emit({ type: 'update.log', stream, line });
      });
    };
    pipe(child.stdout, 'stdout');
    pipe(child.stderr, 'stderr');

    child.on('error', (err: Error) => {
      this.running = false;
      this.deps.emit({ type: 'update.done', ok: false, message: err.message });
    });

    child.on('close', (code: number | null) => {
      this.running = false;
      const ok = code === 0;
      this.deps.emit({
        type: 'update.done',
        ok,
        ...(ok ? {} : { message: `update.sh exited with code ${code ?? 'null'}` }),
      });
    });
  }

  // --- internals ------------------------------------------------------------

  /** Resolve + validate the repo dir (absolute, exists, contains `.git`). */
  private async validatedRepoDir(): Promise<string> {
    const repoDir = (await this.deps.resolveRepoDir()).trim();
    if (repoDir.length === 0 || !isAbsolute(repoDir)) {
      throw new InvalidRepoDirError(`repoDir must be an absolute path (got: "${repoDir}")`);
    }
    try {
      const st = await stat(repoDir);
      if (!st.isDirectory()) {
        throw new InvalidRepoDirError(`repoDir is not a directory: ${repoDir}`);
      }
    } catch (err) {
      if (err instanceof InvalidRepoDirError) throw err;
      throw new InvalidRepoDirError(`repoDir does not exist: ${repoDir}`);
    }
    // Must contain a `.git` (a file for worktrees, a dir for a normal checkout).
    try {
      await access(join(repoDir, '.git'), fsConstants.F_OK);
    } catch {
      throw new InvalidRepoDirError(`repoDir is not a git checkout (no .git): ${repoDir}`);
    }
    return repoDir;
  }

  /** Run `git -C <repoDir> <args...>` (no shell) and resolve its stdout. */
  private git(repoDir: string, args: string[]): Promise<string> {
    const doExec = this.deps.execFile ?? execFile;
    return new Promise<string>((resolve, reject) => {
      doExec(
        'git',
        ['-C', repoDir, ...args],
        { maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const detail = (stderr || err.message).toString().trim();
            reject(new Error(`git ${args.join(' ')}: ${detail}`));
            return;
          }
          resolve(stdout.toString());
        },
      );
    });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
