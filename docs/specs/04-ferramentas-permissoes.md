# Spec 04 — Ferramentas & Permissões

> Depende de: [03 Motor](03-motor-claude.md)
> Status: rascunho

## 1. Objetivo

Definir o conjunto de **ferramentas** que o agente pode usar e o **sistema de permissão** que protege
ações com efeito colateral (escrever arquivo, rodar comando, push, etc.).

## 2. Conjunto de ferramentas (v1)

Ferramentas dedicadas (não só bash) para permitir gating, render bonito e checagem de staleness:

| Tool | Descrição | Permissão padrão |
|---|---|---|
| `read_file` | Lê arquivo do workspace | auto (read-only) |
| `list_dir` / `glob` | Lista/busca arquivos por padrão | auto |
| `grep` | Busca por regex no workspace | auto |
| `write_file` | Cria/sobrescreve arquivo | **perguntar** |
| `edit_file` | Substituição de string com checagem de versão | **perguntar** |
| `bash` | Executa comando no shell do runtime | **perguntar** |
| `web_search` (opcional) | Busca web server-side | auto |

> Critério de promover uma ação a tool dedicada: precisa ser **gated**, **renderizada** ou **paralelizável**.
> `read_file`/`grep`/`glob` são marcáveis como paralelizáveis (read-only). `bash`/`write`/`edit` são serializados e gated.

Definições enviadas com schema JSON estável e **ordenadas por nome** (preserva cache de prompt).

### 2.1 Esquemas (resumo)

```ts
read_file:  { path: string, range?: [number, number] }
list_dir:   { path: string }
glob:       { pattern: string }
grep:       { pattern: string, path?: string }
write_file: { path: string, content: string }      // strict + additionalProperties:false
edit_file:  { path: string, old_str: string, new_str: string }
bash:       { command: string, timeout_ms?: number }
```

`edit_file` rejeita a escrita se o arquivo mudou desde a última leitura do agente (staleness check).

## 3. Política de permissão

```ts
type Decision = 'allow' | 'ask' | 'deny';

interface PermissionPolicy {
  defaults: Record<string, Decision>;   // por tool
  rules?: PermissionRule[];              // overrides por padrão de input
  rememberedAllows?: string[];           // "sempre permitir" desta sessão/projeto
}

interface PermissionRule {
  tool: string;
  match?: { pathGlob?: string; commandRegex?: string };
  decision: Decision;
}
```

Resolução (precedência): regra específica > lembrança da sessão > default da tool > default global.

### 3.1 Fluxo de aprovação
1. Motor encontra um `tool_use` cujo decision = `ask`.
2. Emite `tool.permission` (Spec 00 §5) e **bloqueia** o loop.
3. UI mostra cartão: tool, input (diff para edits, comando para bash), botões: **Permitir uma vez**, **Sempre permitir (nesta sessão/projeto)**, **Negar** (+ campo opcional de motivo).
4. Decisão volta ao motor; `deny` vira `tool_result` com `is_error: true` e a mensagem de motivo, para o agente se ajustar.

### 3.2 Modos rápidos
- **Auto-aprovar** (toggle por chat): trata `ask` como `allow` (com aviso visual). Útil em runs autônomos.
- **Read-only**: força `write_file`/`edit_file`/`bash` para `deny`.

## 4. Segurança

- `path` e `command` vêm do modelo → **não confiáveis**.
- Toda operação de arquivo é confinada à raiz do workspace: resolver caminho canônico e rejeitar se escapar (`..`, symlink, caminho absoluto fora da raiz).
- `bash`: rodar no runtime (local ou VPS), com timeout e captura de stdout+stderr; logar todo comando; recomendável allowlist/políticas em runtime remoto.
- Nunca colocar segredos no system prompt ou nas mensagens.

## 5. UI dos cartões de ferramenta

- `read/grep/glob`: cartão compacto com resultado colapsável.
- `edit_file`/`write_file`: **diff** colorido.
- `bash`: comando + saída em terminal embutido.
- Estado: pendente / aguardando permissão / executando / ok / erro. Ícones via MCP `magic` (sem emoji).

## 6. Fora de escopo (v1)

- Tools de computer use.
- MCP toolsets (gancho previsto).
- Programmatic tool calling.

## 7. Critérios de aceite

1. `edit_file` pede aprovação e mostra diff; negar gera tool_result de erro e o agente reage.
2. "Sempre permitir" para de perguntar para aquela tool naquele escopo.
3. Tentativa de escrever fora da raiz do workspace é bloqueada.
4. Modo read-only impede qualquer escrita/execução.
