/**
 * Tests for the pure subagent helpers (telemetry parsing, output cleaning,
 * duration formatting). Pure module — no DOM — so it runs in the `node` test
 * environment alongside the rest of the suite.
 */
import { describe, expect, it } from 'vitest';
import {
  cleanSubagentOutput,
  formatDuration,
  isSubagentTool,
  outputToText,
  parseSubagentUsage,
} from './subagentUsage.js';

describe('isSubagentTool', () => {
  it('matches Agent and Task case-insensitively', () => {
    expect(isSubagentTool('Agent')).toBe(true);
    expect(isSubagentTool('agent')).toBe(true);
    expect(isSubagentTool('Task')).toBe(true);
    expect(isSubagentTool('TASK')).toBe(true);
    expect(isSubagentTool(' task ')).toBe(true);
  });

  it('rejects other tools', () => {
    expect(isSubagentTool('bash')).toBe(false);
    expect(isSubagentTool('read_file')).toBe(false);
    expect(isSubagentTool('')).toBe(false);
  });
});

describe('outputToText', () => {
  it('joins an array of text blocks', () => {
    expect(outputToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
  });

  it('handles strings, single blocks, content blocks and nullish', () => {
    expect(outputToText('hi')).toBe('hi');
    expect(outputToText({ text: 'x' })).toBe('x');
    expect(outputToText({ content: 'y' })).toBe('y');
    expect(outputToText(null)).toBe('');
    expect(outputToText(undefined)).toBe('');
  });
});

const USAGE_NL = '<usage>subagent_tokens: 10305\ntool_uses: 1\nduration_ms: 5440</usage>';

describe('parseSubagentUsage', () => {
  it('parses newline-separated fields', () => {
    expect(parseSubagentUsage(USAGE_NL)).toEqual({ tokens: 10305, tools: 1, durationMs: 5440 });
  });

  it('parses comma-separated fields', () => {
    const text = '<usage>subagent_tokens: 200, tool_uses: 3, duration_ms: 900</usage>';
    expect(parseSubagentUsage(text)).toEqual({ tokens: 200, tools: 3, durationMs: 900 });
  });

  it('tolerates missing fields', () => {
    expect(parseSubagentUsage('<usage>subagent_tokens: 5</usage>')).toEqual({ tokens: 5 });
    expect(parseSubagentUsage('<usage></usage>')).toEqual({});
  });

  it('returns null without a usage block', () => {
    expect(parseSubagentUsage('just some text')).toBeNull();
  });

  it('omits a field with a non-numeric value (undefined, never NaN)', () => {
    const result = parseSubagentUsage('<usage>subagent_tokens: abc, tool_uses: 4</usage>');
    // The garbage token field must be absent — not present as NaN.
    expect(result).toEqual({ tools: 4 });
    expect(result).not.toHaveProperty('tokens');
    expect(Number.isNaN((result as Record<string, number>).tokens)).toBe(false);
  });

  it('omits every field when all values are non-numeric', () => {
    const result = parseSubagentUsage('<usage>subagent_tokens: x, tool_uses: y, duration_ms: z</usage>');
    expect(result).toEqual({});
    for (const v of Object.values(result as Record<string, unknown>)) {
      expect(Number.isNaN(v as number)).toBe(false);
    }
  });

  it('finds the usage block embedded in surrounding text', () => {
    const text = `Done.\n\n${USAGE_NL}\nagentId: abc (use SendMessage with to: 'abc', summary: '...') to continue`;
    expect(parseSubagentUsage(text)).toEqual({ tokens: 10305, tools: 1, durationMs: 5440 });
  });

  it('stays linear on many unclosed <usage> openings (no ReDoS blowup)', () => {
    // Adversarial input: 100k opening tags with no closing tag. The old
    // lazy `[\s\S]*?` regex re-scanned the rest of the string from every
    // opening (O(n²) ≈ 15s here); the indexOf-based scan is linear.
    const adversarial = '<usage>'.repeat(100_000);
    const start = performance.now();
    expect(parseSubagentUsage(adversarial)).toBeNull();
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('stays linear when openings are interleaved with text', () => {
    const adversarial = `${'<usage> filler text '.repeat(100_000)}no close`;
    const start = performance.now();
    expect(parseSubagentUsage(adversarial)).toBeNull();
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('cleanSubagentOutput also stays linear on adversarial input', () => {
    const adversarial = `${'<usage> filler text '.repeat(100_000)}no close`;
    const start = performance.now();
    // No complete envelope, so nothing is stripped — but it must not hang.
    expect(cleanSubagentOutput(adversarial).length).toBeGreaterThan(0);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('cleanSubagentOutput', () => {
  it('removes the usage block and the agentId boilerplate line', () => {
    const text = [
      'The result is 42.',
      '',
      USAGE_NL,
      "agentId: abc-123 (use SendMessage with to: 'abc-123', summary: 'x') to continue this agent",
    ].join('\n');
    expect(cleanSubagentOutput(text)).toBe('The result is 42.');
  });

  it('leaves plain output untouched (trimmed)', () => {
    expect(cleanSubagentOutput('  hello world  ')).toBe('hello world');
  });

  it('collapses the gap left behind so no blank hole remains', () => {
    const text = `Line one.\n${USAGE_NL}\nLine two.`;
    expect(cleanSubagentOutput(text)).toBe('Line one.\n\nLine two.');
  });

  it('keeps prose that merely mentions agentId: mid-sentence', () => {
    const text = 'Here is how to read the agentId: call getAgentId() and store it.';
    expect(cleanSubagentOutput(text)).toBe(text);
  });

  it('keeps a code block that contains agentId:', () => {
    const text = ['```yaml', 'agentId: foo', 'name: bar', '```'].join('\n');
    expect(cleanSubagentOutput(text)).toBe(text);
  });

  it('keeps a leading agentId: line that is not the SendMessage boilerplate', () => {
    const text = 'Configure `agentId: foo` in your yaml to continue.';
    expect(cleanSubagentOutput(text)).toBe(text);
  });
});

describe('formatDuration', () => {
  it('formats sub-second durations (ms < 1000)', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(50)).toBe('0.1s');
    expect(formatDuration(450)).toBe('0.5s');
    expect(formatDuration(999)).toBe('1s');
  });

  it('formats whole-second durations', () => {
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(2500)).toBe('2.5s');
    expect(formatDuration(30000)).toBe('30s');
  });

  it('formats sub-minute durations with one decimal', () => {
    expect(formatDuration(5440)).toBe('5.4s');
    expect(formatDuration(800)).toBe('0.8s');
    expect(formatDuration(59900)).toBe('59.9s');
  });

  it('formats minute durations', () => {
    expect(formatDuration(65000)).toBe('1m5s');
    expect(formatDuration(60000)).toBe('1m');
    expect(formatDuration(125000)).toBe('2m5s');
  });

  it('guards against invalid input', () => {
    expect(formatDuration(-1)).toBe('0s');
    expect(formatDuration(NaN)).toBe('0s');
  });
});
