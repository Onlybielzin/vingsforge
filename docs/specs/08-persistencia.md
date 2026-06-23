# Spec 08 — Persistência

> Depende de: todas as specs de feature
> Status: rascunho

## 1. Objetivo

Definir como projetos, chats, histórico e settings são armazenados de forma que reabrir o app
reconstrua o estado fielmente — incluindo blocos de `thinking` e `tool_result` necessários para
continuar a conversa no mesmo modelo.

## 2. Estratégia

- **SQLite** (via `better-sqlite3` ou similar no main process) para metadados e histórico.
- **Arquivos no disco**: o workspace do projeto fica na pasta de origem; o app **não** copia.
- **Secure storage do SO** para a chave de API (Spec 07).
- Local do banco: diretório de dados do app (`app.getPath('userData')`).

## 3. Esquema (v1)

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  workspace_kind TEXT NOT NULL,        -- 'local' | 'remote'
  workspace_path TEXT NOT NULL,
  runtime_id TEXT NOT NULL DEFAULT 'local',
  default_model TEXT,
  system_prompt_extra TEXT,
  permission_policy TEXT,              -- JSON
  created_at TEXT NOT NULL,
  last_opened_at TEXT
);

CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  model_override TEXT,
  runtime_override TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                  -- 'user' | 'assistant'
  blocks TEXT NOT NULL,                -- JSON: Block[] (Spec 02)
  usage TEXT,                          -- JSON
  created_at TEXT NOT NULL,
  seq INTEGER NOT NULL                 -- ordem dentro do chat
);

CREATE TABLE runtimes (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  ssh TEXT NOT NULL,                   -- JSON {host,port,user,keyPath}
  daemon TEXT NOT NULL,                -- JSON {installPath,version}
  api_key_location TEXT NOT NULL       -- 'app' | 'daemon'
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL                  -- JSON
);

CREATE INDEX idx_messages_chat_seq ON messages(chat_id, seq);
CREATE INDEX idx_chats_project ON chats(project_id);
```

## 4. Regras de integridade

- `blocks` guarda a sequência fiel de blocos do turno: `text`, `thinking` (com `signature`), `tool_use`, `tool_result`.
- Ao continuar um chat: reconstruir `messages` da API a partir de `blocks`, **preservando thinking inalterado** (mesmo modelo). Se o usuário trocou o modelo do chat, descartar thinking dos turnos anteriores (outros modelos ignoram).
- `ON DELETE CASCADE`: apagar projeto apaga chats e mensagens (mas **não** a pasta do workspace).
- `seq` garante ordem estável mesmo com timestamps iguais.

## 5. Migrações

- Tabela `settings` guarda `schema_version`. Migrações idempotentes aplicadas no boot do main process.

## 6. Exportar / importar

- Exportar chat para JSON/Markdown (sem segredos). Útil para backup e para a skill `createmd`.
- Importar projeto = registrar pasta existente + (opcional) histórico exportado.

## 7. Backup & tamanho

- Histórico pode crescer; oferecer "limpar chats arquivados" e VACUUM periódico.
- Futuro: FTS5 para busca no histórico.

## 8. Fora de escopo (v1)

- Sincronização do banco entre máquinas.
- Criptografia do banco inteiro (apenas a chave de API vai para secure storage).

## 9. Critérios de aceite

1. Reabrir o app reconstrói projetos, chats e histórico exatamente.
2. Continuar um chat antigo no mesmo modelo faz replay correto de thinking/tool_result.
3. Apagar projeto remove chats/mensagens do banco, preserva os arquivos do workspace.
4. Exportar chat nunca inclui a chave de API.
