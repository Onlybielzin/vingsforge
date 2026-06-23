/**
 * Inline tool card (Spec 06 §4): renders read/grep/glob compactly (collapsible
 * result), edit/write as a colored diff, bash as an embedded terminal, with a
 * state pill (pending / awaiting permission / running / ok / error).
 */
import { useState, type CSSProperties } from 'react';
import type { ToolCard as ToolCardModel, ToolState } from '../state/conversation.js';
import type { DetailContent } from './RightPanel.js';
import { Icon, type IconName } from './Icon.js';
import { BashTerminal } from './BashTerminal.js';
import { DiffView } from './DiffView.js';

const STATE_META: Record<ToolState, { label: string; color: string; icon: IconName; spin?: boolean }> = {
  pending: { label: 'pending', color: 'var(--vf-text-faint)', icon: 'spinner' },
  'awaiting-permission': { label: 'awaiting permission', color: 'var(--vf-warn)', icon: 'lock' },
  running: { label: 'running', color: 'var(--vf-accent)', icon: 'spinner', spin: true },
  ok: { label: 'ok', color: 'var(--vf-ok)', icon: 'check' },
  error: { label: 'error', color: 'var(--vf-danger)', icon: 'cross' },
};

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function outputToText(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  return JSON.stringify(output, null, 2);
}

export function ToolCard({
  card,
  onOpenDetail,
}: {
  card: ToolCardModel;
  onOpenDetail?: (detail: DetailContent) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const meta = STATE_META[card.state];
  const input = asRecord(card.input);
  const summary = summarize(card.tool, input);
  const detail = buildDetail(card, input);

  return (
    <div style={shell} className="vf-fade-in">
      <div style={header}>
        <button style={headerMain} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <Icon name={iconForTool(card.tool)} size={14} style={{ color: 'var(--vf-text-muted)' }} />
          <span style={toolName}>{card.tool}</span>
          <span style={summaryText}>{summary}</span>
          <span style={{ ...pill, color: meta.color, borderColor: meta.color }}>
            <Icon name={meta.icon} size={12} {...(meta.spin ? { className: 'vf-pulse' } : {})} />
            {meta.label}
          </span>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} style={{ color: 'var(--vf-text-faint)' }} />
        </button>
        {detail && onOpenDetail ? (
          <button
            style={openBtn}
            onClick={() => onOpenDetail(detail)}
            title="Open in detail panel"
            aria-label="Open in detail panel"
          >
            <Icon name="chevron-right" size={14} />
          </button>
        ) : null}
      </div>

      {open ? <div style={body}>{renderBody(card, input)}</div> : null}
    </div>
  );
}

/**
 * Builds the right-panel Detail content for a card, or null when there's nothing
 * useful to inspect yet. Edits become an original/modified diff; bash and reads
 * surface their output as text (modified=output, original='').
 */
function buildDetail(card: ToolCardModel, input: Record<string, unknown>): DetailContent | null {
  if (card.tool === 'edit_file' || card.tool === 'write_file') {
    const original = str(input.oldText) ?? str(input.original) ?? '';
    const modified = str(input.newText) ?? str(input.content) ?? outputToText(card.output);
    if (!original && !modified) return null;
    const title = str(input.path) ?? card.tool;
    return { title, original, modified };
  }
  const output = outputToText(card.output);
  if (!output) return null;
  const title = summarize(card.tool, input) || card.tool;
  return { title, original: '', modified: output };
}

function renderBody(card: ToolCardModel, input: Record<string, unknown>): JSX.Element {
  if (card.tool === 'bash') {
    return (
      <BashTerminal
        command={str(input.command) ?? ''}
        {...(card.output !== undefined ? { output: outputToText(card.output) } : {})}
        {...(card.isError !== undefined ? { isError: card.isError } : {})}
      />
    );
  }
  if (card.tool === 'edit_file' || card.tool === 'write_file') {
    const original = str(input.oldText) ?? str(input.original) ?? '';
    const modified = str(input.newText) ?? str(input.content) ?? outputToText(card.output);
    return <DiffView original={original} modified={modified} height={240} />;
  }
  // read/grep/glob/list_dir/web_search → compact result.
  return (
    <pre style={resultPre}>
      <code>{outputToText(card.output) || '(no output yet)'}</code>
    </pre>
  );
}

function summarize(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return str(input.path) ?? '';
    case 'bash':
      return str(input.command) ?? '';
    case 'grep':
      return str(input.pattern) ?? '';
    case 'glob':
      return str(input.pattern) ?? str(input.glob) ?? '';
    case 'list_dir':
      return str(input.path) ?? '';
    case 'web_search':
      return str(input.query) ?? '';
    default:
      return '';
  }
}

function iconForTool(tool: string): IconName {
  if (tool === 'bash') return 'terminal';
  if (tool === 'edit_file' || tool === 'write_file') return 'file';
  if (tool === 'list_dir' || tool === 'glob') return 'folder';
  return 'file';
}

const shell: CSSProperties = {
  border: '1px solid var(--vf-border)',
  borderRadius: 9,
  background: 'var(--vf-surface)',
  margin: '6px 0',
};
const header: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  width: '100%',
};
const headerMain: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flex: 1,
  minWidth: 0,
  padding: '8px 10px',
  background: 'transparent',
  border: 'none',
  color: 'var(--vf-text)',
  textAlign: 'left',
};
const openBtn: CSSProperties = {
  flexShrink: 0,
  display: 'grid',
  placeItems: 'center',
  padding: '8px 10px',
  background: 'transparent',
  border: 'none',
  color: 'var(--vf-text-faint)',
};
const toolName: CSSProperties = { fontFamily: 'var(--vf-mono)', fontSize: 12.5, fontWeight: 600 };
const summaryText: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: 'var(--vf-mono)',
  fontSize: 12,
  color: 'var(--vf-text-muted)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const pill: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 11,
  padding: '1px 7px',
  borderRadius: 999,
  border: '1px solid',
};
const body: CSSProperties = { padding: '0 10px 10px' };
const resultPre: CSSProperties = {
  margin: 0,
  padding: '10px 12px',
  border: '1px solid var(--vf-border)',
  borderRadius: 8,
  background: 'var(--vf-bg-inset)',
  fontFamily: 'var(--vf-mono)',
  fontSize: 12,
  maxHeight: 240,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};
