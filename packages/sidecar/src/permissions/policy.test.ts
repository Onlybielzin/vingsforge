import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PermissionPolicy } from '@vingsforge/shared';
import { resolveDecision, maybeAskPermission, rememberAllow } from './policy.js';
import { Workspace } from '../tools/workspace.js';

const base: PermissionPolicy = {
  defaults: { read_file: 'allow', write_file: 'ask', edit_file: 'ask', bash: 'ask' },
};

describe('resolveDecision precedence', () => {
  it('rule beats remembered and default', () => {
    const policy: PermissionPolicy = {
      ...base,
      rememberedAllows: ['bash'],
      rules: [{ tool: 'bash', match: { commandRegex: '^rm ' }, decision: 'deny' }],
    };
    expect(resolveDecision(policy, 'bash', { command: 'rm -rf /' })).toBe('deny');
    expect(resolveDecision(policy, 'bash', { command: 'ls' })).toBe('allow'); // remembered
  });

  it('remembered beats tool default', () => {
    const policy = { ...base, rememberedAllows: ['write_file'] };
    expect(resolveDecision(policy, 'write_file')).toBe('allow');
  });

  it('falls back to global default ask', () => {
    expect(resolveDecision({ defaults: {} }, 'unknown_tool')).toBe('ask');
  });

  it('pathGlob rule matches', () => {
    const policy: PermissionPolicy = {
      ...base,
      rules: [{ tool: 'write_file', match: { pathGlob: 'src/**' }, decision: 'allow' }],
    };
    expect(resolveDecision(policy, 'write_file', { path: 'src/a/b.ts' })).toBe('allow');
    expect(resolveDecision(policy, 'write_file', { path: 'dist/x.ts' })).toBe('ask');
  });

  it('canonicalizes path before matching so deny rules cannot be bypassed', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    const ws = new Workspace(root);
    const policy: PermissionPolicy = {
      ...base,
      rules: [{ tool: 'write_file', match: { pathGlob: '.env' }, decision: 'deny' }],
    };
    // Every equivalent spelling must canonicalize to `.env` and hit the deny rule.
    for (const raw of ['.env', './.env', 'sub/../.env', join(root, '.env')]) {
      expect(resolveDecision(policy, 'write_file', { path: raw }, {}, ws)).toBe('deny');
    }
    // A genuinely different path is unaffected.
    expect(resolveDecision(policy, 'write_file', { path: 'src/.env' }, {}, ws)).toBe('ask');
  });
});

describe('quick modes', () => {
  it('read-only forces writes to deny (overrides rules)', () => {
    const policy: PermissionPolicy = {
      ...base,
      rules: [{ tool: 'bash', decision: 'allow' }],
    };
    expect(resolveDecision(policy, 'bash', {}, { readOnly: true })).toBe('deny');
  });
  it('auto-approve turns ask into allow', () => {
    expect(resolveDecision(base, 'write_file', {}, { autoApprove: true })).toBe('allow');
  });
});

describe('maybeAskPermission', () => {
  const args = { policy: base, chatId: 'c1', callId: 't1', input: {} };

  it('read-only tools auto-allow', () => {
    expect(maybeAskPermission({ ...args, tool: 'read_file' }).kind).toBe('allow');
  });
  it('emits tool.permission for ask', () => {
    const out = maybeAskPermission({ ...args, tool: 'bash', input: { command: 'ls' } });
    expect(out.kind).toBe('ask');
    if (out.kind === 'ask') {
      expect(out.event).toEqual({
        type: 'tool.permission',
        chatId: 'c1',
        callId: 't1',
        tool: 'bash',
        input: { command: 'ls' },
      });
    }
  });
  it('deny in read-only carries a reason', () => {
    const out = maybeAskPermission({ ...args, tool: 'bash', modes: { readOnly: true } });
    expect(out.kind).toBe('deny');
    if (out.kind === 'deny') expect(out.reason).toMatch(/read-only/);
  });
});

describe('rememberAllow', () => {
  it('adds the tool idempotently', () => {
    const p1 = rememberAllow(base, 'bash');
    const p2 = rememberAllow(p1, 'bash');
    expect(p1.rememberedAllows).toEqual(['bash']);
    expect(p2.rememberedAllows).toEqual(['bash']);
  });
});
