/**
 * IPC client surface for the renderer (Spec 06 §7, Spec 00 §5). Bundles the
 * typed @vingsforge/shared APIs plus the engine event stream / command channel
 * behind one injectable, mockable port so components never touch the transport.
 */
import type {
  ChatsAPI,
  EngineCommand,
  EngineEvent,
  EngineMetaAPI,
  ProjectsAPI,
  RuntimesAPI,
  SettingsAPI,
  UpdateAPI,
} from '@vingsforge/shared';

/** Unsubscribe handle returned by stream subscriptions. */
export type Unsubscribe = () => void;

/**
 * Engine channel — the unified event stream every runtime emits plus the
 * command channel the UI uses to drive turns and resolve permissions
 * (Spec 03 §8, Spec 04 §3.1). Kept separate from the request/response APIs so a
 * transport can back it with a socket while the rest are command calls.
 */
export interface EngineChannel {
  /** Subscribe to the unified engine event stream. */
  onEvent(listener: (event: EngineEvent) => void): Unsubscribe;
  /** Send a command (interrupt, permission resolution) to the engine. */
  send(command: EngineCommand): Promise<void>;
}

/**
 * The full IPC surface injected into the React tree. Mirrors the contracts in
 * @vingsforge/shared so the renderer is fully typed against them.
 */
export interface IpcClient {
  projects: ProjectsAPI;
  chats: ChatsAPI;
  runtimes: RuntimesAPI;
  settings: SettingsAPI;
  /** Engine capability metadata (CLI slash commands / skills). */
  meta: EngineMetaAPI;
  /** In-app git auto-updater (status probe + run; progress via update.* events). */
  update: UpdateAPI;
  engine: EngineChannel;
}
