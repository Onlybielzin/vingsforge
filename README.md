# VingsForge

App desktop **Linux-first** (Tauri 2 + sidecar Node + React) que usa a **Claude como motor** de um coding agent. Projetos são pastas; cada projeto contém chats. O motor usa o **login do `claude` CLI da máquina** (assinatura, sem API key) ou uma API key.

## Stack
- **Shell:** Tauri 2 (Rust + WebKitGTK)
- **Motor:** sidecar Node (`@vingsforge/sidecar`) que spawna o `claude` CLI em stream-json; ponte via WebSocket local (`ws://127.0.0.1:8731`)
- **UI:** React + Vite + TypeScript
- **Persistência:** SQLite (better-sqlite3) + arquivos no disco
- Monorepo pnpm: `packages/shared|sidecar|ui`, `apps/desktop`

## Dev
```sh
pnpm install
pnpm --filter @vingsforge/sidecar build
cd apps/desktop && pnpm tauri dev
```

Specs em `docs/specs/`.
