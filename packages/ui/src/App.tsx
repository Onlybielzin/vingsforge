/**
 * Renderer entrypoint (Spec 06). Applies the dark theme, picks a transport
 * (real sidecar WebSocket, with a fast fallback to the in-memory mock so the
 * browser preview keeps working) and renders the three-column shell behind the
 * store. Components never see which transport is live.
 */
import { useEffect, useMemo, useState } from 'react';
import './theme/global.css';
import { applyTheme } from './theme/tokens.js';
import { connectIpc, type IpcMode } from './ipc/bootstrap.js';
import type { IpcClient } from './ipc/client.js';
import { StoreProvider } from './state/store.js';
import { AppShell } from './components/AppShell.js';
import { DemoModeBanner } from './components/DemoModeBanner.js';

export interface AppProps {
  /** Inject a transport in tests; when set, the auto-connect/fallback is skipped. */
  ipc?: IpcClient;
  /** Forced mode label when `ipc` is injected (defaults to 'real'). */
  mode?: IpcMode;
}

export function App({ ipc, mode }: AppProps = {}): JSX.Element {
  // When a client is injected (tests / embedding), use it as-is. Otherwise probe
  // the sidecar and fall back to the mock — resolved asynchronously below.
  const [resolved, setResolved] = useState<{ client: IpcClient; mode: IpcMode } | null>(
    ipc ? { client: ipc, mode: mode ?? 'real' } : null,
  );

  useEffect(() => {
    applyTheme('dark');
  }, []);

  useEffect(() => {
    if (ipc) return;
    let cancelled = false;
    void connectIpc().then((result) => {
      if (!cancelled) setResolved(result);
    });
    return () => {
      cancelled = true;
    };
  }, [ipc]);

  const content = useMemo(() => {
    if (!resolved) return <Connecting />;
    return (
      <StoreProvider ipc={resolved.client}>
        {resolved.mode === 'mock' && <DemoModeBanner />}
        <AppShell />
      </StoreProvider>
    );
  }, [resolved]);

  return content;
}

function Connecting(): JSX.Element {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--vf-text-muted)',
        background: 'var(--vf-bg)',
        fontSize: 13,
      }}
    >
      Conectando…
    </div>
  );
}
