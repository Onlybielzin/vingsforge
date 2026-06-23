/**
 * Permission policy engine (Spec 04 §3). Resolves a Decision with precedence
 * rule > remembered allow > tool default > global default, and exposes
 * `maybeAskPermission`, which emits a `tool.permission` event when gating.
 */
import type {
  Decision,
  EngineEvent,
  PermissionModes,
  PermissionPolicy,
} from '@vingsforge/shared';
import { globToRegExp } from '../tools/executors.js';
import { READ_ONLY_TOOLS } from '../tools/schemas.js';
import type { Workspace } from '../tools/workspace.js';

/** Global fallback when neither rules, remembrances nor tool defaults decide. */
export const GLOBAL_DEFAULT_DECISION: Decision = 'ask';

/** Quick modes from Spec 04 §3.2 (canonical type lives in @vingsforge/shared). */
export type { PermissionModes };

/** The minimal slice of tool input the policy inspects when matching rules. */
export interface PermissionContext {
  /**
   * Canonical workspace-relative path (POSIX, no `.`/`..`), when the tool
   * operates on a path. MUST be produced via `Workspace.canonicalRelative` so
   * that `pathGlob` rules match the same string the executor acts on; otherwise
   * equivalent spellings (`./.env`, `sub/../.env`, absolute-in-root) would slip
   * past a deny rule (Spec 04 §3/§4).
   */
  path?: string;
  /** The shell command, for bash rules. */
  command?: string;
}

/** Tools whose first/primary path input is gated by `pathGlob` rules. */
const PATH_TOOLS = new Set(['write_file', 'edit_file', 'read_file', 'list_dir', 'glob', 'grep']);

/**
 * Canonicalize the path inside a {@link PermissionContext} against `workspace`
 * so the policy match and the executor agree on one spelling. A path that
 * escapes the root canonicalizes to the {@link PathEscapeError} message's intent
 * by being left untouched — the executor rejects it independently, and a raw
 * non-canonical path can never accidentally satisfy a deny rule's negation.
 */
function canonicalizeContext(
  ctx: PermissionContext,
  workspace: Workspace | undefined,
): PermissionContext {
  if (workspace === undefined || ctx.path === undefined) return ctx;
  try {
    return { ...ctx, path: workspace.canonicalRelative(ctx.path) };
  } catch {
    // Escaping paths are rejected by the executor's resolveInput; keep the raw
    // value so a deny rule still has a chance to match, never widening access.
    return ctx;
  }
}

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'bash']);

/** Does a single rule apply to this tool + context? */
function ruleMatches(
  rule: PermissionPolicy['rules'] extends (infer R)[] | undefined ? R : never,
  tool: string,
  ctx: PermissionContext,
): boolean {
  if (rule.tool !== tool) return false;
  const m = rule.match;
  if (!m) return true;
  if (m.pathGlob !== undefined) {
    if (ctx.path === undefined || !globToRegExp(m.pathGlob).test(ctx.path)) return false;
  }
  if (m.commandRegex !== undefined) {
    if (ctx.command === undefined || !new RegExp(m.commandRegex).test(ctx.command)) return false;
  }
  return true;
}

/**
 * Resolve the effective decision for a tool call.
 *
 * Precedence (Spec 04 §3): specific rule > remembered allow > per-tool default
 * > global default. Quick modes wrap the result: read-only forces writes to
 * deny (highest priority — safety), auto-approve turns a resulting `ask` into
 * `allow`.
 */
export function resolveDecision(
  policy: PermissionPolicy,
  tool: string,
  ctx: PermissionContext = {},
  modes: PermissionModes = {},
  workspace?: Workspace,
): Decision {
  // Read-only mode is a hard safety override (Spec 04 §3.2 / §7.4).
  if (modes.readOnly && WRITE_TOOLS.has(tool)) return 'deny';

  // Canonicalize the path before any rule match so equivalent spellings
  // (`./.env`, `sub/../.env`, absolute-in-root) cannot bypass a deny rule.
  if (workspace !== undefined && PATH_TOOLS.has(tool)) {
    ctx = canonicalizeContext(ctx, workspace);
  }

  let decision: Decision | undefined;

  // 1. Specific rule (first match wins).
  for (const rule of policy.rules ?? []) {
    if (ruleMatches(rule, tool, ctx)) {
      decision = rule.decision;
      break;
    }
  }
  // 2. Remembered "always allow" for this scope.
  if (decision === undefined && (policy.rememberedAllows ?? []).includes(tool)) {
    decision = 'allow';
  }
  // 3. Per-tool default. 4. Global default.
  if (decision === undefined) {
    decision = policy.defaults[tool] ?? GLOBAL_DEFAULT_DECISION;
  }

  // Auto-approve flips a remaining `ask` to `allow` (does not override deny).
  if (decision === 'ask' && modes.autoApprove) return 'allow';
  return decision;
}

/** Outcome of {@link maybeAskPermission}. */
export type PermissionOutcome =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; event: Extract<EngineEvent, { type: 'tool.permission' }> };

/**
 * Decide whether a tool call may proceed.
 *
 * - `allow`: run it.
 * - `deny`: surface a tool_result error with `reason` so the agent can adapt
 *   (Spec 04 §3.1 step 4).
 * - `ask`: returns the `tool.permission` event the caller must emit before
 *   blocking the loop until a `tool.permission.resolve` arrives (Spec 04 §3.1).
 *
 * Read-only tools are never gated.
 */
export function maybeAskPermission(args: {
  policy: PermissionPolicy;
  chatId: string;
  callId: string;
  tool: string;
  input: unknown;
  context?: PermissionContext;
  modes?: PermissionModes;
  /**
   * Workspace used to canonicalize `context.path` before matching `pathGlob`
   * rules. Pass it whenever the tool operates on a path so a deny rule cannot be
   * dodged with an equivalent spelling (Spec 04 §3/§4). Optional only for
   * path-less tools (e.g. bash) and tests that pass a pre-canonicalized path.
   */
  workspace?: Workspace;
}): PermissionOutcome {
  const { policy, chatId, callId, tool, input, context = {}, modes = {}, workspace } = args;

  // Read-only tools (read_file/list_dir/glob/grep) auto-run (Spec 04 §2).
  if ((READ_ONLY_TOOLS as ReadonlySet<string>).has(tool)) {
    return { kind: 'allow' };
  }

  const decision = resolveDecision(policy, tool, context, modes, workspace);
  switch (decision) {
    case 'allow':
      return { kind: 'allow' };
    case 'deny':
      return {
        kind: 'deny',
        reason: modes.readOnly
          ? `read-only mode: '${tool}' is disabled`
          : `policy denied '${tool}'`,
      };
    case 'ask':
      return {
        kind: 'ask',
        event: { type: 'tool.permission', chatId, callId, tool, input },
      };
    default: {
      const exhaustive: never = decision;
      throw new Error(`unreachable decision ${String(exhaustive)}`);
    }
  }
}

/**
 * Apply a UI resolution to the policy, returning a new policy with the
 * remembered allow added when the user chose "always allow" (Spec 04 §3.1).
 */
export function rememberAllow(policy: PermissionPolicy, tool: string): PermissionPolicy {
  if ((policy.rememberedAllows ?? []).includes(tool)) return policy;
  return {
    ...policy,
    rememberedAllows: [...(policy.rememberedAllows ?? []), tool],
  };
}
