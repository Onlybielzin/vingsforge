import { describe, expect, it } from 'vitest';
import { createSidecar } from './index.js';

describe('createSidecar', () => {
  it('creates a host that accepts an event listener', () => {
    const sidecar = createSidecar({ mode: 'stdio' });
    let received = 0;
    sidecar.onEvent(() => {
      received += 1;
    });
    sidecar.handle({ type: 'engine.interrupt', chatId: 'c1' });
    // Placeholder does not emit yet.
    expect(received).toBe(0);
  });
});
