# Spec 02 — Chats

> Depende de: [00 Visão Geral](00-visao-geral.md), [01 Projetos](01-projetos.md), [03 Motor](03-motor-claude.md)
> Status: rascunho

## 1. Objetivo

Dentro de um projeto, o usuário mantém múltiplos **chats** (threads). Cada chat tem seu próprio
histórico de mensagens, é retomável, e roda no runtime do projeto (ou em um override do chat).

## 2. Requisitos funcionais

- **RF-01** Criar novo chat dentro do projeto.
- **RF-02** Listar chats do projeto (título, data, prévia da última mensagem).
- **RF-03** Abrir chat → renderiza histórico completo (mensagens, tool calls, resultados, raciocínio resumido).
- **RF-04** Enviar mensagem → dispara um turno do motor (ver [Spec 03](03-motor-claude.md)) com streaming na UI.
- **RF-05** Interromper um turno em andamento.
- **RF-06** Renomear chat. Título automático sugerido a partir da 1ª mensagem.
- **RF-07** Arquivar/excluir chat.
- **RF-08** Override de modelo e de runtime por chat (default herdado do projeto).
- **RF-09** Persistir histórico de forma que reabrir o app reconstrua o estado exatamente, incluindo blocos de pensamento (para continuar no mesmo modelo) e tool results.
- **RF-10** Mostrar uso de tokens/custo estimado por turno e acumulado no chat.

## 3. Modelo de dados

```ts
interface Chat {
  id: string;
  projectId: string;
  title: string;
  modelOverride?: string;
  runtimeOverride?: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
}

// Histórico = sequência de turnos; cada turno tem blocos.
interface ChatMessage {
  id: string;
  chatId: string;
  role: 'user' | 'assistant';
  blocks: Block[];          // text, thinking, tool_use, tool_result
  usage?: Usage;
  createdAt: string;
}

type Block =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; signature?: string }   // preservado verbatim p/ replay
  | { kind: 'tool_use'; callId: string; tool: string; input: unknown }
  | { kind: 'tool_result'; callId: string; output: unknown; isError: boolean };
```

> Importante: ao reenviar o histórico para a API (a API é stateless), os blocos de `thinking` devem
> ser repassados **inalterados** quando o chat continua no mesmo modelo. Trocar de modelo no meio do
> chat invalida o cache e descarta thinking — ver [Spec 03](03-motor-claude.md).

## 4. Ciclo de um turno (UI)

1. Usuário envia texto.
2. UI cria `ChatMessage` user e otimisticamente renderiza.
3. EngineHost inicia turno; UI consome `EngineEvent` (ver Spec 00 §5):
   - `thinking.delta` → painel de raciocínio (colapsável).
   - `message.delta` → bolha do assistente.
   - `tool.start` / `tool.permission` / `tool.result` → cartões de ferramenta inline.
   - `turn.end` → grava `ChatMessage` assistant final + usage.
4. Se `tool.permission` chega, UI bloqueia e mostra aprovar/negar (ver [Spec 04](04-ferramentas-permissoes.md)).

## 5. Contrato IPC

```ts
chats.list(projectId: string): ChatSummary[]
chats.create(projectId: string, opts?: { model?; runtimeId? }): Chat
chats.history(chatId: string): ChatMessage[]
chats.send(chatId: string, text: string): void          // emite EngineEvent via stream
chats.interrupt(chatId: string): void
chats.rename(chatId: string, title: string): void
chats.archive(chatId: string): void
chats.delete(chatId: string): void
```

Stream de eventos: canal IPC dedicado `engine.events` (renderer assina por `chatId`).

## 6. UI (resumo)

- Coluna central: lista de chats (quando nenhum aberto) ou a conversa (quando aberto).
- Conversa: bolhas, cartões de tool, painel de pensamento colapsável, barra de input com seletor de modelo/runtime e botão de interromper.
- Rodapé do chat: tokens do turno + acumulado.

## 7. Fora de escopo (v1)

- Ramificar (fork) um chat a partir de uma mensagem.
- Busca full-text no histórico (pode entrar depois via SQLite FTS).

## 8. Critérios de aceite

1. Criar dois chats no mesmo projeto, alternar e ver históricos independentes.
2. Interromper um turno deixa o histórico consistente.
3. Reabrir o app reconstrói o chat com tool calls e resultados visíveis.
4. Continuar a conversa após reabrir funciona (replay de thinking correto).
