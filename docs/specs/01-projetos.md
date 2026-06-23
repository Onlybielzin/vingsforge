# Spec 01 — Projetos

> Depende de: [00 Visão Geral](00-visao-geral.md)
> Status: rascunho

## 1. Objetivo

Permitir que o usuário organize o trabalho em **projetos**. Cada projeto é uma **pasta no disco**
(o "workspace") mais metadados gerenciados pelo app. Os chats vivem dentro do projeto.

## 2. Requisitos funcionais

- **RF-01** Criar projeto a partir de uma pasta existente (file picker) ou criar pasta nova.
- **RF-02** Listar todos os projetos na sidebar, com nome, caminho e indicador de runtime (local/remoto).
- **RF-03** Abrir projeto → carrega seus chats e o explorador de arquivos do workspace.
- **RF-04** Renomear projeto (apenas o rótulo; não move a pasta).
- **RF-05** Remover projeto da lista. **Não apaga a pasta do disco** por padrão; pedir confirmação explícita e separada se o usuário quiser apagar arquivos.
- **RF-06** Cada projeto tem config própria (modelo padrão, runtime padrão, instruções de sistema do projeto, política de permissões). Herda de Settings global quando não definido.
- **RF-07** Detectar e ler um arquivo de instruções do projeto (ex.: `AGENTS.md` / `FORGE.md` na raiz do workspace) e injetá-lo no system prompt do agente.
- **RF-08** Projeto pode apontar para um workspace **local** ou **remoto** (caminho em uma VPS). Ver [Spec 05](05-execucao-remota-vps.md).

## 3. Modelo de dados

```ts
interface Project {
  id: string;                 // uuid
  name: string;               // rótulo editável
  workspace: WorkspaceRef;    // onde estão os arquivos
  runtimeId: string | 'local';// runtime padrão (local ou id de uma VPS)
  defaultModel?: string;      // ex.: 'claude-opus-4-8'
  systemPromptExtra?: string; // instruções do projeto (além do AGENTS.md detectado)
  permissionPolicy?: PermissionPolicy; // ver Spec 04
  createdAt: string;
  lastOpenedAt?: string;
}

type WorkspaceRef =
  | { kind: 'local'; path: string }
  | { kind: 'remote'; runtimeId: string; path: string };
```

Persistência do registro de projetos: tabela `projects` no SQLite (ver [Spec 08](08-persistencia.md)).
O conteúdo do workspace **nunca** é copiado para dentro do app — fica na pasta de origem.

## 4. Fluxos

### 4.1 Criar projeto (local)
1. Usuário clica "Novo projeto".
2. Escolhe pasta (existente ou nova).
3. App cria `Project` com `workspace.kind = 'local'`, salva no SQLite.
4. Se existir `AGENTS.md`/`FORGE.md`, marca para injeção no system prompt.
5. Abre o projeto com um chat vazio.

### 4.2 Criar projeto (remoto)
1. Usuário escolhe uma VPS já conectada (ver [Spec 05](05-execucao-remota-vps.md)).
2. Navega/escolhe um caminho na VPS (via daemon: list dir).
3. App cria `Project` com `workspace.kind = 'remote'`.

### 4.3 Remover
1. Confirmação "Remover da lista" (default, seguro).
2. Checkbox separado e destacado: "Também apagar a pasta do disco" — **off por padrão**, exige segunda confirmação.

## 5. Contrato IPC

```ts
projects.list(): Project[]
projects.create(input: { name?; workspace: WorkspaceRef; runtimeId? }): Project
projects.open(id: string): { project: Project; chats: ChatSummary[] }
projects.rename(id: string, name: string): void
projects.updateConfig(id: string, patch: Partial<Project>): Project
projects.remove(id: string, opts: { deleteFiles: boolean }): void
```

## 6. UI (resumo; detalhe em [Spec 06](06-interface-ui.md))

- Sidebar esquerda: lista de projetos, agrupados por runtime. Badge mostrando local vs VPS.
- Topo do projeto aberto: nome, caminho, seletor de runtime, botão de config.

## 7. Fora de escopo (v1)

- Mover/copiar pastas entre máquinas pelo app.
- Templates de projeto / scaffolding.

## 8. Critérios de aceite

1. Criar projeto local e ver os chats persistirem após reabrir o app.
2. `AGENTS.md` na raiz aparece refletido no comportamento do agente.
3. Remover projeto não apaga arquivos a menos que explicitamente pedido.
