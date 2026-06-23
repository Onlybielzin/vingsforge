import { describe, expect, it } from 'vitest';
import { parseBehindCount } from './updater.js';

/**
 * Unit tests for the `git rev-list --count HEAD..@{u}` "behind" parser. The pure
 * function is exercised directly with captured-style fixtures; no real git
 * process is spawned and no network is touched.
 */
describe('parseBehindCount', () => {
  it('parses a plain integer line', () => {
    expect(parseBehindCount('5')).toBe(5);
  });

  it('treats a zero count as up to date', () => {
    expect(parseBehindCount('0')).toBe(0);
  });

  it('trims surrounding whitespace and a trailing newline', () => {
    expect(parseBehindCount('  3\n')).toBe(3);
    expect(parseBehindCount('12\n')).toBe(12);
  });

  it('handles a CRLF line ending from git', () => {
    expect(parseBehindCount('7\r\n')).toBe(7);
  });

  it('collapses an empty / blank probe to 0', () => {
    expect(parseBehindCount('')).toBe(0);
    expect(parseBehindCount('   ')).toBe(0);
    expect(parseBehindCount('\n')).toBe(0);
  });

  it('collapses non-numeric noise to 0', () => {
    expect(parseBehindCount('not-a-number')).toBe(0);
    expect(parseBehindCount('NaN')).toBe(0);
  });

  it('rejects a negative count (never a real rev-list output) as 0', () => {
    expect(parseBehindCount('-1')).toBe(0);
  });

  it('parses the leading integer of a multi-token line', () => {
    // parseInt stops at the first non-digit, mirroring the real `.trim()` input.
    expect(parseBehindCount('42 commits')).toBe(42);
  });

  it('parses large counts', () => {
    expect(parseBehindCount('1024')).toBe(1024);
  });
});
