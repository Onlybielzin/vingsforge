/**
 * Tests for transport selection (Spec 06 §7): connectIpc races a sidecar probe
 * against a timeout, returning the real client on open and the mock on
 * timeout/error so the browser preview always gets a usable client.
 */
import { describe, expect, it, vi } from 'vitest';
import { connectIpc } from './bootstrap.js';

class ControllableWS {
  static instances: ControllableWS[] = [];
  static OPEN = 1 as const;
  readyState: number = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    ControllableWS.instances.push(this);
  }
  send(): void {
    /* not exercised here */
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.readyState = ControllableWS.OPEN;
    this.onopen?.({});
  }
}

describe('connectIpc', () => {
  it('returns the real client when the probe opens before the timeout', async () => {
    ControllableWS.instances = [];
    const promise = connectIpc({
      WebSocketImpl: ControllableWS as unknown as typeof WebSocket,
      timeoutMs: 1000,
    });
    // Open the probe synchronously after construction.
    ControllableWS.instances[0]!.open();
    const { mode, client } = await promise;
    expect(mode).toBe('real');
    expect(client.projects).toBeDefined();
  });

  it('falls back to the mock when the probe never opens (timeout)', async () => {
    vi.useFakeTimers();
    try {
      ControllableWS.instances = [];
      const promise = connectIpc({
        WebSocketImpl: ControllableWS as unknown as typeof WebSocket,
        timeoutMs: 1500,
      });
      await vi.advanceTimersByTimeAsync(1600);
      const { mode } = await promise;
      expect(mode).toBe('mock');
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the mock when the probe errors', async () => {
    ControllableWS.instances = [];
    const promise = connectIpc({
      WebSocketImpl: ControllableWS as unknown as typeof WebSocket,
      timeoutMs: 5000,
    });
    ControllableWS.instances[0]!.onerror?.({});
    const { mode } = await promise;
    expect(mode).toBe('mock');
  });
});
