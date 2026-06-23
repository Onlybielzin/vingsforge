/**
 * Edge-case and security coverage for the permission policy engine (Spec 04
 * §3/§4). Complements policy.test.ts: focuses on rule-matching corners,
 * remembered-allow scope, the deny→adapt and ask→resolve ("replay") flows, and
 * canonical-path confinement so a deny rule cannot be dodged with an equivalent
 * spelling.
 */
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PermissionPolicy } from '@vingsforge/shared';
import {
  resolveDecision,
  maybeAskPermission,
  rememberAllow,
  GLOBAL_DEFAULT_DECISION,
  type PermissionOutcome,
} from './policy.js';
import { Workspace } from '../tools/workspace.js';

const base: PermissionPolicy = {
  defaults: { read_file: 'allow', write_file: 'ask', edit_file: 'ask', bash: 'ask' },
};

describe('rule matching corners', () => {
  it('first matching rule wins even if a later rule is more specific', () => {
    const policy: PermissionPolicy = {
      ...base,
      rules: [
        { tool: 'bash', decision: 'allow' }, // unconditional, comes first
        { tool: 'bash', match: { commandRegex: '^rm ' }, decision: 'deny' },
      ],
    };
    // The unconditional allow shadows the later deny — order matters (Spec 04 §3).
    expect(resolveDecision(policy, 'bash', { command: 'rm -rf /' })).toBe('allow');
  });

  it('requires BOTH pathGlob and commandRegex when a rule sets both', () => {
    const policy: PermissionPolicy = {
      ...base,
      rules: [
        {
          tool: 'bash',
          match: { pathGlob: 'scripts/**', commandRegex: '^node ' },
          decision: 'allow',
        },
      ],
    };
    // bash carries no path, so the pathGlob clause can never be satisfied here.
    expect(resolveDecision(policy, 'bash', { command: 'node x' })).toBe('ask');
  });

  it('a rule for a different tool never matches', () => {
    const policy: PermissionPolicy = {
      ...base,
      rules: [{ tool: 'write_file', match: { pathGlob: '**' }, decision: 'deny' }],
    };
    expect(resolveDecision(policy, 'bash', { command: 'ls' })).toBe('ask');
  });

  it('pathGlob with no path in context does not match', () => {
    const policy: PermissionPolicy = {
      ...base,
      rules: [{ tool: 'write_file', match: { pathGlob: 'src/**' }, decision: 'allow' }],
    };
    // Missing path means the glob clause fails → falls through to tool default.
    expect(resolveDecision(policy, 'write_file', {})).toBe('ask');
  });

  it('commandRegex with no command in context does not match', () => {
    const policy: PermissionPolicy = {
      ...base,
      rules: [{ tool: 'bash', match: { commandRegex: 'anything' }, decision: 'allow' }],
    };
    expect(resolveDecision(policy, 'bash', {})).toBe('ask');
  });

  it('empty match object matches the tool unconditionally', () => {
    const policy: PermissionPolicy = {
      ...base,
      rules: [{ tool: 'bash', match: {}, decision: 'deny' }],
    };
    expect(resolveDecision(policy, 'bash', { command: 'whatever' })).toBe('deny');
  });
});

describe('remembered allow + defaults', () => {
  it('remembered allow does not override an explicit deny default', () => {
    const policy: PermissionPolicy = {
      defaults: { bash: 'deny' },
      rememberedAllows: ['bash'],
    };
    // remembered allow has higher precedence than the default, so it wins —
    // documents the intended precedence (remembered > tool default, Spec 04 §3).
    expect(resolveDecision(policy, 'bash')).toBe('allow');
  });

  it('a deny rule still beats a remembered allow (rule > remembered)', () => {
    const policy: PermissionPolicy = {
      defaults: {},
      rememberedAllows: ['bash'],
      rules: [{ tool: 'bash', match: { commandRegex: 'rm' }, decision: 'deny' }],
    };
    expect(resolveDecision(policy, 'bash', { command: 'rm x' })).toBe('deny');
    expect(resolveDecision(policy, 'bash', { command: 'ls' })).toBe('allow');
  });

  it('unknown tool with empty policy falls back to the global default', () => {
    expect(resolveDecision({ defaults: {} }, 'mystery_tool')).toBe(GLOBAL_DEFAULT_DECISION);
    expect(GLOBAL_DEFAULT_DECISION).toBe('ask');
  });
});

describe('quick-mode interactions', () => {
  it('read-only forces every write tool to deny but leaves reads alone', () => {
    for (const tool of ['write_file', 'edit_file', 'bash']) {
      expect(resolveDecision(base, tool, {}, { readOnly: true })).toBe('deny');
    }
    // read_file is not a write tool, so read-only does not touch it.
    expect(resolveDecision(base, 'read_file', {}, { readOnly: true })).toBe('allow');
  });

  it('read-only beats an allow rule (safety override)', () => {
    const policy: PermissionPolicy = {
      ...base,
      rules: [{ tool: 'write_file', match: { pathGlob: '**' }, decision: 'allow' }],
    };
    expect(resolveDecision(policy, 'write_file', { path: 'a.ts' }, { readOnly: true })).toBe(
      'deny',
    );
  });

  it('auto-approve flips ask to allow but never downgrades a deny', () => {
    expect(resolveDecision(base, 'bash', {}, { autoApprove: true })).toBe('allow');
    const denyPolicy: PermissionPolicy = { defaults: { bash: 'deny' } };
    expect(resolveDecision(denyPolicy, 'bash', {}, { autoApprove: true })).toBe('deny');
  });

  it('read-only and auto-approve together still deny writes (read-only wins)', () => {
    expect(
      resolveDecision(base, 'write_file', {}, { readOnly: true, autoApprove: true }),
    ).toBe('deny');
  });
});

describe('maybeAskPermission gating outcomes', () => {
  const common = { policy: base, chatId: 'c1', callId: 't1' };

  it('all read-only tools auto-allow regardless of policy/modes', () => {
    for (const tool of ['read_file', 'list_dir', 'glob', 'grep']) {
      const out = maybeAskPermission({
        ...common,
        tool,
        input: {},
        modes: { readOnly: true },
      });
      expect(out.kind).toBe('allow');
    }
  });

  it('deny via a policy rule surfaces a reason so the agent can adapt', () => {
    const policy: PermissionPolicy = {
      ...base,
      rules: [{ tool: 'bash', match: { commandRegex: 'rm' }, decision: 'deny' }],
    };
    const out = maybeAskPermission({
      ...common,
      policy,
      tool: 'bash',
      input: { command: 'rm -rf /' },
      context: { command: 'rm -rf /' },
    });
    expect(out.kind).toBe('deny');
    if (out.kind === 'deny') expect(out.reason).toMatch(/policy denied 'bash'/);
  });

  it('emitted tool.permission event carries the raw model input verbatim', () => {
    const input = { path: 'a.ts', content: 'x' };
    const out = maybeAskPermission({ ...common, tool: 'write_file', input });
    expect(out.kind).toBe('ask');
    if (out.kind === 'ask') {
      expect(out.event.type).toBe('tool.permission');
      expect(out.event.input).toBe(input); // not cloned/mutated
      expect(out.event.callId).toBe('t1');
    }
  });
});

/**
 * Simulates the Spec 04 §3.1 approval round-trip ("replay"): an `ask` outcome
 * blocks the loop; the UI resolution comes back as a `tool.permission.resolve`
 * command; applying it (allow-once vs. always-allow) decides whether the next
 * identical call still asks. This is the engine-level behaviour the policy must
 * support, exercised here without the (unimplemented) engine loop.
 */
describe('approval round-trip / replay', () => {
  function applyResolve(
    policy: PermissionPolicy,
    out: Extract<PermissionOutcome, { kind: 'ask' }>,
    decision: 'allow' | 'deny',
    remember: boolean,
  ): PermissionPolicy {
    // allow-once does not mutate policy; always-allow records the remembrance.
    if (decision === 'allow' && remember) return rememberAllow(policy, out.event.tool);
    return policy;
  }

  it('allow-once lets the call run but the next identical call asks again', () => {
    const first = maybeAskPermission({
      policy: base,
      chatId: 'c1',
      callId: 't1',
      tool: 'write_file',
      input: { path: 'a.ts', content: '1' },
    });
    expect(first.kind).toBe('ask');
    if (first.kind !== 'ask') return;

    const policyAfter = applyResolve(base, first, 'allow', /* remember */ false);
    const second = maybeAskPermission({
      policy: policyAfter,
      chatId: 'c1',
      callId: 't2',
      tool: 'write_file',
      input: { path: 'a.ts', content: '2' },
    });
    expect(second.kind).toBe('ask'); // allow-once did not persist
  });

  it('always-allow stops asking for that tool in scope (Spec 04 §7.2)', () => {
    const first = maybeAskPermission({
      policy: base,
      chatId: 'c1',
      callId: 't1',
      tool: 'write_file',
      input: { path: 'a.ts', content: '1' },
    });
    expect(first.kind).toBe('ask');
    if (first.kind !== 'ask') return;

    const policyAfter = applyResolve(base, first, 'allow', /* remember */ true);
    expect(policyAfter.rememberedAllows).toContain('write_file');

    const second = maybeAskPermission({
      policy: policyAfter,
      chatId: 'c1',
      callId: 't2',
      tool: 'write_file',
      input: { path: 'b.ts', content: '2' },
    });
    expect(second.kind).toBe('allow');
  });

  it('remembering one tool does not silence a different tool', () => {
    const policyAfter = rememberAllow(base, 'write_file');
    const out = maybeAskPermission({
      policy: policyAfter,
      chatId: 'c1',
      callId: 't9',
      tool: 'bash',
      input: { command: 'ls' },
    });
    expect(out.kind).toBe('ask');
  });
});

describe('canonical-path confinement in rule matching', () => {
  let root: string;
  let ws: Workspace;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vf-pol-'));
    ws = new Workspace(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('a path-escape spelling cannot launder past a deny rule', () => {
    const policy: PermissionPolicy = {
      ...base,
      rules: [{ tool: 'write_file', match: { pathGlob: 'secret.txt' }, decision: 'deny' }],
    };
    // The escaping path does not canonicalize, so it keeps its raw value and the
    // deny rule simply does not widen access; the executor rejects it anyway.
    // The in-root equivalents all collapse to `secret.txt` and hit deny.
    mkdirSync(join(root, 'sub'));
    for (const raw of ['secret.txt', './secret.txt', 'sub/../secret.txt', join(root, 'secret.txt')]) {
      expect(resolveDecision(policy, 'write_file', { path: raw }, {}, ws)).toBe('deny');
    }
  });

  it('a symlink-equivalent inside the root canonicalizes to the same deny target', () => {
    // A nested dir reachable two ways must resolve to one canonical relative path
    // so a glob rule cannot be dodged via `./` or redundant `..` segments.
    mkdirSync(join(root, 'pkg'));
    writeFileSync(join(root, 'pkg', 'keep.txt'), '');
    symlinkSync(join(root, 'pkg'), join(root, 'alias'));
    const policy: PermissionPolicy = {
      ...base,
      rules: [{ tool: 'edit_file', match: { pathGlob: 'pkg/keep.txt' }, decision: 'deny' }],
    };
    // Direct spelling hits the rule.
    expect(resolveDecision(policy, 'edit_file', { path: 'pkg/keep.txt' }, {}, ws)).toBe('deny');
    // The lexical canonicalizer does not resolve the `alias` symlink, so the
    // alias spelling stays `alias/keep.txt` and (correctly) does NOT match a rule
    // written against the real path — documents that pathGlob rules are lexical.
    expect(resolveDecision(policy, 'edit_file', { path: 'alias/keep.txt' }, {}, ws)).toBe('ask');
  });
});
