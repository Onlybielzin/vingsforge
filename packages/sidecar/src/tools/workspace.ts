/**
 * Workspace confinement (Spec 04 §4). Resolves a model-supplied path to a
 * canonical absolute path inside the workspace root, rejecting `..` escapes,
 * symlinks that point outside, and absolute paths beyond the root.
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, relative, sep } from 'node:path';

/** Raised when a path escapes (or tries to escape) the workspace root. */
export class PathEscapeError extends Error {
  constructor(
    readonly requested: string,
    readonly reason: string,
  ) {
    super(`path '${requested}' is outside the workspace root: ${reason}`);
    this.name = 'PathEscapeError';
  }
}

/** True when `child` is the root itself or nested under it. */
function isInside(root: string, child: string): boolean {
  if (child === root) return true;
  const rel = relative(root, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Confines file access to a single workspace root.
 *
 * `resolveInput` does a lexical check (cheap, runs before any IO) and
 * `resolveExisting` adds a `realpath` check so that an existing symlink cannot
 * smuggle access to a target outside the root.
 */
export class Workspace {
  /** Canonical absolute path of the workspace root. */
  readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root)) {
      throw new Error(`workspace root must be absolute, got '${root}'`);
    }
    // Canonicalize the root itself so symlinked roots compare correctly.
    this.root = realpathSync.native(resolve(root));
  }

  /**
   * Lexically resolve a model-supplied path against the root and assert it does
   * not escape. Does not touch the filesystem, so it is safe for paths that do
   * not exist yet (e.g. `write_file` of a new file).
   */
  resolveInput(input: string): string {
    const abs = isAbsolute(input) ? resolve(input) : resolve(this.root, input);
    if (!isInside(this.root, abs)) {
      throw new PathEscapeError(input, 'resolves outside root');
    }
    return abs;
  }

  /**
   * Resolve and additionally canonicalize via `realpath` so symlinks are
   * followed and re-checked. Use for paths that must already exist (reads,
   * edits, dir listing). The parent-directory variant guards new-file writes
   * whose directory exists but whose final component does not.
   */
  resolveExisting(input: string): string {
    const abs = this.resolveInput(input);
    let real: string;
    try {
      real = realpathSync.native(abs);
    } catch {
      // Does not exist (yet): fall back to the lexical result, which already
      // passed the escape check above.
      return abs;
    }
    if (!isInside(this.root, real)) {
      throw new PathEscapeError(input, 'symlink target escapes root');
    }
    return real;
  }

  /** Workspace-relative path for display/logging (never leaks absolute root). */
  toRelative(abs: string): string {
    const rel = relative(this.root, abs);
    return rel === '' ? '.' : rel.split(sep).join('/');
  }

  /**
   * Canonical workspace-relative path (POSIX, no `.`/`..`, no absolute prefix)
   * for a raw model-supplied path. This is the single source of truth that both
   * the executor and the permission policy must agree on: equivalent spellings
   * (`.env`, `./.env`, `sub/../.env`, or an absolute path inside the root) all
   * collapse to the same string, so a `pathGlob` deny rule cannot be bypassed by
   * a textually different but equivalent path (Spec 04 §3/§4). Throws
   * {@link PathEscapeError} if the path escapes the root, like `resolveInput`.
   */
  canonicalRelative(input: string): string {
    return this.toRelative(this.resolveInput(input));
  }
}
