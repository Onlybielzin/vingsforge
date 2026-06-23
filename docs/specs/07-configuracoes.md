# Spec 07 — Configurações

> Depende de: [00 Visão Geral](00-visao-geral.md)
> Status: rascunho

## 1. Objetivo

Centralizar chaves, modelos, preferências e padrões. Configuração em camadas:
**global → projeto → chat** (mais específico vence).

## 2. Escopos

| Escopo | Onde fica | Exemplos |
|---|---|---|
| Global | Settings do app (SQLite + secure storage) | chave de API, tema, modelo padrão, effort padrão, política de permissão padrão |
| Projeto | `Project.config` (Spec 01) | modelo, runtime, system prompt extra, política de permissão |
| Chat | overrides do chat (Spec 02) | modelo, runtime, effort, auto-aprovar/read-only |

## 3. Configurações globais (v1)

- **Chave de API da Claude** (`ANTHROPIC_API_KEY`). Armazenada no **secure storage do SO** (Electron `safeStorage`/keychain), **nunca** em texto plano em arquivo versionável.
- **Modelo padrão**: `claude-opus-4-8` (lista populada da Models API quando online).
- **Effort padrão**: `high` (`low|medium|high|xhigh|max`).
- **Pensamento**: mostrar resumo de raciocínio (on/off) → controla `thinking.display`.
- **Política de permissão padrão** (Spec 04): defaults por tool.
- **Aparência**: dark/light, densidade.
- **Telemetria/custo**: exibir tokens e custo estimado (on/off).

## 4. Modelo de dados

```ts
interface GlobalSettings {
  apiKeyPresent: boolean;            // valor real no secure storage, não aqui
  defaultModel: string;
  defaultEffort: 'low'|'medium'|'high'|'xhigh'|'max';
  showThinking: boolean;
  permissionDefaults: Record<string, 'allow'|'ask'|'deny'>;
  theme: 'dark'|'light';
  showCost: boolean;
}
```

## 5. Contrato IPC

```ts
settings.get(): GlobalSettings
settings.update(patch: Partial<GlobalSettings>): GlobalSettings
settings.setApiKey(key: string): void        // grava no secure storage
settings.clearApiKey(): void
settings.testApiKey(): { ok: boolean; error?: string }   // faz 1 request mínima
models.list(): ModelInfo[]                    // via Models API quando online
```

## 6. Segurança

- Chave **nunca** logada, nunca no system prompt, nunca em export de chat.
- `testApiKey` faz uma chamada mínima e reporta erro tipado (401/403/etc.).
- Em runtime remoto, a chave pode morar no daemon (Spec 05); UI deixa claro onde está.

## 7. Onboarding

1. Primeiro uso sem chave → tela pede `ANTHROPIC_API_KEY`.
2. Botão "Testar" valida antes de seguir.
3. Sugere criar o primeiro projeto.

## 8. Fora de escopo (v1)

- Perfis OAuth / múltiplas contas.
- Configuração de MCP servers (gancho futuro).

## 9. Critérios de aceite

1. Salvar chave e validá-la; chave persiste em secure storage entre reinícios.
2. Trocar modelo/effort global reflete em novos chats que não têm override.
3. Override de chat vence o de projeto, que vence o global.
4. Exportar um chat não vaza a chave.
