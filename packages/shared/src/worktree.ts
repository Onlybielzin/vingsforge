/**
 * Git worktree model (Spec 01). Describes one entry of a project's
 * `git worktree list`, used by the UI to surface checkouts beside the main repo.
 */

/** A single git worktree of a local project's repository. */
export interface Worktree {
  /** Absolute path to the worktree's root directory. */
  path: string;
  /** Checked-out branch short name (omitted when detached or bare). */
  branch?: string;
  /** Commit SHA the worktree's HEAD points at. */
  head: string;
  /** True for the repository's main working tree (the first porcelain block). */
  isMain: boolean;
  /** True when HEAD is detached (no branch). */
  isDetached?: boolean;
  /** True when the worktree is locked (`git worktree lock`). */
  isLocked?: boolean;
}
