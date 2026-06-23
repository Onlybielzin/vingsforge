/**
 * Inline stroke icons (Spec 06 §2: no emoji; consistent iconography). Minimal
 * line set so the UI stays dependency-free; sized via the `size` prop.
 */
import type { CSSProperties } from 'react';

export type IconName =
  | 'plus'
  | 'folder'
  | 'chat'
  | 'settings'
  | 'chevron-right'
  | 'chevron-down'
  | 'send'
  | 'stop'
  | 'check'
  | 'cross'
  | 'spinner'
  | 'lock'
  | 'file'
  | 'terminal'
  | 'copy'
  | 'cloud'
  | 'local';

const PATHS: Record<IconName, string> = {
  plus: 'M12 5v14M5 12h14',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  chat: 'M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.5A8 8 0 1 1 21 12z',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 12l1.5-1-1.3-3.2-1.8.4-1.4-1.4.4-1.8L12 3.7 9.6 4.6l-1.4 1.4-1.8-.4L5 8.8 6.5 11 6 13l-1.5 1 1.3 3.2 1.8-.4 1.4 1.4-.4 1.8L12 20.3l2.4-.9 1.4-1.4 1.8.4 1.3-3.2L19 14z',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  send: 'M22 2L11 13M22 2l-7 20-4-9-9-4z',
  stop: 'M6 6h12v12H6z',
  check: 'M5 13l4 4L19 7',
  cross: 'M6 6l12 12M18 6L6 18',
  spinner: 'M12 3a9 9 0 1 0 9 9',
  lock: 'M6 11V8a6 6 0 0 1 12 0v3M5 11h14v9H5z',
  file: 'M7 3h7l5 5v13H7zM14 3v5h5',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M13 15h4',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  cloud: 'M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.3A4 4 0 0 1 17 18z',
  local: 'M4 5h16v10H4zM8 19h8M12 15v4',
};

export interface IconProps {
  name: IconName;
  size?: number;
  style?: CSSProperties;
  className?: string;
  title?: string;
}

export function Icon({ name, size = 16, style, className, title }: IconProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      className={className}
      style={style}
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name]} />
    </svg>
  );
}
