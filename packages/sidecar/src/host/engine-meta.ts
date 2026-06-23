/**
 * EngineMetaAPI implementation — a tiny in-memory cache of the slash commands /
 * skills the `claude` CLI advertised on its most recent `system/init` event.
 *
 * The claude-cli-runner calls {@link EngineMetaStore.set} whenever an init event
 * carries the arrays; the UI reads the latest snapshot via the `meta` RPC. Empty
 * arrays are returned until the first turn has run.
 */
import type { EngineMeta, EngineMetaAPI } from '@vingsforge/shared';

export class EngineMetaStore implements EngineMetaAPI {
  private slashCommands: string[] = [];
  private skills: string[] = [];

  /** Replace the cached capabilities (called from each `system/init`). */
  set(meta: EngineMeta): void {
    this.slashCommands = [...meta.slashCommands];
    this.skills = [...meta.skills];
  }

  /** Return the latest cached snapshot (copies, so callers can't mutate state). */
  async meta(): Promise<EngineMeta> {
    return { slashCommands: [...this.slashCommands], skills: [...this.skills] };
  }
}
