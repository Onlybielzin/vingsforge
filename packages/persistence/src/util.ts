/**
 * Small shared helpers: id generation and ISO timestamps.
 */
import { randomUUID } from 'node:crypto';
import type { IsoDateString } from '@vingsforge/shared';

/** Generate a unique id (used when the caller does not supply one). */
export function newId(): string {
  return randomUUID();
}

/** Current time as an ISO-8601 string. */
export function nowIso(): IsoDateString {
  return new Date().toISOString();
}
