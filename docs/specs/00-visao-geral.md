# Spec 00 — Visão Geral & Arquitetura

> Nome de trabalho: **VingsForge** (placeholder, trocável)
> Status: rascunho
> Última atualização: 2026-06-22

## 1. Objetivo

Um app desktop que usa a **Claude como motor** de um agente de código/trabalho, com interface bonita,
no estilo dos coding agents (OpenCode, Cabam, Nimbalyst). O usuário cria **projetos** (que são
pastas no disco), e dentro de cada projeto mantém vários **chats**. O agente pode rodar **localmente**
ou **remotamente em outras VPS**.

## 2. Conceitos centrais

| Conceito | O que é |
|---|---|
| **Projeto** | Uma pasta no disco + metadados. Contém chats, config própria, e um "workspace" (a árvore de arquivos). Ver [Spec 01](01-projetos.md). |
| **Chat** | Uma thread de conversa dentro de um projeto. Histórico persistido, retomável. Ver [Spec 02](02-chats.md). |
| **Motor (Engine)** | O loop agêntico que fala com a API da Claude, executa tool use e devolve eventos em streaming. Ver [Spec 03](03-motor-claude.md). |
| **Ferramentas** | Tools que o agente pode chamar (ler/escrever arquivo, bash, grep, etc.) com sistema de permissão. Ver [Spec 04](04-ferramentas-permissoes.md). |
| **Runtime** | Onde o motor executa: `local` (máquina do usuário) ou `remote` (VPS). Ver [Spec 05](05-execucao-remota-vps.md). |

## 3. Stack (default assumido)

> **Alvo primário: Linux, o mais otimizado possível.** Por isso o shell é **Tauri**, não Electron.
> Justificativa completa e trade-offs em [Spec 09](09-otimizacao-linux.md).

- **Shell desktop:** **Tauri 2** (Rust core + WebKitGTK nativo) — leve em RAM, binário pequeno, integração nativa Linux.
- **Motor:** `@anthropic-ai/sdk` (TypeScript), rodando como **sidecar Node** gerenciado pelo Tauri (loop agêntico manual com tool use + streaming). O **mesmo binário de sidecar** vira o daemon remoto na VPS.
- **UI:** React + TypeScript + Vite. Ícones via MCP `magic` / `logo_search` — **nunca emoji** (preferência do usuário). Diff/editor: CodeMirror (mais leve no WebKitGTK).
- **Modelo padrão:** `claude-opus-4-8`. Configurável por projeto/chat. Pensamento adaptativo (`thinking: { type: "adaptive" }`), `effort` configurável.
- **Persistência:** SQLite (metadados + histórico) + arquivos no disco (workspace), em caminhos XDG. Ver [Spec 08](08-persistencia.md).
- **Remoto:** daemon headless (o mesmo sidecar) rodando na VPS, acessível por túnel SSH + WebSocket de eventos.
- **Empacotamento:** AppImage + .deb (Mint/Ubuntu), Flatpak opcional. Ver [Spec 09](09-otimizacao-linux.md).

> Estas escolhas são o ponto de partida. Cada uma pode ser trocada sem reescrever as outras specs,
> desde que os contratos (modelo de dados, eventos do motor) sejam mantidos.

## 4. Arquitetura em camadas

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer (React)  — UI de projetos, chats, editor, settings │
└───────────────▲─────────────────────────────────────────────┘
                │ IPC (Electron) — contratos tipados
┌───────────────┴─────────────────────────────────────────────┐
│  Main process                                                │
│   ├─ ProjectManager   (CRUD de projetos/pastas)              │
│   ├─ ChatStore        (histórico, SQLite)                    │
│   ├─ EngineHost       (orquestra runtimes local/remote)      │
│   └─ SettingsStore    (chaves, modelos, prefs)               │
└───────────────▲──────────────────────────┬──────────────────┘
                │ in-process                │ SSH / WebSocket
┌───────────────┴───────────┐   ┌──────────┴──────────────────┐
│  Engine (local runtime)    │   │  Engine daemon (VPS remote) │
│   loop agêntico + tools     │   │   mesmo motor, headless     │
└────────────────────────────┘   └─────────────────────────────┘
```

O **Engine** é o mesmo código nos dois runtimes; só muda *onde* o processo roda e *como* a UI fala com ele
(sidecar local via stdio vs WebSocket sobre SSH). Com Tauri, o "Main process" do diagrama é o core
Rust do Tauri, e o Engine local é o **sidecar Node** que ele gerencia — ver [Spec 09](09-otimizacao-linux.md).

## 5. Contrato unificado de eventos do motor

Todo runtime (local ou remoto) emite a mesma sequência de eventos para a UI. Isto é o que mantém o app
agnóstico de onde o agente roda:

```ts
type EngineEvent =
  | { type: 'message.delta'; chatId: string; text: string }          // token de texto
  | { type: 'thinking.delta'; chatId: string; text: string }         // resumo de raciocínio
  | { type: 'tool.start'; chatId: string; tool: string; input: unknown; callId: string }
  | { type: 'tool.permission'; chatId: string; callId: string; tool: string; input: unknown } // espera aprovação
  | { type: 'tool.result'; chatId: string; callId: string; output: unknown; isError: boolean }
  | { type: 'turn.end'; chatId: string; stopReason: string; usage: Usage }
  | { type: 'error'; chatId: string; message: string }
```

Detalhamento dos comandos de entrada (enviar mensagem, aprovar tool, interromper) em [Spec 03](03-motor-claude.md).

## 6. Mapa das specs

| # | Spec | Cobre |
|---|---|---|
| 00 | Visão Geral (este doc) | Arquitetura, stack, contratos |
| 01 | [Projetos](01-projetos.md) | Criar/listar/abrir/remover pastas-projeto |
| 02 | [Chats](02-chats.md) | Threads, histórico, retomada |
| 03 | [Motor Claude](03-motor-claude.md) | Loop agêntico, streaming, modelos |
| 04 | [Ferramentas & Permissões](04-ferramentas-permissoes.md) | Tool use e gating |
| 05 | [Execução Remota em VPS](05-execucao-remota-vps.md) | Daemon, SSH, conexões |
| 06 | [Interface / UI](06-interface-ui.md) | Telas, navegação, estética |
| 07 | [Configurações](07-configuracoes.md) | Chaves, modelos, prefs |
| 08 | [Persistência](08-persistencia.md) | SQLite + arquivos, esquema |
| 09 | [Otimização Linux](09-otimizacao-linux.md) | Tauri, empacotamento, performance, integração nativa |

## 7. Fora de escopo (v1)

- Colaboração multi-usuário em tempo real no mesmo chat.
- Marketplace de plugins.
- Mobile.
- Billing/contas (usa a chave de API do próprio usuário).

## 8. Critérios de aceite da v1

1. Criar um projeto apontando para uma pasta e abrir um chat nele.
2. Conversar com o agente; ele lê/edita arquivos do workspace com aprovação de permissão.
3. Histórico do chat persiste entre reinícios do app.
4. Conectar uma VPS e rodar o mesmo chat com o agente executando lá, com a mesma UI.
