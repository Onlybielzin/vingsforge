/**
 * Project + workspace model. Spec 01 §3.
 */
import type { IsoDateString, ModelId } from './common.js';
import type { PermissionPolicy } from './permissions.js';

export type WorkspaceRef =
  | { kind: 'local'; path: string }
  | { kind: 'remote'; runtimeId: string; path: string };

export interface Project {
  id: string;
  name: string;
  workspace: WorkspaceRef;
  /** Default runtime: 'local' or a RemoteRuntime id. */
  runtimeId: string | 'local';
  defaultModel?: ModelId;
  /** Project instructions injected into the system prompt (Spec 01 RF-06/07). */
  systemPromptExtra?: string;
  permissionPolicy?: PermissionPolicy;
  createdAt: IsoDateString;
  lastOpenedAt?: IsoDateString;
}
