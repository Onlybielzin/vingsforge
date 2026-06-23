/**
 * Zod schemas validating repository inputs and the JSON-serialized columns
 * (blocks, usage, permission policy, ssh/daemon). Mirrors @vingsforge/shared types (Spec 08 §3/§4).
 *
 * Note: schemas are left to Zod's inference rather than annotated with the shared
 * interfaces, because `exactOptionalPropertyTypes` makes Zod's `?` outputs (which
 * include `| undefined`) structurally incompatible with `prop?: T` targets. Validation
 * behaviour is identical; consumers cast via the typed row mappers.
 */
import { z } from 'zod';

const iso = z.string().min(1);

/** Content blocks — faithful serialization for replay (Spec 08 §4). */
export const blockSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({
    kind: z.literal('thinking'),
    text: z.string(),
    signature: z.string().optional(),
  }),
  z.object({
    kind: z.literal('tool_use'),
    callId: z.string(),
    tool: z.string(),
    input: z.unknown(),
  }),
  z.object({
    kind: z.literal('tool_result'),
    callId: z.string(),
    output: z.unknown(),
    isError: z.boolean(),
  }),
]);

export const blocksSchema = z.array(blockSchema);

export const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheCreationInputTokens: z.number().optional(),
  cacheReadInputTokens: z.number().optional(),
  estimatedCostUsd: z.number().optional(),
});

const decisionSchema = z.enum(['allow', 'ask', 'deny']);

export const permissionPolicySchema = z.object({
  defaults: z.record(z.string(), decisionSchema),
  rules: z
    .array(
      z.object({
        tool: z.string(),
        match: z
          .object({
            pathGlob: z.string().optional(),
            commandRegex: z.string().optional(),
          })
          .optional(),
        decision: decisionSchema,
      }),
    )
    .optional(),
  rememberedAllows: z.array(z.string()).optional(),
});

export const workspaceRefSchema = z.union([
  z.object({ kind: z.literal('local'), path: z.string() }),
  z.object({
    kind: z.literal('remote'),
    runtimeId: z.string(),
    path: z.string(),
  }),
]);

export const sshSchema = z.object({
  host: z.string(),
  port: z.number(),
  user: z.string(),
  keyPath: z.string().optional(),
  /** TOFU-pinned VPS host-key fingerprint (Spec 05 §2). */
  hostFingerprint: z.string().optional(),
});

export const daemonSchema = z.object({
  installPath: z.string(),
  version: z.string().optional(),
});

/** Full domain entities (used when reconstructing rows on read). */
export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  workspace: workspaceRefSchema,
  runtimeId: z.string(),
  defaultModel: z.string().optional(),
  systemPromptExtra: z.string().optional(),
  permissionPolicy: permissionPolicySchema.optional(),
  createdAt: iso,
  lastOpenedAt: iso.optional(),
});

export const chatSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  modelOverride: z.string().optional(),
  runtimeOverride: z.string().optional(),
  createdAt: iso,
  updatedAt: iso,
  archived: z.boolean(),
});

export const chatMessageSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  role: z.enum(['user', 'assistant']),
  blocks: blocksSchema,
  usage: usageSchema.optional(),
  model: z.string().optional(),
  createdAt: iso,
});
