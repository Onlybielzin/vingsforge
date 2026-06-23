/**
 * Per-chat status indicator dot (Spec 06 §3). Green and pulsing (vf-pulse) for
 * the active+streaming chat ('running'); a neutral faint dot otherwise ('idle').
 * Shared by the Sidebar chat tree and the main-panel ChatList rows.
 */
import type { CSSProperties } from 'react';
import { statusColor, statusPulses, type ChatStatus } from './chatStatus.js';

export interface ChatStatusDotProps {
  status: ChatStatus;
  size?: number;
}

export function ChatStatusDot({ status, size = 8 }: ChatStatusDotProps): JSX.Element {
  const dot: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    flexShrink: 0,
    background: statusColor(status),
  };
  return (
    <span
      style={dot}
      className={statusPulses(status) ? 'vf-pulse' : undefined}
      aria-label={status === 'running' ? 'running' : 'idle'}
      title={status === 'running' ? 'running' : 'idle'}
    />
  );
}
