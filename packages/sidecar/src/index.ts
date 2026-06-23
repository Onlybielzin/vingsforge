/**
 * @vingsforge/sidecar — entry point.
 *
 * This same binary runs in two modes (Spec 09 §3, Spec 05 §4):
 *   - local engine: spawned by the Tauri core, talks JSON over stdio.
 *   - remote daemon (forge-daemon): headless on a VPS, talks over WebSocket/SSH.
 *
 * Placeholder only — the agentic loop (Spec 03), tools (Spec 04), SQLite
 * persistence (Spec 08) and remote transport (Spec 05) are not implemented yet.
 */
import type { EngineCommand, EngineEvent } from '@vingsforge/shared';

// Built-in tools + permissions (Spec 04).
export * from './tools/index.js';
export * from './permissions/policy.js';

// Agentic engine (Spec 03).
export * from './engine/index.js';

// Project lifecycle (Spec 01).
export * from './projects/index.js';

// Chat lifecycle + turn orchestration (Spec 02).
export * from './chats/index.js';

// Global settings: layered config, API-key secure storage, model/key validation (Spec 07).
export * from './settings/index.js';

// Remote runtime: forge-daemon, SSH client, RuntimesAPI, turn routing (Spec 05).
export * from './remote/index.js';

export type Mode = 'stdio' | 'daemon';

export interface SidecarOptions {
  mode: Mode;
}

/** Placeholder engine host. Real implementation lands with Spec 03. */
export function createSidecar(_options: SidecarOptions): {
  handle(command: EngineCommand): void;
  onEvent(listener: (event: EngineEvent) => void): void;
} {
  const listeners = new Set<(event: EngineEvent) => void>();
  return {
    handle(_command: EngineCommand): void {
      // TODO(Spec 03): run the agentic loop.
    },
    onEvent(listener: (event: EngineEvent) => void): void {
      listeners.add(listener);
    },
  };
}

function main(): void {
  const mode: Mode = process.argv.includes('--daemon') ? 'daemon' : 'stdio';
  // eslint-disable-next-line no-console
  console.error(`[vingsforge-sidecar] placeholder started in ${mode} mode`);
}

// Run only when executed directly (not when imported in tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
