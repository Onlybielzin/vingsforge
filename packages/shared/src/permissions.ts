/**
 * Tool permission model. Spec 04 §3.
 */

export type Decision = 'allow' | 'ask' | 'deny';

export interface PermissionRule {
  tool: string;
  match?: {
    pathGlob?: string;
    commandRegex?: string;
  };
  decision: Decision;
}

export interface PermissionPolicy {
  /** Default decision per tool name. */
  defaults: Record<string, Decision>;
  /** Overrides matched by input pattern (higher precedence than defaults). */
  rules?: PermissionRule[];
  /** "Always allow" remembered for this session/project scope. */
  rememberedAllows?: string[];
}

/**
 * Quick permission modes from Spec 04 §3.2. Travels per turn from the app to a
 * remote daemon (Spec 05 §4/§5) so server-side gating mirrors the app's mode.
 */
export interface PermissionModes {
  /** Treat `ask` as `allow` (autonomous runs). */
  autoApprove?: boolean;
  /** Force write_file/edit_file/bash to `deny`. */
  readOnly?: boolean;
  /** Auto-approve file edits (write_file/edit_file); still `ask` for bash/commands. */
  acceptEdits?: boolean;
}

/**
 * High-level mode the user picks in the UI. Maps to {@link PermissionModes}.
 * - `plan`        — só lê e planeja; não edita nem executa (read-only).
 * - `default`     — pede aprovação a cada ação.
 * - `acceptEdits` — aprova edições de arquivo sozinho; pede para bash/comandos.
 * - `bypass`      — aprova tudo automaticamente.
 */
export type AgentMode = 'plan' | 'default' | 'acceptEdits' | 'bypass';

/** Translates the high-level UI mode into the per-turn {@link PermissionModes}. */
export function agentModeToModes(mode: AgentMode): PermissionModes {
  switch (mode) {
    case 'plan':
      return { readOnly: true };
    case 'acceptEdits':
      return { acceptEdits: true };
    case 'bypass':
      return { autoApprove: true };
    case 'default':
    default:
      return {};
  }
}

/** Names of the v1 built-in tools (Spec 04 §2). */
export type ToolName =
  | 'read_file'
  | 'list_dir'
  | 'glob'
  | 'grep'
  | 'write_file'
  | 'edit_file'
  | 'bash'
  | 'web_search';
