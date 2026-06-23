/**
 * Pure logic for the slash-command popup in the input bar (Objetivo 1). Kept as
 * a side-effect-free module so the matching / navigation / completion rules can
 * be unit-tested under the `node` test environment without a DOM.
 *
 * Behaviour mirrors Claude Code's `/`-popup: when the textarea content starts
 * with a single `/` (a command being typed at the very start, not a path), we
 * parse the partial token after the slash and surface the matching commands and
 * skills the CLI advertised on its last `system/init` event.
 */

/** A single selectable entry in the popup. */
export interface SlashEntry {
  /** Section the entry belongs to (drives the headers + completion prefix). */
  kind: 'command' | 'skill';
  /** Bare name as advertised by the CLI (no leading slash). */
  name: string;
}

/** What the input bar should render for the current textarea value. */
export interface SlashPopupState {
  /** Whether the popup is open at all for this text. */
  open: boolean;
  /** The partial token typed after the leading `/` (may be empty). */
  query: string;
  /** Filtered, ordered entries (commands first, then skills). */
  entries: SlashEntry[];
  /** When true the lists were empty because no turn has run yet. */
  emptyCatalog: boolean;
}

/**
 * Minimal built-in commands shown before the first turn, so the popup is useful
 * even when the CLI has not advertised its catalog yet. Intentionally tiny —
 * the real list replaces these the moment {@link EngineMeta} is populated.
 */
export const BUILTIN_SLASH_COMMANDS: readonly string[] = ['clear', 'compact', 'init'];

/**
 * Decides whether `text` is "in slash mode": the field holds a command being
 * typed, i.e. a single leading `/` followed by an optional `[\w:-]*` token and
 * nothing else (no spaces, no second slash). `"/"`, `"/co"`, `"/code-review"`
 * qualify; `"/foo bar"`, `"a /x"`, `"//"`, `"/a/b"` do not.
 */
export function parseSlashQuery(text: string): string | null {
  if (text[0] !== '/') return null;
  const rest = text.slice(1);
  if (!/^[\w:-]*$/.test(rest)) return null;
  return rest;
}

/** Case-insensitive prefix-first, then substring match against a name. */
function matches(name: string, query: string): boolean {
  if (query.length === 0) return true;
  return name.toLowerCase().includes(query.toLowerCase());
}

/** Ranks prefix matches above mid-string matches, then alphabetically. */
function rank(name: string, query: string): number {
  const lower = name.toLowerCase();
  const q = query.toLowerCase();
  if (q.length === 0) return 1;
  if (lower.startsWith(q)) return 0;
  return 1;
}

/**
 * Computes the popup state for a textarea value. `slashCommands` / `skills` are
 * the latest {@link EngineMeta} snapshot from the store. When both are empty the
 * popup falls back to {@link BUILTIN_SLASH_COMMANDS} and flags `emptyCatalog` so
 * the UI can show the "comandos aparecem após a 1ª mensagem" hint.
 */
export function computeSlashPopup(
  text: string,
  slashCommands: readonly string[],
  skills: readonly string[],
): SlashPopupState {
  const query = parseSlashQuery(text);
  if (query === null) {
    return { open: false, query: '', entries: [], emptyCatalog: false };
  }

  const emptyCatalog = slashCommands.length === 0 && skills.length === 0;
  const commandPool = emptyCatalog ? BUILTIN_SLASH_COMMANDS : slashCommands;

  const commandEntries: SlashEntry[] = commandPool
    .filter((name) => matches(name, query))
    .sort((a, b) => rank(a, query) - rank(b, query) || a.localeCompare(b))
    .map((name) => ({ kind: 'command' as const, name }));

  const skillEntries: SlashEntry[] = skills
    .filter((name) => matches(name, query))
    .sort((a, b) => rank(a, query) - rank(b, query) || a.localeCompare(b))
    .map((name) => ({ kind: 'skill' as const, name }));

  const entries = [...commandEntries, ...skillEntries];
  // Keep the popup open even with zero matches when the catalog is empty (so the
  // hint shows); otherwise a no-match query closes it.
  const open = entries.length > 0 || emptyCatalog;
  return { open, query, entries, emptyCatalog };
}

/** Clamps a highlight index into `[0, len)`, wrapping on over/underflow. */
export function clampIndex(index: number, len: number): number {
  if (len <= 0) return 0;
  return ((index % len) + len) % len;
}

/**
 * The text the input field should hold after the user picks `entry`. Commands
 * complete to `/<name> ` (trailing space, ready for args); skills complete to
 * the CLI's `/<name> ` form too — the engine routes a leading `/skillname` to
 * the skill. Always a single trailing space so the caret lands after it.
 */
export function completeSlash(entry: SlashEntry): string {
  return `/${entry.name} `;
}
