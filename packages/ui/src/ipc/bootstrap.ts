/**
 * Transport selection (Spec 06 §7): try the real sidecar WebSocket, fall back to
 * the in-memory mock if it does not connect quickly. Keeps the browser preview
 * working with no sidecar attached while letting the desktop app reach the host.
 */
import {
  DEFAULT_SIDECAR_PORT,
  LOCAL_AUTH_SUBPROTOCOL,
  LOCAL_AUTH_TOKEN_GLOBAL,
} from '@vingsforge/shared';
import type { IpcClient } from './client.js';
import { createMockIpcClient } from './mock.js';
import { createRealIpcClient, type RealIpcOptions } from './real.js';

/** Which transport actually backs the running client. */
export type IpcMode = 'real' | 'mock';

/** Result of {@link connectIpc}: the chosen client and which mode it is. */
export interface IpcBootstrap {
  client: IpcClient;
  mode: IpcMode;
}

export interface ConnectIpcOptions extends RealIpcOptions {
  /** How long to wait for the sidecar to open before falling back (default 1500ms). */
  timeoutMs?: number;
}

function defaultUrl(): string {
  return `ws://127.0.0.1:${DEFAULT_SIDECAR_PORT}`;
}

/** Read the token the Tauri shell injected into the WebView (undefined outside it). */
function injectedToken(): string | undefined {
  const value = (globalThis as Record<string, unknown>)[LOCAL_AUTH_TOKEN_GLOBAL];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Races a fresh sidecar socket against a timeout. Resolves to the real client
 * when the socket opens in time, otherwise tears it down and resolves to the
 * mock. Never rejects — the UI always gets a usable client.
 */
export function connectIpc(opts: ConnectIpcOptions = {}): Promise<IpcBootstrap> {
  const { timeoutMs = 1500, WebSocketImpl, url, maxBackoffMs } = opts;
  const WS = WebSocketImpl ?? (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
  // The host 401s any handshake without the token, so the probe must present it too.
  const authToken = opts.authToken ?? injectedToken();
  const protocols =
    authToken !== undefined ? [LOCAL_AUTH_SUBPROTOCOL, authToken] : undefined;

  // No WebSocket available at all (non-browser preview / SSR): go straight to mock.
  if (!WS) return Promise.resolve({ client: createMockIpcClient(), mode: 'mock' });

  return new Promise<IpcBootstrap>((resolve) => {
    let settled = false;
    let probe: WebSocket | null = null;

    const finishMock = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ client: createMockIpcClient(), mode: 'mock' });
    };

    const finishReal = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Hand the already-open socket's URL to a full client (which manages its
      // own reconnecting socket); close the throwaway probe.
      if (probe) {
        probe.onopen = null;
        probe.onerror = null;
        probe.onclose = null;
        try {
          probe.close();
        } catch {
          /* already closing */
        }
        probe = null;
      }
      const realOpts: RealIpcOptions = {
        ...(url !== undefined ? { url } : {}),
        ...(maxBackoffMs !== undefined ? { maxBackoffMs } : {}),
        ...(authToken !== undefined ? { authToken } : {}),
        WebSocketImpl: WS,
      };
      resolve({ client: createRealIpcClient(realOpts), mode: 'real' });
    };

    const cleanup = (): void => {
      clearTimeout(timer);
      if (probe) {
        probe.onopen = null;
        probe.onerror = null;
        probe.onclose = null;
        try {
          probe.close();
        } catch {
          /* already closing */
        }
        probe = null;
      }
    };

    const timer = setTimeout(finishMock, timeoutMs);

    try {
      probe =
        protocols !== undefined
          ? new WS(url ?? defaultUrl(), protocols)
          : new WS(url ?? defaultUrl());
    } catch {
      finishMock();
      return;
    }
    probe.onopen = finishReal;
    probe.onerror = finishMock;
    probe.onclose = finishMock;
  });
}
