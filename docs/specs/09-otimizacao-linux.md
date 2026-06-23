# Spec 09 — Otimização para Linux

> Depende de: [00 Visão Geral](00-visao-geral.md)
> Status: rascunho
> Alvo primário: Linux desktop (dev em Mint 22.3 / Cinnamon / Wayland ou X11)

## 1. Objetivo

O app deve ser **o mais otimizado possível para Linux**: leve em RAM/CPU, binário pequeno,
inicialização rápida, integração nativa (tray, notificações, atalhos) e empacotamento idiomático
(AppImage / Flatpak / .deb). Esta spec define as decisões que tornam isso possível e **revisa a
escolha de shell** da Visão Geral.

## 2. Decisão de shell: Tauri (recomendado) vs Electron

| Critério | **Tauri 2** (recomendado p/ Linux) | Electron |
|---|---|---|
| Runtime de UI | WebKitGTK nativo do sistema | Chromium embarcado |
| Tamanho do binário | ~3–15 MB | ~120–180 MB |
| RAM em idle | ~tipicamente 5–10× menor | alto (processo Chromium) |
| Backend | Rust | Node |
| Motor em TS | via **sidecar Node** ou reescrita em Rust | nativo (mesmo processo) |
| Familiaridade (VingsHub) | nova | já usada |

**Recomendação:** **Tauri 2** como shell. É a opção que melhor atende "otimizado pra Linux".
Trade-off aceito: o motor (Spec 03), escrito em TypeScript com `@anthropic-ai/sdk`, roda como
**sidecar Node** gerenciado pelo Tauri (não reescrever em Rust na v1).

> Se a prioridade fosse reaproveitar 100% do código do VingsHub (Electron), ficaríamos com Electron —
> mas isso contraria o requisito de otimização. Decisão default: **Tauri + sidecar Node**.
> Esta é a única decisão "fork-in-the-road" desta spec; o resto segue dela.

## 3. Arquitetura com Tauri + sidecar

```
┌───────────────────────────────────────────────┐
│ Tauri (Rust core + WebKitGTK)                  │
│  ├─ Janela / WebView (React)                   │
│  ├─ Comandos Rust: janela, tray, fs picker,    │
│  │   secure storage, spawn do sidecar          │
│  └─ Bridge ⇄ sidecar (stdio/IPC local)         │
└───────────────▲────────────────────────────────┘
                │ stdio / unix socket
┌───────────────┴────────────────────────────────┐
│ Sidecar Node (forge-engine)                     │
│  ├─ Motor agêntico (Spec 03)                    │
│  ├─ SQLite (better-sqlite3)                     │
│  └─ Cliente SSH/WS p/ runtime remoto (Spec 05)  │
└─────────────────────────────────────────────────┘
```

- O **mesmo sidecar** é o que vira **forge-daemon** na VPS (Spec 05) — um binário Node empacotado.
- Comunicação Rust ⇄ sidecar: JSON sobre stdio (ou unix socket) com o mesmo contrato de eventos da
  [Spec 00 §5].
- Secure storage da chave de API: usar API nativa via Rust (Secret Service / libsecret no Linux) em
  vez de `safeStorage` do Electron (Spec 07).

## 4. Empacotamento e distribuição (Linux)

- **AppImage**: principal — roda em qualquer distro sem instalar.
- **.deb**: para Mint/Ubuntu/Debian (alvo do usuário).
- **Flatpak**: opcional, para sandbox e loja; cuidado com permissões de FS (workspace precisa de acesso).
- Sidecar Node empacotado como binário único (ex.: `bun build --compile`, `pkg` ou Node SEA) para não exigir Node instalado.
- Assinatura/checksum dos artefatos.

## 5. Integração nativa Linux

- **Tray icon** (Cinnamon/GNOME/KDE) via Tauri; ações rápidas (novo chat, abrir, mostrar/ocultar).
- **Notificações** nativas (turno concluído, permissão pendente, VPS caiu).
- **Atalho global** opcional para abrir/focar a janela.
- **File picker** nativo (portal XDG quando em Flatpak).
- **Wayland e X11**: testar nos dois; respeitar escala/HiDPI; sem assumir X11.
- **Tema do sistema**: detectar preferência dark/light do desktop (XDG settings portal) e aplicar.

## 6. Orçamento de performance (metas v1)

- Cold start até janela interativa: **< 1 s** em SSD.
- RAM em idle (1 chat aberto, sem turno): **< 150 MB** somando shell + sidecar.
- Binário do app (sem sidecar): **< 20 MB**; com sidecar: **< 80 MB**.
- Streaming de tokens sem travar a UI (render incremental, virtualização de listas longas de mensagens).
- SQLite com WAL; operações de histórico fora da thread de UI (no sidecar).

## 7. Boas práticas específicas

- WebKitGTK: testar performance de scroll/diff (CodeMirror tende a ser mais leve que Monaco no WebKitGTK → preferir CodeMirror no painel de diff da [Spec 06](06-interface-ui.md)).
- Evitar dependências pesadas no renderer; lazy-load do editor/diff.
- Aproveitar libs de sistema (libsecret, portals) em vez de reembarcar.
- Logs e cache em `$XDG_DATA_HOME` / `$XDG_CACHE_HOME`; dados em `$XDG_DATA_HOME/vingsforge`.

## 8. Impacto nas outras specs

- **Spec 00 §3**: shell passa a ser **Tauri 2 + sidecar Node** (substitui Electron como default).
- **Spec 07**: secure storage via Secret Service/libsecret (não `safeStorage`).
- **Spec 08**: caminho do banco segue XDG (`$XDG_DATA_HOME/vingsforge`) em vez de `app.getPath`.
- **Spec 05**: o daemon remoto é o mesmo binário do sidecar — reaproveitamento direto.
- Contratos de IPC/eventos permanecem; muda só o transporte (Tauri commands + stdio em vez de Electron IPC).

## 9. Fora de escopo (v1)

- Build para Windows/macOS (foco Linux primeiro; Tauri permite depois sem reescrever a UI).
- Reescrita do motor em Rust (avaliar só se o sidecar Node virar gargalo).
- Snap.

## 10. Critérios de aceite

1. AppImage e .deb gerados e rodando em Mint/Cinnamon (Wayland e X11).
2. Cold start < 1 s e RAM idle < 150 MB nos alvos.
3. Tray, notificações e tema do sistema funcionando nativamente.
4. Mesmo binário de sidecar roda como motor local e como daemon na VPS.
