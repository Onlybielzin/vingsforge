/**
 * Settings screen (Spec 07 §3, §5). A modal/overlay — styled like
 * {@link ApiKeyOnboarding} — that lets the user configure global settings:
 *
 *  - Auth mode: use the machine's Claude plan login, or a stored ANTHROPIC_API_KEY
 *    (with Save / Test / Clear actions; the key is never logged nor rendered back).
 *  - Default model (Models API), default effort, theme (applied live), and the
 *    show-thinking / show-cost toggles.
 *
 * Every change is persisted via `settings.update` (or the dedicated key methods)
 * and the host store is re-read through `onChanged` so the rest of the app stays
 * in sync. The key value is never logged.
 */
import { useState, type CSSProperties } from 'react';
import type { Effort, GlobalSettings, ModelInfo } from '@vingsforge/shared';
import type { IpcClient } from '../ipc/client.js';
import { applyTheme } from '../theme/tokens.js';
import { Icon } from './Icon.js';

export interface SettingsScreenProps {
  ipc: IpcClient;
  /** Current settings (from the store). Null only while the first fetch is in flight. */
  settings: GlobalSettings | null;
  /** Models available for the default-model select (from the store). */
  models: ModelInfo[];
  /** Re-read settings into the host store after any persisted change. */
  onChanged(): void | Promise<void>;
  /** Close the modal. */
  onClose(): void;
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string };

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_LABEL: Record<Effort, string> = {
  low: 'Baixo',
  medium: 'Médio',
  high: 'Alto',
  xhigh: 'Muito alto',
  max: 'Máximo',
};

export function SettingsScreen({
  ipc,
  settings,
  models,
  onChanged,
  onClose,
}: SettingsScreenProps): JSX.Element {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: 'idle' });

  const authMode = settings?.authMode ?? 'plan';
  const apiKeyPresent = settings?.apiKeyPresent ?? false;

  // Persist a settings patch, then ask the host to re-read the store.
  const patch = async (p: Partial<GlobalSettings>): Promise<void> => {
    await ipc.settings.update(p);
    await onChanged();
  };

  const setAuthMode = (mode: 'plan' | 'apiKey'): void => {
    if (mode === authMode) return;
    setTest({ kind: 'idle' });
    void patch({ authMode: mode });
  };

  const setTheme = (theme: 'dark' | 'light'): void => {
    if (theme === settings?.theme) return;
    // Apply immediately so the change is visible before the round-trip resolves.
    applyTheme(theme);
    void patch({ theme });
  };

  const saveKey = async (): Promise<void> => {
    if (key.trim().length === 0 || busy) return;
    setBusy(true);
    setTest({ kind: 'idle' });
    try {
      await ipc.settings.setApiKey(key.trim());
      await ipc.settings.update({ authMode: 'apiKey' });
      setKey('');
      await onChanged();
    } catch (err) {
      setTest({ kind: 'error', message: messageOf(err) });
    } finally {
      setBusy(false);
    }
  };

  const testKey = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setTest({ kind: 'testing' });
    try {
      if (key.trim().length > 0) await ipc.settings.setApiKey(key.trim());
      const result = await ipc.settings.testApiKey();
      if (result.ok) {
        setTest({ kind: 'ok' });
        if (key.trim().length > 0) {
          await ipc.settings.update({ authMode: 'apiKey' });
          setKey('');
        }
        await onChanged();
      } else {
        setTest({ kind: 'error', message: result.error ?? 'Chave rejeitada pela API.' });
      }
    } catch (err) {
      setTest({ kind: 'error', message: messageOf(err) });
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setTest({ kind: 'idle' });
    try {
      await ipc.settings.clearApiKey();
      setKey('');
      await onChanged();
    } catch (err) {
      setTest({ kind: 'error', message: messageOf(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label="Configurações">
      <div style={card}>
        <div style={head}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="settings" size={18} style={{ color: 'var(--vf-accent)' }} />
            <h2 style={{ margin: 0, fontSize: 16 }}>Configurações</h2>
          </div>
          <button type="button" style={closeBtn} onClick={onClose} aria-label="Fechar">
            <Icon name="cross" size={16} />
          </button>
        </div>

        <div style={body}>
          {/* Auth mode */}
          <section style={group}>
            <h3 style={groupTitle}>Autenticação</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} role="radiogroup" aria-label="Modo de autenticação">
              <ModeOption
                selected={authMode === 'plan'}
                onSelect={() => setAuthMode('plan')}
                title="Usar meu plano Claude"
                subtitle="Usa o login do Claude na máquina. Sem API key."
              />
              <ModeOption
                selected={authMode === 'apiKey'}
                onSelect={() => setAuthMode('apiKey')}
                title="Usar API key"
                subtitle="Autentica com uma ANTHROPIC_API_KEY no armazenamento seguro."
              />
            </div>

            {authMode === 'apiKey' && (
              <div style={{ marginTop: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  {apiKeyPresent ? (
                    <span style={okStyle}>
                      <Icon name="check" size={14} /> Chave salva no armazenamento seguro.
                    </span>
                  ) : (
                    <span style={{ color: 'var(--vf-text-muted)', fontSize: 13 }}>
                      Nenhuma chave salva.
                    </span>
                  )}
                </div>

                <label style={label} htmlFor="vf-settings-key">
                  API key
                </label>
                <input
                  id="vf-settings-key"
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
                    style={dangerBtn}
                    disabled={busy || !apiKeyPresent}
                    onClick={() => void clearKey()}
                  >
                    Limpar
                  </button>
                  <button
                    type="button"
                    style={secondaryBtn}
                    disabled={busy}
                    onClick={() => void testKey()}
                  >
                    Testar
                  </button>
                  <button
                    type="button"
                    style={primaryBtn}
                    disabled={busy || key.trim().length === 0}
                    onClick={() => void saveKey()}
                  >
                    {busy ? 'Salvando…' : 'Salvar'}
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* Model + effort */}
          <section style={group}>
            <h3 style={groupTitle}>Modelo</h3>
            <div style={field}>
              <label style={label} htmlFor="vf-settings-model">
                Modelo padrão
              </label>
              <select
                id="vf-settings-model"
                style={select}
                value={settings?.defaultModel ?? ''}
                onChange={(e) => void patch({ defaultModel: e.target.value })}
              >
                {models.length === 0 && settings?.defaultModel && (
                  <option value={settings.defaultModel}>{settings.defaultModel}</option>
                )}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </div>

            <div style={field}>
              <label style={label} htmlFor="vf-settings-effort">
                Effort padrão
              </label>
              <select
                id="vf-settings-effort"
                style={select}
                value={settings?.defaultEffort ?? 'medium'}
                onChange={(e) => void patch({ defaultEffort: e.target.value as Effort })}
              >
                {EFFORTS.map((eff) => (
                  <option key={eff} value={eff}>
                    {EFFORT_LABEL[eff]}
                  </option>
                ))}
              </select>
            </div>
          </section>

          {/* Appearance + toggles */}
          <section style={group}>
            <h3 style={groupTitle}>Aparência</h3>
            <div style={field}>
              <label style={label} htmlFor="vf-settings-theme">
                Tema
              </label>
              <select
                id="vf-settings-theme"
                style={select}
                value={settings?.theme ?? 'dark'}
                onChange={(e) => setTheme(e.target.value as 'dark' | 'light')}
              >
                <option value="dark">Escuro</option>
                <option value="light">Claro</option>
              </select>
            </div>

            <Toggle
              id="vf-settings-thinking"
              label="Mostrar raciocínio"
              checked={settings?.showThinking ?? true}
              onChange={(v) => void patch({ showThinking: v })}
            />
            <Toggle
              id="vf-settings-cost"
              label="Mostrar custo"
              checked={settings?.showCost ?? true}
              onChange={(v) => void patch({ showCost: v })}
            />
          </section>
        </div>

        <div style={footer}>
          <button type="button" style={primaryBtn} onClick={onClose}>
            Fechar
          </button>
        </div>
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

function Toggle({
  id,
  label: text,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange(value: boolean): void;
}): JSX.Element {
  return (
    <label htmlFor={id} style={toggleRow}>
      <span style={{ fontSize: 13 }}>{text}</span>
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          style={{
            appearance: 'none',
            WebkitAppearance: 'none',
            width: 38,
            height: 22,
            borderRadius: 11,
            border: '1px solid var(--vf-border)',
            background: checked ? 'var(--vf-accent)' : 'var(--vf-bg-inset)',
            cursor: 'pointer',
            margin: 0,
            transition: 'background 0.15s',
          }}
        />
        <span
          style={{
            position: 'absolute',
            top: 3,
            left: checked ? 19 : 3,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: checked ? '#0b1020' : 'var(--vf-text-muted)',
            transition: 'left 0.15s',
            pointerEvents: 'none',
          }}
        />
      </span>
    </label>
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
  width: 'min(520px, calc(100vw - 32px))',
  maxHeight: 'calc(100vh - 48px)',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--vf-bg-raised)',
  border: '1px solid var(--vf-border)',
  borderRadius: 12,
  boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
  color: 'var(--vf-text)',
};
const head: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '16px 20px',
  borderBottom: '1px solid var(--vf-border)',
};
const closeBtn: CSSProperties = {
  background: 'transparent',
  border: '1px solid var(--vf-border)',
  borderRadius: 6,
  color: 'var(--vf-text-muted)',
  width: 28,
  height: 28,
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
};
const body: CSSProperties = { padding: '16px 20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 20 };
const group: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 };
const groupTitle: CSSProperties = {
  margin: 0,
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  color: 'var(--vf-text-faint)',
};
const field: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };
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
const label: CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: 'var(--vf-text-muted)',
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
const select: CSSProperties = {
  ...input,
  cursor: 'pointer',
};
const toggleRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  cursor: 'pointer',
  padding: '2px 0',
};
const status: CSSProperties = { minHeight: 20, marginTop: 10, fontSize: 13 };
const okStyle: CSSProperties = {
  color: 'var(--vf-accent)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 13,
};
const errStyle: CSSProperties = {
  color: 'var(--vf-danger)',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
};
const actions: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 };
const footer: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  padding: '14px 20px',
  borderTop: '1px solid var(--vf-border)',
};
const baseBtn: CSSProperties = {
  borderRadius: 8,
  padding: '8px 14px',
  fontSize: 13,
  fontFamily: 'inherit',
  cursor: 'pointer',
  border: '1px solid var(--vf-border)',
};
const secondaryBtn: CSSProperties = { ...baseBtn, background: 'var(--vf-surface)', color: 'var(--vf-text)' };
const dangerBtn: CSSProperties = { ...baseBtn, background: 'transparent', color: 'var(--vf-danger)', borderColor: 'var(--vf-danger)' };
const primaryBtn: CSSProperties = {
  ...baseBtn,
  background: 'var(--vf-accent)',
  color: '#0b1020',
  border: '1px solid var(--vf-accent)',
  fontWeight: 600,
};
