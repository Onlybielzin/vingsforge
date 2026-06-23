/**
 * Tests for the slash-command popup logic (Objetivo 1). Pure module — no DOM —
 * so it runs in the `node` test environment alongside the rest of the suite.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SLASH_COMMANDS,
  clampIndex,
  completeSlash,
  computeSlashPopup,
  parseSlashQuery,
} from './slashPopup.js';

const COMMANDS = ['code-review', 'init', 'compact', 'clear', 'context'];
const SKILLS = ['createmd', 'efeitos-web', 'deep-research'];

describe('parseSlashQuery', () => {
  it('treats a bare leading slash as an empty query', () => {
    expect(parseSlashQuery('/')).toBe('');
  });

  it('captures the partial token after the slash', () => {
    expect(parseSlashQuery('/co')).toBe('co');
    expect(parseSlashQuery('/code-review')).toBe('code-review');
    expect(parseSlashQuery('/plugin:skill')).toBe('plugin:skill');
  });

  it('returns null when not in slash mode', () => {
    expect(parseSlashQuery('')).toBeNull();
    expect(parseSlashQuery('hello')).toBeNull();
    expect(parseSlashQuery('a /x')).toBeNull(); // slash not at start
    expect(parseSlashQuery('/foo bar')).toBeNull(); // space ends command mode
    expect(parseSlashQuery('/a/b')).toBeNull(); // a path, not a command
    expect(parseSlashQuery('//')).toBeNull();
  });
});

describe('computeSlashPopup', () => {
  it('is closed when the text is not a slash command', () => {
    const state = computeSlashPopup('hello', COMMANDS, SKILLS);
    expect(state.open).toBe(false);
    expect(state.entries).toEqual([]);
  });

  it('lists all commands and skills for a bare slash', () => {
    const state = computeSlashPopup('/', COMMANDS, SKILLS);
    expect(state.open).toBe(true);
    expect(state.entries.filter((e) => e.kind === 'command')).toHaveLength(COMMANDS.length);
    expect(state.entries.filter((e) => e.kind === 'skill')).toHaveLength(SKILLS.length);
    expect(state.emptyCatalog).toBe(false);
  });

  it('orders commands before skills', () => {
    const state = computeSlashPopup('/c', COMMANDS, SKILLS);
    const firstSkill = state.entries.findIndex((e) => e.kind === 'skill');
    const lastCommand = state.entries.map((e) => e.kind).lastIndexOf('command');
    expect(lastCommand).toBeLessThan(firstSkill);
  });

  it('filters case-insensitively by the typed query', () => {
    const state = computeSlashPopup('/co', COMMANDS, SKILLS);
    const names = state.entries.map((e) => e.name);
    expect(names).toContain('code-review');
    expect(names).toContain('compact');
    expect(names).toContain('context');
    expect(names).not.toContain('init');
  });

  it('ranks prefix matches above mid-string matches', () => {
    // "re" prefixes nothing in commands but is mid-string in "code-review";
    // among skills "deep-research" contains "re" mid-string. Use a clearer case:
    const state = computeSlashPopup('/in', ['init', 'reindex'], []);
    expect(state.entries[0]?.name).toBe('init'); // prefix beats "reindex"
  });

  it('closes on a no-match query when the catalog is populated', () => {
    const state = computeSlashPopup('/zzz', COMMANDS, SKILLS);
    expect(state.open).toBe(false);
    expect(state.entries).toEqual([]);
  });

  it('filters skills by the typed prefix too, not just commands', () => {
    // "ef" prefixes the "efeitos-web" skill and appears in no command, so the
    // popup surfaces exactly that one skill and zero commands.
    const state = computeSlashPopup('/ef', COMMANDS, SKILLS);
    const skillNames = state.entries.filter((e) => e.kind === 'skill').map((e) => e.name);
    expect(skillNames).toEqual(['efeitos-web']);
    expect(state.entries.some((e) => e.kind === 'command')).toBe(false);
  });

  it('matches the same prefix across both commands and skills', () => {
    // "c" prefixes several commands and the "createmd" skill.
    const state = computeSlashPopup('/c', COMMANDS, SKILLS);
    const names = state.entries.map((e) => e.name);
    expect(names).toContain('clear');
    expect(names).toContain('compact');
    expect(names).toContain('createmd');
    // "init" / "efeitos-web" share no "c" prefix-or-substring and are excluded.
    expect(names).not.toContain('init');
    expect(names).not.toContain('efeitos-web');
  });

  it('falls back to built-ins and flags emptyCatalog before the first turn', () => {
    const state = computeSlashPopup('/', [], []);
    expect(state.emptyCatalog).toBe(true);
    expect(state.open).toBe(true);
    expect(state.entries.map((e) => e.name)).toEqual([...BUILTIN_SLASH_COMMANDS].sort());
  });

  it('stays open (for the hint) even with a no-match query when catalog is empty', () => {
    const state = computeSlashPopup('/zzz', [], []);
    expect(state.emptyCatalog).toBe(true);
    expect(state.open).toBe(true);
    expect(state.entries).toEqual([]);
  });
});

describe('clampIndex', () => {
  it('wraps around both ends', () => {
    expect(clampIndex(0, 3)).toBe(0);
    expect(clampIndex(3, 3)).toBe(0);
    expect(clampIndex(-1, 3)).toBe(2);
    expect(clampIndex(4, 3)).toBe(1);
  });

  it('is safe for an empty list', () => {
    expect(clampIndex(5, 0)).toBe(0);
  });
});

describe('completeSlash', () => {
  it('completes a command to /<name> with a trailing space', () => {
    expect(completeSlash({ kind: 'command', name: 'code-review' })).toBe('/code-review ');
  });

  it('completes a skill the same way', () => {
    expect(completeSlash({ kind: 'skill', name: 'createmd' })).toBe('/createmd ');
  });
});
