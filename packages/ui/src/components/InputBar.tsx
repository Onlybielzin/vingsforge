/**
 * Input bar (Spec 06 §4): textarea with shortcut send, model + runtime selectors,
 * auto-approve / read-only toggles, and a send/interrupt button that flips while
 * a turn is streaming.
 */
import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { AgentMode, ModelInfo, RemoteRuntime } from '@vingsforge/shared';
import { Icon } from './Icon.js';

export interface InputBarProps {
  models: ModelInfo[];
  runtimes: RemoteRuntime[];
  model: string;
  runtimeId: string;
  agentMode: AgentMode;
  streaming: boolean;
  disabled?: boolean;
  onModelChange(model: string): void;
  onRuntimeChange(id: string): void;
  onAgentModeChange(m: AgentMode): void;
  onSend(text: string): void;
  onInterrupt(): void;
}

export function InputBar(props: InputBarProps): JSX.Element {
  const [text, setText] = useState('');

  const submit = (): void => {
    const value = text.trim();
    if (!value || props.streaming) return;
    props.onSend(value);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
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
        <textarea
          style={textarea}
          value={text}
          placeholder={props.disabled ? 'Open a chat to start' : 'Message the agent…  (Ctrl/Cmd + Enter to send)'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          disabled={props.disabled}
        />
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

const shell: CSSProperties = {
  borderTop: '1px solid var(--vf-border)',
  padding: '10px 14px',
  background: 'var(--vf-bg-raised)',
};
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
const textarea: CSSProperties = {
  flex: 1,
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
