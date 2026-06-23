/**
 * Built-in tool schemas (Spec 04 §2.1). Zod validators for inputs plus stable
 * JSON Schemas sent to the model, exposed `orderedTools` (sorted by name to
 * preserve prompt cache — Spec 04 §2).
 */
import { z } from 'zod';
import type { ToolName } from '@vingsforge/shared';

/** A non-empty, non-absolute-required path string (confinement is enforced separately). */
const path = z.string().min(1);

export const readFileInput = z
  .object({
    path,
    /** Optional 1-based inclusive [start, end] line range. */
    range: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  })
  .strict();

export const listDirInput = z.object({ path }).strict();

export const globInput = z.object({ pattern: z.string().min(1) }).strict();

export const grepInput = z
  .object({
    pattern: z.string().min(1),
    path: path.optional(),
  })
  .strict();

export const writeFileInput = z.object({ path, content: z.string() }).strict();

export const editFileInput = z
  .object({
    path,
    old_str: z.string(),
    new_str: z.string(),
  })
  .strict();

export const bashInput = z
  .object({
    command: z.string().min(1),
    /** Hard wall-clock limit; clamped by the executor (Spec 04 §4). */
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

/** Map from tool name to its input validator. */
export const toolInputSchemas = {
  bash: bashInput,
  edit_file: editFileInput,
  glob: globInput,
  grep: grepInput,
  list_dir: listDirInput,
  read_file: readFileInput,
  write_file: writeFileInput,
} satisfies Partial<Record<ToolName, z.ZodTypeAny>>;

/** Tool names that have a local executor in v1 (`web_search` is out of scope here). */
export type LocalToolName = keyof typeof toolInputSchemas;

export type ToolInput<T extends LocalToolName> = z.infer<(typeof toolInputSchemas)[T]>;

/** Read-only tools may run in parallel; the rest are serialized (Spec 04 §2). */
export const READ_ONLY_TOOLS: ReadonlySet<LocalToolName> = new Set([
  'read_file',
  'list_dir',
  'glob',
  'grep',
]);

/** Stable JSON-Schema tool definition sent to the model (Spec 04 §2). */
export interface ToolDefinition {
  name: LocalToolName;
  description: string;
  /** JSON Schema (draft) for the input; `additionalProperties:false`. */
  input_schema: Record<string, unknown>;
  /** Read-only tools are parallelizable; others are gated/serialized. */
  readOnly: boolean;
}

const descriptions: Record<LocalToolName, string> = {
  bash: 'Run a shell command in the runtime and capture stdout/stderr.',
  edit_file: 'Replace an exact string in a file; rejected if the file changed since last read.',
  glob: 'List workspace files matching a glob pattern.',
  grep: 'Search the workspace for a regular expression.',
  list_dir: 'List the entries of a directory in the workspace.',
  read_file: 'Read a UTF-8 file from the workspace, optionally a line range.',
  write_file: 'Create or overwrite a file in the workspace.',
};

function jsonSchemaOf(name: LocalToolName): Record<string, unknown> {
  // z.toJSONSchema (Zod v4) emits draft-2020-12; `.strict()` yields
  // additionalProperties:false, satisfying Spec 04's strict requirement.
  return z.toJSONSchema(toolInputSchemas[name], {
    target: 'draft-2020-12',
  }) as Record<string, unknown>;
}

/** All local tool definitions, ordered by name to preserve prompt cache (Spec 04 §2). */
export const orderedTools: readonly ToolDefinition[] = (
  Object.keys(toolInputSchemas) as LocalToolName[]
)
  .sort()
  .map((name) => ({
    name,
    description: descriptions[name],
    input_schema: jsonSchemaOf(name),
    readOnly: READ_ONLY_TOOLS.has(name),
  }));
