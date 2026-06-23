/**
 * Input bar (Spec 06 §4): textarea with shortcut send, model + runtime selectors,
 * auto-approve / read-only toggles, and a send/interrupt button that flips while
 * a turn is streaming.
 */
import { useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { AgentMode, ModelInfo, RemoteRuntime } from '@vingsforge/shared';
import { Icon } from './Icon.js';
import {
  clampIndex,
  completeSlash,
  computeSlashPopup,
  type SlashEntry,
} from './slashPopup.js';

export interface InputBarProps {
  models: ModelInfo[];
  runtimes: RemoteRuntime[];
  model: string;
  runtimeId: string;
  agentMode: AgentMode;
  streaming: boolean;
  disabled?: boolean;
  /** CLI-advertised slash commands for the `/` popup (Objetivo 1). */
  slashCommands?: string[];
  /** CLI-advertised skills shown in a separate popup section (Objetivo 1). */
  skills?: string[];
  onModelChange(model: string): void;
  onRuntimeChange(id: string): void;
  onAgentModeChange(m: AgentMode): void;
  onSend(text: string): void;
  onInterrupt(): void;
}

export function InputBar(props: InputBarProps): JSX.Element {
  const [text, setText] = useState('');
  const [highlight, setHighlight] = useState(0);

  const popup = useMemo(
    () => computeSlashPopup(text, props.slashCommands ?? [], props.skills ?? []),
    [text, props.slashCommands, props.skills],
  );
  const popupActive = popup.open && !props.disabled && !props.streaming;
  const activeIndex = clampIndex(highlight, popup.entries.length);

  const setTextAndReset = (value: string): void => {
    setText(value);
    setHighlight(0);
  };

  const pick = (entry: SlashEntry): void => {
    setTextAndReset(completeSlash(entry));
  };

  const submit = (): void => {
    const value = text.trim();
    if (!value || props.streaming) return;
    props.onSend(value);
    setTextAndReset('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // While the slash popup is open, arrows/Enter/Tab/Esc drive the list rather
    // than the textarea (mirrors Claude Code's `/` menu).
    if (popupActive) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => clampIndex(h + 1, popup.entries.length));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => clampIndex(h - 1, popup.entries.length));
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && popup.entries.length > 0) {
        e.preventDefault();
        const entry = popup.entries[activeIndex];
        if (entry) pick(entry);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // Closing the popup without losing what was typed: append a space so the
        // text no longer parses as a bare slash command.
        setTextAndReset(`${text} `);
        return;
      }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div style={shell}>
      <div style={controls}>
        <select
          style={select}
          value={props.model}
          onChange={(e) => props.onModelChange(e.target.value)}
          aria-label="Model"
          disabled={props.disabled}
        >
          {props.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>

        <select
          style={select}
          value={props.runtimeId}
          onChange={(e) => props.onRuntimeChange(e.target.value)}
          aria-label="Runtime"
          disabled={props.disabled}
        >
          <option value="local">local</option>
          {props.runtimes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>

        <ModeSelector mode={props.agentMode} onChange={props.onAgentModeChange} disabled={props.disabled} />
      </div>

      <div style={inputRow}>
        <div style={textareaWrap}>
          {popupActive ? (
            <SlashPopup
              entries={popup.entries}
              activeIndex={activeIndex}
              emptyCatalog={popup.emptyCatalog}
              onPick={pick}
              onHover={setHighlight}
            />
          ) : null}
          <textarea
            style={textarea}
            value={text}
            placeholder={props.disabled ? 'Open a chat to start' : 'Message the agent…  (Ctrl/Cmd + Enter to send)'}
            onChange={(e) => setTextAndReset(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            disabled={props.disabled}
            aria-expanded={popupActive}
            aria-controls={popupActive ? 'vf-slash-popup' : undefined}
          />
        </div>
        {props.streaming ? (
          <button style={{ ...sendBtn, ...stopBtn }} onClick={props.onInterrupt} title="Interrupt">
            <Icon name="stop" size={16} />
          </button>
        ) : (
          <button style={sendBtn} onClick={submit} disabled={props.disabled || !text.trim()} title="Send">
            <Icon name="send" size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

interface ModeOption {
  value: AgentMode;
  label: string;
  title: string;
  risky?: boolean;
}

const MODE_OPTIONS: ModeOption[] = [
  { value: 'plan', label: 'Plano', title: 'Plano — só lê e planeja; não edita nem executa.' },
  { value: 'default', label: 'Padrão', title: 'Padrão — pede aprovação a cada ação.' },
  { value: 'acceptEdits', label: 'Edições', title: 'Aceitar edições — aprova edições de arquivo sozinho; pede para bash/comandos.' },
  { value: 'bypass', label: 'Bypass', title: 'Bypass — aprova tudo automaticamente (cuidado).', risky: true },
];

function ModeSelector({
  mode,
  onChange,
  disabled,
}: {
  mode: AgentMode;
  onChange(m: AgentMode): void;
  disabled?: boolean | undefined;
}): JSX.Element {
  return (
    <div style={modeGroup} role="radiogroup" aria-label="Modo do agente">
      {MODE_OPTIONS.map((opt) => {
        const active = opt.value === mode;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            disabled={disabled}
            title={opt.title}
            role="radio"
            aria-checked={active}
            style={{
              ...modeBtn,
              ...(active ? (opt.risky ? modeBtnRisky : modeBtnActive) : null),
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The `/`-command menu floating above the textarea (Objetivo 1). Groups entries
 * into Comandos / Skills sections, highlights the active row, and forwards
 * clicks / hovers up. Purely presentational — all matching lives in slashPopup.
 */
function SlashPopup({
  entries,
  activeIndex,
  emptyCatalog,
  onPick,
  onHover,
}: {
  entries: SlashEntry[];
  activeIndex: number;
  emptyCatalog: boolean;
  onPick(entry: SlashEntry): void;
  onHover(index: number): void;
}): JSX.Element {
  const commands = entries.filter((e) => e.kind === 'command');
  const skills = entries.filter((e) => e.kind === 'skill');

  const row = (entry: SlashEntry, index: number): JSX.Element => {
    const active = index === activeIndex;
    return (
      <button
        key={`${entry.kind}-${entry.name}`}
        type="button"
        role="option"
        aria-selected={active}
        // onMouseDown (not onClick) so the textarea never loses focus before the
        // pick is applied.
        onMouseDown={(e) => {
          e.preventDefault();
          onPick(entry);
        }}
        onMouseEnter={() => onHover(index)}
        style={{ ...slashRow, ...(active ? slashRowActive : null) }}
      >
        <span style={slashSlash}>/</span>
        <span style={slashName}>{entry.name}</span>
      </button>
    );
  };

  return (
    <div id="vf-slash-popup" role="listbox" aria-label="Comandos" style={popupStyle}>
      {emptyCatalog ? (
        <div style={slashHint}>Comandos aparecem após a 1ª mensagem.</div>
      ) : null}
      {commands.length > 0 ? (
        <>
          <div style={slashSection}>Comandos</div>
          {commands.map((e) => row(e, entries.indexOf(e)))}
        </>
      ) : null}
      {skills.length > 0 ? (
        <>
          <div style={slashSection}>Skills</div>
          {skills.map((e) => row(e, entries.indexOf(e)))}
        </>
      ) : null}
    </div>
  );
}

const shell: CSSProperties = {
  borderTop: '1px solid var(--vf-border)',
  padding: '10px 14px',
  background: 'var(--vf-bg-raised)',
};
const popupStyle: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 6px)',
  left: 0,
  right: 0,
  maxHeight: 240,
  overflowY: 'auto',
  background: 'var(--vf-bg-raised)',
  border: '1px solid var(--vf-border)',
  borderRadius: 9,
  boxShadow: '0 10px 30px rgba(0,0,0,0.4)',
  padding: 4,
  zIndex: 50,
};
const slashSection: CSSProperties = {
  padding: '6px 8px 4px',
  fontSize: 10.5,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  color: 'var(--vf-text-faint)',
};
const slashHint: CSSProperties = {
  padding: '8px 8px',
  fontSize: 12,
  color: 'var(--vf-text-muted)',
};
const slashRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 8px',
  borderRadius: 6,
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--vf-text)',
  fontFamily: 'inherit',
  fontSize: 13,
  textAlign: 'left',
  cursor: 'pointer',
};
const slashRowActive: CSSProperties = {
  background: 'var(--vf-accent-weak)',
  borderColor: 'var(--vf-accent)',
};
const slashSlash: CSSProperties = { color: 'var(--vf-accent)', fontWeight: 600 };
const slashName: CSSProperties = { color: 'var(--vf-text)' };
const controls: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' };
const select: CSSProperties = {
  background: 'var(--vf-surface)',
  color: 'var(--vf-text)',
  border: '1px solid var(--vf-border)',
  borderRadius: 7,
  padding: '5px 8px',
  fontSize: 12.5,
};
const modeGroup: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: 2,
  borderRadius: 999,
  border: '1px solid var(--vf-border)',
  background: 'var(--vf-bg-inset)',
  gap: 2,
};
const modeBtn: CSSProperties = {
  padding: '4px 11px',
  borderRadius: 999,
  border: '1px solid transparent',
  background: 'transparent',
  color: 'var(--vf-text-muted)',
  fontSize: 12,
  lineHeight: 1.4,
  transition: 'background 120ms ease, color 120ms ease',
};
const modeBtnActive: CSSProperties = {
  background: 'var(--vf-accent-weak)',
  borderColor: 'var(--vf-accent)',
  color: 'var(--vf-accent)',
};
const modeBtnRisky: CSSProperties = {
  background: 'color-mix(in srgb, var(--vf-danger) 18%, transparent)',
  borderColor: 'var(--vf-danger)',
  color: 'var(--vf-danger)',
};
const inputRow: CSSProperties = { display: 'flex', alignItems: 'flex-end', gap: 8 };
const textareaWrap: CSSProperties = { position: 'relative', flex: 1, minWidth: 0 };
const textarea: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  resize: 'none',
  padding: '10px 12px',
  borderRadius: 9,
  border: '1px solid var(--vf-border)',
  background: 'var(--vf-bg-inset)',
  color: 'var(--vf-text)',
  fontFamily: 'inherit',
  fontSize: 14,
  lineHeight: 1.5,
};
const sendBtn: CSSProperties = {
  width: 40,
  height: 40,
  display: 'grid',
  placeItems: 'center',
  borderRadius: 9,
  border: '1px solid var(--vf-accent)',
  background: 'var(--vf-accent)',
  color: '#0b0e13',
};
const stopBtn: CSSProperties = {
  background: 'var(--vf-danger)',
  borderColor: 'var(--vf-danger)',
  color: '#0b0e13',
};
