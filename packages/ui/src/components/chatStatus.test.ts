/**
 * Tests for the per-chat status helpers used by the Sidebar tree and ChatList.
 * Runs under the package's node-env vitest (no DOM), matching the other UI unit
 * tests (externalSessions/updateState/slashPopup).
 */
import { describe, expect, it } from 'vitest';
import { chatStatus, statusColor, statusPulses } from './chatStatus.js';

describe('chatStatus', () => {
  it("is 'running' only for the active chat while streaming", () => {
    expect(chatStatus('a', 'a', true)).toBe('running');
  });

  it("is 'idle' for the active chat when not streaming", () => {
    expect(chatStatus('a', 'a', false)).toBe('idle');
  });

  it("is 'idle' for a non-active chat even while another streams", () => {
    expect(chatStatus('b', 'a', true)).toBe('idle');
  });

  it("is 'idle' when no chat is active", () => {
    expect(chatStatus('a', null, true)).toBe('idle');
  });

  it("marks exactly one row 'running' across a list: the active one while streaming", () => {
    // A project's chat list rendered while chat 'b' is active and streaming:
    // only 'b' should report 'running'; every other row stays 'idle'.
    const rows = ['a', 'b', 'c'];
    const active = 'b';
    const streaming = true;
    const statuses = rows.map((id) => chatStatus(id, active, streaming));
    expect(statuses).toEqual(['idle', 'running', 'idle']);
    expect(statuses.filter((s) => s === 'running')).toHaveLength(1);
  });

  it("marks no row 'running' once the active chat stops streaming", () => {
    const rows = ['a', 'b', 'c'];
    const statuses = rows.map((id) => chatStatus(id, 'b', false));
    expect(statuses.every((s) => s === 'idle')).toBe(true);
  });
});

describe('statusColor / statusPulses', () => {
  it('maps running to the ok color and pulses', () => {
    expect(statusColor('running')).toBe('var(--vf-ok)');
    expect(statusPulses('running')).toBe(true);
  });

  it('maps idle to the faint color and does not pulse', () => {
    expect(statusColor('idle')).toBe('var(--vf-text-faint)');
    expect(statusPulses('idle')).toBe(false);
  });
});
