/**
 * Faithful JSON (de)serialization for the TEXT columns that hold structured data
 * (blocks, usage, permission policy, ssh/daemon). Validates on read with Zod (Spec 08 §4).
 *
 * The optional `Out` type parameter lets callers narrow the parsed value to the shared
 * domain type. Zod's inferred output adds `| undefined` to optional fields, which clashes
 * with `exactOptionalPropertyTypes`; `Out` resolves that without weakening validation.
 */
import type { z } from 'zod';

/** Serialize a value to a stable JSON string for a TEXT column. */
export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

/** Parse a TEXT column through a Zod schema; throws on malformed/legacy rows. */
export function fromJson<S extends z.ZodTypeAny, Out = z.infer<S>>(
  schema: S,
  raw: string,
): Out {
  return schema.parse(JSON.parse(raw)) as Out;
}

/** Parse an optional TEXT column; `null`/`undefined`/empty yields `undefined`. */
export function fromJsonNullable<S extends z.ZodTypeAny, Out = z.infer<S>>(
  schema: S,
  raw: string | null | undefined,
): Out | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  return fromJson<S, Out>(schema, raw);
}
