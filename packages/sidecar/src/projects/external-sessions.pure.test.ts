/**
 * Additional PURE unit tests for the external-session helpers. Like the sibling
 * `external-sessions.test.ts`, these touch NO filesystem, NO network and NO real
 * `~/.claude` — every input is a string or fixture built in-process. They widen
 * coverage on: directory encoding (accents/spaces/edge paths), session-id UUID
 * validation (rejecting non-UUID input), NDJSON preview parsing, and the
 * NDJSON -> Block mapping (user/assistant/tool_use/tool_result, unknown dropped).
 */
import { describe, expect, it } from 'vitest';
import {
  encodeProjectDir,
  isSessionId,
  jsonlToBlocks,
  parseSessionPreview,
  type PartialImportedMessage,
} from './external-sessions.js';

/** Serialize objects to NDJSON lines exactly as the CLI writes them. */
function ndjson(...objs: object[]): string[] {
  return objs.map((o) => JSON.stringify(o));
}

describe('encodeProjectDir (fixtures)', () => {
  // Each fixture is [absolute cwd, expected on-disk folder name]. The rule is:
  // every char that is NOT [A-Za-z0-9] -> '-' (slashes, spaces, accents alike).
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['/home/vings/ereemby/apistoreV2', '-home-vings-ereemby-apistoreV2'],
    // Accents collapse to one dash each (multibyte glyph counts as one non-alnum).
    [
      '/home/vings/Área de trabalho/projetos/claude tools',
      '-home-vings--rea-de-trabalho-projetos-claude-tools',
    ],
    // Spaces are non-alnum -> one dash each; runs of separators stay 1:1.
    ['/a b  c', '-a-b--c'],
    // Trailing slash -> trailing dash; digits and case are preserved verbatim.
    ['/Foo/Bar123/', '-Foo-Bar123-'],
    // Dots, underscores, hyphens are all non-alnum and become dashes too.
    ['/home/u/my_proj.v1-x', '-home-u-my-proj-v1-x'],
    // A bare relative-ish single segment with no separators is unchanged.
    ['plainname', 'plainname'],
    // Empty string encodes to empty string (no chars to replace).
    ['', ''],
    // Cyrillic / CJK are non-alnum to this ASCII rule -> one dash per code unit.
    ['/проект', '-------'],
  ];

  for (const [input, expected] of cases) {
    it(`encodes ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(encodeProjectDir(input)).toBe(expected);
    });
  }

  it('only ever emits [A-Za-z0-9-] characters', () => {
    const encoded = encodeProjectDir('/home/vings/Área de trabalho/x.y_z!');
    expect(encoded).toMatch(/^[A-Za-z0-9-]*$/);
  });

  it('is idempotent on an already-encoded name (dashes stay dashes)', () => {
    const once = encodeProjectDir('/home/vings/claude tools');
    expect(encodeProjectDir(once)).toBe(once);
  });
});

describe('isSessionId (UUID validation rejects non-UUID)', () => {
  it('accepts canonical 36-char UUID-shaped ids', () => {
    expect(isSessionId('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isSessionId('abcdef01-2345-6789-abcd-ef0123456789')).toBe(true);
    expect(isSessionId('ABCDEF01-2345-6789-ABCD-EF0123456789')).toBe(true);
  });

  it('rejects non-UUID strings (wrong length, junk, path traversal, injection)', () => {
    const rejected = [
      '', // empty
      'short',
      'not-a-uuid',
      '11111111-1111-4111-8111-11111111111', // 35 chars (one too short)
      '11111111-1111-4111-8111-1111111111111', // 37 chars (one too long)
      '11111111-1111-4111-8111-111111111111.jsonl', // filename suffix
      '../etc/passwd', // path traversal
      '../../../../11111111-1111-4111-8111-111111111111',
      'gggggggg-gggg-gggg-gggg-gggggggggggg', // non-hex letters
      '11111111_1111_4111_8111_111111111111', // wrong separators
      'session id with spaces',
    ];
    for (const id of rejected) {
      expect(isSessionId(id), `expected ${JSON.stringify(id)} to be rejected`).toBe(false);
    }
  });

  it('rejects ids with a leading/trailing newline (anchored regex)', () => {
    expect(isSessionId('\n11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(isSessionId('11111111-1111-4111-8111-111111111111\n')).toBe(false);
  });
});

describe('parseSessionPreview (NDJSON -> preview/turns/cwd)', () => {
  it('takes the FIRST user text, collapses whitespace, counts every turn, reads cwd', () => {
    const lines = ndjson(
      { type: 'system', subtype: 'init', sessionId: 's-1' }, // not a turn
      {
        type: 'user',
        cwd: '/home/vings/Área de trabalho/proj',
        message: { role: 'user', content: [{ type: 'text', text: '  Olá   mundo \n\t corrige ' }] },
      },
      {
        type: 'assistant',
        cwd: '/home/vings/Área de trabalho/proj',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Claro.' }] },
      },
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'segunda mensagem' }] },
      },
    );
    const out = parseSessionPreview(lines);
    expect(out.preview).toBe('Olá mundo corrige');
    expect(out.turns).toBe(3);
    expect(out.cwd).toBe('/home/vings/Área de trabalho/proj');
  });

  it('reads preview from a plain-string message.content (not just block arrays)', () => {
    const lines = ndjson({
      type: 'user',
      cwd: '/w',
      message: { role: 'user', content: 'plain string content' },
    });
    const out = parseSessionPreview(lines);
    expect(out.preview).toBe('plain string content');
    expect(out.turns).toBe(1);
    expect(out.cwd).toBe('/w');
  });

  it('clamps an overlong preview to <=200 chars + ellipsis', () => {
    const long = 'x'.repeat(500);
    const out = parseSessionPreview(
      ndjson({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: long }] } }),
    );
    expect(out.preview.endsWith('…')).toBe(true);
    // 200 sliced chars + the single ellipsis glyph.
    expect([...out.preview].length).toBe(201);
  });

  it('skips malformed/blank lines without throwing and ignores leading non-text', () => {
    const lines = [
      '', // blank
      '   ', // whitespace only
      'not json at all',
      '{ broken json',
      'null', // valid JSON but not an object
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'assistant first, ignored for preview' }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'first real user line' }] } }),
    ];
    const out = parseSessionPreview(lines);
    expect(out.preview).toBe('first real user line');
    expect(out.turns).toBe(2); // the assistant + user lines
    expect(out.cwd).toBeUndefined();
  });

  it('returns an empty, cwd-less preview when no user/assistant turns exist', () => {
    const lines = ndjson(
      { type: 'system', subtype: 'init' },
      { type: 'summary', summary: 'noop' },
    );
    expect(parseSessionPreview(lines)).toEqual({ preview: '', turns: 0 });
  });
});

describe('jsonlToBlocks (maps known kinds, ignores unknown)', () => {
  it('maps user/assistant text, tool_use, tool_result and drops thinking/unknown/empty', () => {
    const lines = ndjson(
      { type: 'system', subtype: 'init', session_id: 'x' }, // dropped: not a turn
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Read the file' }] },
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'dropped on import' }, // unknown -> dropped
            { type: 'text', text: 'Reading now' },
            { type: 'redacted_thinking', data: 'zz' }, // unknown -> dropped
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
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_result', tool_use_id: 't-2', content: 'boom', is_error: true }],
        },
      },
      // Turn that maps to zero blocks -> the whole message is dropped.
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] } },
      // user/assistant line with NO message field -> dropped.
      { type: 'user', cwd: '/w' },
    );

    const expected: PartialImportedMessage[] = [
      { role: 'user', blocks: [{ kind: 'text', text: 'Read the file' }] },
      {
        role: 'assistant',
        blocks: [
          { kind: 'text', text: 'Reading now' },
          { kind: 'tool_use', callId: 't-1', tool: 'read_file', input: { path: 'a.ts' } },
        ],
      },
      { role: 'user', blocks: [{ kind: 'tool_result', callId: 't-1', output: 'ok', isError: false }] },
      { role: 'assistant', blocks: [{ kind: 'tool_result', callId: 't-2', output: 'boom', isError: true }] },
    ];
    expect(jsonlToBlocks(lines)).toEqual(expected);
  });

  it('maps a plain-string message.content into a single text block', () => {
    const lines = ndjson({
      type: 'assistant',
      message: { role: 'assistant', content: 'string content' },
    });
    expect(jsonlToBlocks(lines)).toEqual([
      { role: 'assistant', blocks: [{ kind: 'text', text: 'string content' }] },
    ]);
  });

  it('drops malformed lines, empty-string content, and partial blocks', () => {
    const lines = [
      'garbage',
      '{ not closed',
      JSON.stringify({ type: 'summary', summary: 'noop' }), // not a turn
      JSON.stringify({ type: 'user', message: { role: 'user', content: '' } }), // empty -> no block
      // tool_use missing required `name` -> not mapped, message becomes empty -> dropped.
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'only-id' }] } }),
      // tool_result missing `tool_use_id` -> not mapped, dropped.
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'orphan' }] } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'kept' }] } }),
    ];
    expect(jsonlToBlocks(lines)).toEqual([
      { role: 'assistant', blocks: [{ kind: 'text', text: 'kept' }] },
    ]);
  });

  it('defaults isError to false when is_error is absent or non-boolean', () => {
    const lines = ndjson({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't-9', content: 'r' }],
      },
    });
    expect(jsonlToBlocks(lines)).toEqual([
      { role: 'user', blocks: [{ kind: 'tool_result', callId: 't-9', output: 'r', isError: false }] },
    ]);
  });
});
