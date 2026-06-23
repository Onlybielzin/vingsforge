/**
 * XDG-compliant data paths for the VingsForge database (Spec 08 §2).
 * In the desktop app the caller may instead pass Electron/Tauri's userData dir.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Application directory name used under the XDG data root. */
export const APP_DIR_NAME = 'vingsforge';

/** Database file name. */
export const DB_FILE_NAME = 'vingsforge.db';

/**
 * Resolve the XDG data home (`$XDG_DATA_HOME` or `~/.local/share`).
 * Honours an absolute `XDG_DATA_HOME`; falls back to the spec default otherwise.
 */
export function xdgDataHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.XDG_DATA_HOME;
  if (fromEnv && fromEnv.startsWith('/')) return fromEnv;
  return join(homedir(), '.local', 'share');
}

/** Absolute path to the app's data directory (`<xdg>/vingsforge`). */
export function appDataDir(env?: NodeJS.ProcessEnv): string {
  return join(xdgDataHome(env), APP_DIR_NAME);
}

/** Absolute path to the SQLite database file. */
export function defaultDbPath(env?: NodeJS.ProcessEnv): string {
  return join(appDataDir(env), DB_FILE_NAME);
}
