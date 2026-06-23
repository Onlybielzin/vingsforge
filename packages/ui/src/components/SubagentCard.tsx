/**
 * Dedicated card for subagent (Agent/Task) tool calls — a prettier, /workflows-
 * style presentation instead of the generic ToolCard layout. Shows the task
 * description, a live "trabalhando…" indicator while running, an elegant stats
 * line on completion (model · tokens · tools · duration), and an expandable body
 * with the cleaned subagent output rendered as markdown.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import type { ToolCard as ToolCardModel, ToolState } from '../state/conversation.js';
import { Icon, type IconName } from './Icon.js';
import { Markdown } from './Markdown.js';
import { ThinkingDots } from './ThinkingDots.js';
import {
  cleanSubagentOutput,
  formatDuration,
  outputToText,
  parseSubagentUsage,
} from './subagentUsage.js';

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
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Best-effort task description from the subagent's tool input. */
function taskLabel(input: Record<string, unknown>): string {
  return (
    str(input.description) ??
    str(input.task) ??
    str(input.prompt) ??
    str(input.subagent_type) ??
    ''
  );
}

function truncate(text: string, max = 96): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function SubagentCard({
  card,
  model,
}: {
  card: ToolCardModel;
  /** Active model name, shown in the stats line when available. */
  model?: string;
}): JSX.Element {
  const meta = STATE_META[card.state];
  const input = asRecord(card.input);
  const desc = taskLabel(input);
  const running = card.state === 'running' || card.state === 'pending';
  const isError = card.state === 'error' || card.isError === true;

  const rawOutput = outputToText(card.output);
  const usage = parseSubagentUsage(rawOutput);
  const cleaned = cleanSubagentOutput(rawOutput);
  const hasBody = cleaned.length > 0;

  // Expand by default once finished so the result is visible without a click;
  // stay collapsed while running (there's nothing useful yet).
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!running && hasBody) setOpen(true);
  }, [running, hasBody]);

  const stats = buildStats(model, usage);

  return (
    <div style={shell(isError)} className="vf-fade-in">
      <button style={header} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span style={badge}>
          <Icon name="chat" size={13} style={{ color: 'var(--vf-accent)' }} />
        </span>
        <span style={labelCol}>
          <span style={titleRow}>
            <span style={kicker}>Subagente</span>
            {desc ? <span style={descText}>{truncate(desc)}</span> : null}
          </span>
          {running ? (
            <span style={subRow}>
              <ThinkingDots label="trabalhando…" />
              <LiveClock active />
            </span>
          ) : stats.length > 0 ? (
            <span style={statsRow}>{stats.join(' · ')}</span>
          ) : null}
        </span>
        <span style={{ ...pill, color: meta.color, borderColor: meta.color }}>
          <Icon name={meta.icon} size={12} {...(meta.spin ? { className: 'vf-pulse' } : {})} />
          {meta.label}
        </span>
        {hasBody ? (
          <Icon
            name={open ? 'chevron-down' : 'chevron-right'}
            size={14}
            style={{ color: 'var(--vf-text-faint)', flexShrink: 0 }}
          />
        ) : null}
      </button>

      {open && hasBody ? (
        <div style={body(isError)}>
          <Markdown text={cleaned} />
        </div>
      ) : null}
    </div>
  );
}

function buildStats(model: string | undefined, usage: ReturnType<typeof parseSubagentUsage>): string[] {
  const out: string[] = [];
  if (model) out.push(model);
  if (usage?.tokens != null) out.push(`${formatNumber(usage.tokens)} tokens`);
  if (usage?.tools != null) out.push(`${usage.tools} ${usage.tools === 1 ? 'tool' : 'tools'}`);
  if (usage?.durationMs != null) out.push(formatDuration(usage.durationMs));
  return out;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/** A lightweight live elapsed-time clock for the running state. */
function LiveClock({ active }: { active: boolean }): JSX.Element | null {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [active]);
  if (!active) return null;
  return <span style={clockText}>{formatDuration(now - start)}</span>;
}

const shell = (isError: boolean): CSSProperties => ({
  border: `1px solid ${isError ? 'var(--vf-danger)' : 'color-mix(in srgb, var(--vf-accent) 30%, var(--vf-border))'}`,
  borderRadius: 10,
  background: 'linear-gradient(180deg, color-mix(in srgb, var(--vf-accent) 6%, var(--vf-surface)), var(--vf-surface))',
  margin: '6px 0',
});
const header: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  padding: '9px 11px',
  background: 'transparent',
  border: 'none',
  color: 'var(--vf-text)',
  textAlign: 'left',
  cursor: 'pointer',
};
const badge: CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  width: 24,
  height: 24,
  flexShrink: 0,
  borderRadius: 7,
  background: 'var(--vf-accent-weak)',
  border: '1px solid color-mix(in srgb, var(--vf-accent) 35%, transparent)',
};
const labelCol: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 };
const titleRow: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 };
const kicker: CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.7,
  fontWeight: 700,
  color: 'var(--vf-accent)',
  flexShrink: 0,
};
const descText: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12.5,
  color: 'var(--vf-text)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const subRow: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 10 };
const statsRow: CSSProperties = {
  fontFamily: 'var(--vf-mono)',
  fontSize: 11.5,
  color: 'var(--vf-text-muted)',
};
const clockText: CSSProperties = { fontFamily: 'var(--vf-mono)', fontSize: 11, color: 'var(--vf-text-faint)' };
const pill: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 11,
  padding: '1px 7px',
  borderRadius: 999,
  border: '1px solid',
  flexShrink: 0,
};
const body = (isError: boolean): CSSProperties => ({
  padding: '2px 12px 12px 12px',
  margin: '0 1px',
  fontSize: 13,
  color: isError ? 'var(--vf-danger)' : 'var(--vf-text)',
  borderTop: '1px solid var(--vf-border)',
});
