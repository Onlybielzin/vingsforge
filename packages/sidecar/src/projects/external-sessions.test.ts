/**
 * Unit tests for the PURE external-session helpers: directory encoding, transcript
 * preview parsing, and NDJSON -> block mapping. No filesystem, no CLI.
 */
import { describe, expect, it } from 'vitest';
import {
  encodeProjectDir,
  isSessionId,
  jsonlToBlocks,
  parseSessionPreview,
} from './external-sessions.js';

/** Serialize objects to NDJSON lines like the CLI writes them. */
function ndjson(...objs: object[]): string[] {
  return objs.map((o) => JSON.stringify(o));
}

describe('encodeProjectDir', () => {
  it('replaces every non-alphanumeric char with a dash', () => {
    expect(encodeProjectDir('/home/vings/ereemby/apistoreV2')).toBe(
      '-home-vings-ereemby-apistoreV2',
    );
  });

  it('treats accents/spaces as single non-alnum chars (one dash each)', () => {
    expect(encodeProjectDir('/home/vings/Área de trabalho/projetos/claude tools')).toBe(
      '-home-vings--rea-de-trabalho-projetos-claude-tools',
    );
  });
});

describe('isSessionId', () => {
  it('accepts a 36-char UUID-shaped id', () => {
    expect(isSessionId('11111111-1111-4111-8111-111111111111')).toBe(true);
  });
  it('rejects path-traversal / wrong-length ids', () => {
    expect(isSessionId('../etc/passwd')).toBe(false);
    expect(isSessionId('short')).toBe(false);
    expect(isSessionId('11111111-1111-4111-8111-111111111111.jsonl')).toBe(false);
  });
});

describe('parseSessionPreview', () => {
  it('takes the FIRST user text, counts turns, and reads cwd', () => {
    const lines = ndjson(
      { type: 'system', mode: 'default', sessionId: 'x' },
      {
        type: 'user',
        cwd: '/home/vings/proj',
        message: { role: 'user', content: [{ type: 'text', text: '  Fix   the   bug\n' }] },
      },
      {
        type: 'assistant',
        cwd: '/home/vings/proj',
        message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] },
      },
      {
        type: 'user',
        cwd: '/home/vings/proj',
        message: { role: 'user', content: [{ type: 'text', text: 'Second message' }] },
      },
    );
    const out = parseSessionPreview(lines);
    expect(out.preview).toBe('Fix the bug');
    expect(out.turns).toBe(3);
    expect(out.cwd).toBe('/home/vings/proj');
  });

  it('skips malformed lines without throwing', () => {
    const lines = [
      'not json at all',
      '{ broken',
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'plain string content' },
      }),
    ];
    const out = parseSessionPreview(lines);
    expect(out.preview).toBe('plain string content');
    expect(out.turns).toBe(1);
    expect(out.cwd).toBeUndefined();
  });

  it('returns an empty preview when there is no user text', () => {
    const lines = ndjson({ type: 'system', subtype: 'init', session_id: 'x' });
    expect(parseSessionPreview(lines)).toEqual({ preview: '', turns: 0 });
  });
});

describe('jsonlToBlocks', () => {
  it('maps user/assistant text, tool_use and tool_result; drops the rest', () => {
    const lines = ndjson(
      { type: 'system', subtype: 'init', session_id: 'x' },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Read the file' }] },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'dropped on import' },
            { type: 'text', text: 'Reading now' },
            { type: 'tool_use', id: 't-1', name: 'read_file', input: { path: 'a.ts' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't-1', content: 'ok', is_error: false }],
        },
      },
      // A turn that maps to nothing is dropped entirely.
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] } },
    );

    expect(jsonlToBlocks(lines)).toEqual([
      { role: 'user', blocks: [{ kind: 'text', text: 'Read the file' }] },
      {
        role: 'assistant',
        blocks: [
          { kind: 'text', text: 'Reading now' },
          { kind: 'tool_use', callId: 't-1', tool: 'read_file', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'user',
        blocks: [{ kind: 'tool_result', callId: 't-1', output: 'ok', isError: false }],
      },
    ]);
  });

  it('ignores malformed lines and non-message rows', () => {
    const lines = [
      'garbage',
      JSON.stringify({ type: 'summary', summary: 'noop' }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'string content' },
      }),
    ];
    expect(jsonlToBlocks(lines)).toEqual([
      { role: 'assistant', blocks: [{ kind: 'text', text: 'string content' }] },
    ]);
  });
});
