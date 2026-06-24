/**
 * "Agentes" right-panel tab — a live, /workflows-style list of every subagent
 * fired in the current conversation. Each running agent shows a "trabalhando…"
 * indicator and a live elapsed-time clock; finished agents collapse to a stats
 * line (model · tokens · tools · duration).
 *
 * The clock is measured here, not derived from telemetry: the first time we see
 * a callId we record `Date.now()` in a ref, and a single setInterval ticks while
 * any agent is running. The interval is ALWAYS cleared on cleanup (no leak).
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ToolState } from '../state/conversation.js';
import { Icon, type IconName } from './Icon.js';
import { ThinkingDots } from './ThinkingDots.js';
import { formatDuration } from './subagentUsage.js';
import { countRunning, isAgentRunning, type AgentEntry } from './agentsPanel.js';

const STATE_META: Record<ToolState, { label: string; color: string; icon: IconName }> = {
  pending: { label: 'pendente', color: 'var(--vf-text-faint)', icon: 'spinner' },
  'awaiting-permission': { label: 'permissão', color: 'var(--vf-warn)', icon: 'lock' },
  running: { label: 'rodando', color: 'var(--vf-accent)', icon: 'spinner' },
  ok: { label: 'concluído', color: 'var(--vf-ok)', icon: 'check' },
  error: { label: 'erro', color: 'var(--vf-danger)', icon: 'cross' },
};

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function buildStats(model: string | undefined, entry: AgentEntry): string[] {
  const out: string[] = [];
  if (model) out.push(model);
  const usage = entry.usage;
  if (usage?.tokens != null) out.push(`${formatNumber(usage.tokens)} tokens`);
  if (usage?.tools != null) out.push(`${usage.tools} ${usage.tools === 1 ? 'tool' : 'tools'}`);
  if (usage?.durationMs != null) out.push(formatDuration(usage.durationMs));
  return out;
}

export function AgentsPanel({
  agents,
  model,
}: {
  agents: AgentEntry[];
  /** Active model name, shown in finished agents' stats line. */
  model?: string;
}): JSX.Element {
  const running = countRunning(agents);

  // First-seen wall-clock per callId, so the elapsed clock survives re-renders.
  const startedRef = useRef<Map<string, number>>(new Map());
  const [now, setNow] = useState(() => Date.now());

  // Record start time for any newly-seen running agent.
  for (const a of agents) {
    if (isAgentRunning(a) && !startedRef.current.has(a.callId)) {
      startedRef.current.set(a.callId, Date.now());
    }
  }

  // Tick once a second while ANY agent is running; clear on cleanup. The effect
  // re-runs whenever the running count changes, so the interval stops the moment
  // the last agent finishes (and is always cleared on unmount — no leak).
  useEffect(() => {
    if (running === 0) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  return (
    <div style={wrap}>
      <header style={summary}>
        <span style={summaryCount}>
          {agents.length} {agents.length === 1 ? 'agente' : 'agentes'}
        </span>
        {running > 0 ? <span style={summaryRunning}>{running} rodando</span> : null}
      </header>

      {agents.length === 0 ? (
        <p style={emptyHint}>Nenhum subagente nesta conversa ainda.</p>
      ) : (
        <ul style={list}>
          {agents.map((agent, i) => {
            const meta = STATE_META[agent.state];
            const live = isAgentRunning(agent);
            const started = startedRef.current.get(agent.callId);
            const elapsed = live && started != null ? now - started : null;
            const stats = buildStats(model, agent);
            return (
              <li key={agent.callId} style={row(live)}>
                <span style={badge}>
                  <Icon name="chat" size={13} style={{ color: 'var(--vf-accent)' }} />
                </span>
                <span style={col}>
                  <span style={titleRow}>
                    <span style={title} title={agent.task || undefined}>
                      {agent.task || `Subagente ${i + 1}`}
                    </span>
                  </span>
                  {live ? (
                    <span style={subRow}>
                      <ThinkingDots label="trabalhando…" />
                      {elapsed != null ? <span style={clock}>{formatDuration(elapsed)}</span> : null}
                    </span>
                  ) : stats.length > 0 ? (
                    <span style={statsRow}>{stats.join(' · ')}</span>
                  ) : null}
                </span>
                <span style={{ ...pill, color: meta.color, borderColor: meta.color }}>
                  <Icon name={meta.icon} size={11} {...(live ? { className: 'vf-pulse' } : {})} />
                  {meta.label}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const wrap: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 };
const summary: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12.5,
  color: 'var(--vf-text-muted)',
};
const summaryCount: CSSProperties = { fontWeight: 600, color: 'var(--vf-text)' };
const summaryRunning: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  fontSize: 11,
  padding: '1px 7px',
  borderRadius: 999,
  background: 'var(--vf-accent-weak)',
  border: '1px solid color-mix(in srgb, var(--vf-accent) 35%, transparent)',
  color: 'var(--vf-accent)',
};
const emptyHint: CSSProperties = { color: 'var(--vf-text-muted)', fontSize: 13, margin: 0 };
const list: CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 };
const row = (live: boolean): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 9,
  padding: '8px 10px',
  borderRadius: 9,
  border: `1px solid ${live ? 'color-mix(in srgb, var(--vf-accent) 30%, var(--vf-border))' : 'var(--vf-border)'}`,
  background: live
    ? 'linear-gradient(180deg, color-mix(in srgb, var(--vf-accent) 6%, var(--vf-surface)), var(--vf-surface))'
    : 'var(--vf-surface)',
});
const badge: CSSProperties = {
  display: 'grid',
  placeItems: 'center',
  width: 22,
  height: 22,
  flexShrink: 0,
  borderRadius: 7,
  background: 'var(--vf-accent-weak)',
  border: '1px solid color-mix(in srgb, var(--vf-accent) 35%, transparent)',
};
const col: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 };
const titleRow: CSSProperties = { display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 };
const title: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12.5,
  color: 'var(--vf-text)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const subRow: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 10 };
const clock: CSSProperties = { fontFamily: 'var(--vf-mono)', fontSize: 11, color: 'var(--vf-text-faint)' };
const statsRow: CSSProperties = { fontFamily: 'var(--vf-mono)', fontSize: 11.5, color: 'var(--vf-text-muted)' };
const pill: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 10.5,
  padding: '1px 7px',
  borderRadius: 999,
  border: '1px solid',
  flexShrink: 0,
};
