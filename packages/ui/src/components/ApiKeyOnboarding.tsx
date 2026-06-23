/**
 * Auth onboarding (Spec 07 §3, §5). Shown on first run (or when the API-key mode
 * is selected but no key is stored). Lets the user pick how Claude authenticates:
 *
 *  - Plano (default): use the Claude Code login already present on this machine.
 *    No key required — just confirm and the app sets authMode='plan'.
 *  - API key: paste the ANTHROPIC_API_KEY, Save it (settings.setApiKey) and
 *    optionally Test it (settings.testApiKey). The key value is never logged and
 *    never rendered back — the field is a password input, cleared on success.
 */
import { useState, type CSSProperties } from 'react';
import type { IpcClient } from '../ipc/client.js';
import { Icon } from './Icon.js';

export interface ApiKeyOnboardingProps {
  ipc: IpcClient;
  /** The persisted auth mode, used to preselect the option on open. */
  authMode: 'plan' | 'apiKey' | undefined;
  /** Called after auth is configured so the host can re-read settings. */
  onSaved(): void | Promise<void>;
}

type Choice = 'plan' | 'apiKey';

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string };

export function ApiKeyOnboarding({ ipc, authMode, onSaved }: ApiKeyOnboardingProps): JSX.Element {
  // Default the selection to 'plan' (the recommended, no-key path) unless the
  // user has already chosen the API-key mode.
  const [choice, setChoice] = useState<Choice>(authMode === 'apiKey' ? 'apiKey' : 'plan');
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  const canSubmitKey = key.trim().length > 0 && !saving;

  // Plan mode: no key needed — persist authMode='plan' and close.
  const continueWithPlan = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setTest({ kind: 'idle' });
    try {
      await ipc.settings.update({ authMode: 'plan' });
      await onSaved();
    } catch (err) {
      setTest({ kind: 'error', message: messageOf(err) });
    } finally {
      setSaving(false);
    }
  };

  const saveKey = async (): Promise<void> => {
    if (!canSubmitKey) return;
    setSaving(true);
    setTest({ kind: 'idle' });
    try {
      await ipc.settings.setApiKey(key.trim());
      await ipc.settings.update({ authMode: 'apiKey' });
      setKey('');
      await onSaved();
    } catch (err) {
      setTest({ kind: 'error', message: messageOf(err) });
    } finally {
      setSaving(false);
    }
  };

  // Test validates whatever key is currently stored. If the user typed a new
  // key but has not saved it, save it first so the test reflects their input.
  const runTest = async (): Promise<void> => {
    setTest({ kind: 'testing' });
    try {
      if (key.trim().length > 0) await ipc.settings.setApiKey(key.trim());
      const result = await ipc.settings.testApiKey();
      if (result.ok) {
        setTest({ kind: 'ok' });
        await ipc.settings.update({ authMode: 'apiKey' });
        setKey('');
        await onSaved();
      } else {
        setTest({ kind: 'error', message: result.error ?? 'Key rejected by the API.' });
      }
    } catch (err) {
      setTest({ kind: 'error', message: messageOf(err) });
    }
  };

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label="Configurar autenticação">
      <div style={card}>
        <div style={head}>
          <Icon name="lock" size={18} style={{ color: 'var(--vf-accent)' }} />
          <h2 style={{ margin: 0, fontSize: 16 }}>Como o Claude vai autenticar</h2>
        </div>

        <div style={choices} role="radiogroup" aria-label="Modo de autenticação">
          <ModeOption
            selected={choice === 'plan'}
            onSelect={() => setChoice('plan')}
            title="Usar meu plano Claude"
            subtitle="Usa o login do Claude Code já presente nesta máquina. Sem API key."
          />
          <ModeOption
            selected={choice === 'apiKey'}
            onSelect={() => setChoice('apiKey')}
            title="Usar uma API key"
            subtitle="Autentica com uma ANTHROPIC_API_KEY guardada no armazenamento seguro."
          />
        </div>

        {choice === 'plan' ? (
          <>
            <p style={hint}>
              O app vai usar a sessão do Claude Code já logada nesta máquina. Você pode
              trocar para uma API key depois nas configurações.
            </p>
            <div style={actions}>
              <button
                type="button"
                style={primaryBtn}
                disabled={saving}
                onClick={() => void continueWithPlan()}
              >
                {saving ? 'Salvando…' : 'Continuar'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p style={hint}>
              Cole sua ANTHROPIC_API_KEY. A chave é guardada no armazenamento seguro do
              sistema e nunca aparece nos logs.
            </p>

            <label style={label} htmlFor="vf-api-key">
              API key
            </label>
            <input
              id="vf-api-key"
              style={input}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-ant-..."
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                if (test.kind !== 'idle') setTest({ kind: 'idle' });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveKey();
              }}
            />

            <div style={status} aria-live="polite">
              {test.kind === 'testing' && (
                <span style={{ color: 'var(--vf-text-muted)' }}>Testando…</span>
              )}
              {test.kind === 'ok' && (
                <span style={okStyle}>
                  <Icon name="check" size={14} /> Chave válida.
                </span>
              )}
              {test.kind === 'error' && (
                <span style={errStyle}>
                  <Icon name="cross" size={14} /> {test.message}
                </span>
              )}
            </div>

            <div style={actions}>
              <button
                type="button"
                style={secondaryBtn}
                disabled={saving || key.trim().length === 0}
                onClick={() => void runTest()}
              >
                Testar
              </button>
              <button
                type="button"
                style={primaryBtn}
                disabled={!canSubmitKey}
                onClick={() => void saveKey()}
              >
                {saving ? 'Salvando…' : 'Salvar'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ModeOption({
  selected,
  onSelect,
  title,
  subtitle,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  subtitle: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      style={{
        ...optionBtn,
        borderColor: selected ? 'var(--vf-accent)' : 'var(--vf-border)',
        background: selected ? 'var(--vf-surface)' : 'var(--vf-bg-inset)',
      }}
    >
      <span style={radioDot}>
        {selected && <Icon name="check" size={12} style={{ color: 'var(--vf-accent)' }} />}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, textAlign: 'left' }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
        <span style={{ fontSize: 12, color: 'var(--vf-text-muted)', lineHeight: 1.4 }}>
          {subtitle}
        </span>
      </span>
    </button>
  );
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return 'Falha ao salvar.';
}

const overlay: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100,
};
const card: CSSProperties = {
  width: 'min(460px, calc(100vw - 32px))',
  background: 'var(--vf-bg-raised)',
  border: '1px solid var(--vf-border)',
  borderRadius: 12,
  padding: 20,
  boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
  color: 'var(--vf-text)',
};
const head: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 };
const choices: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 4 };
const optionBtn: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid var(--vf-border)',
  borderRadius: 10,
  padding: '11px 12px',
  cursor: 'pointer',
  color: 'var(--vf-text)',
  fontFamily: 'inherit',
};
const radioDot: CSSProperties = {
  flex: '0 0 auto',
  width: 18,
  height: 18,
  borderRadius: '50%',
  border: '1px solid var(--vf-border)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  marginTop: 1,
};
const hint: CSSProperties = {
  color: 'var(--vf-text-muted)',
  fontSize: 13,
  lineHeight: 1.5,
  margin: '12px 0 14px',
};
const label: CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: 'var(--vf-text-muted)',
  marginBottom: 6,
};
const input: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'var(--vf-bg-inset)',
  border: '1px solid var(--vf-border)',
  borderRadius: 8,
  color: 'var(--vf-text)',
  padding: '9px 11px',
  fontSize: 13,
  fontFamily: 'inherit',
  outline: 'none',
};
const status: CSSProperties = { minHeight: 20, marginTop: 10, fontSize: 13 };
const okStyle: CSSProperties = {
  color: 'var(--vf-accent)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};
const errStyle: CSSProperties = {
  color: 'var(--vf-danger)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};
const actions: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 };
const baseBtn: CSSProperties = {
  borderRadius: 8,
  padding: '8px 14px',
  fontSize: 13,
  fontFamily: 'inherit',
  cursor: 'pointer',
  border: '1px solid var(--vf-border)',
};
const secondaryBtn: CSSProperties = { ...baseBtn, background: 'var(--vf-surface)', color: 'var(--vf-text)' };
const primaryBtn: CSSProperties = {
  ...baseBtn,
  background: 'var(--vf-accent)',
  color: '#0b1020',
  border: '1px solid var(--vf-accent)',
  fontWeight: 600,
};
