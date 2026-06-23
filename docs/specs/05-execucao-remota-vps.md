# Spec 05 — Execução Remota em VPS

> Depende de: [00 Visão Geral](00-visao-geral.md), [03 Motor](03-motor-claude.md)
> Status: rascunho

## 1. Objetivo

Permitir que o motor rode **em outra máquina (VPS)** em vez de localmente, mantendo a **mesma UI**.
O usuário conecta uma VPS, e projetos/chats podem usá-la como runtime. Casos de uso: workspace que
mora no servidor, ferramentas/dependências que só existem lá, máquinas mais potentes.

## 2. Modelo de conexão (default assumido)

- Um **daemon headless** (o mesmo motor empacotado sem UI) roda na VPS.
- O app desktop fala com o daemon por **WebSocket**, tunelado por **SSH** (sem expor porta pública).
- Autenticação do SSH: chave do usuário (o app não gerencia senhas; reusa `~/.ssh` ou caminho de chave configurado).
- **Verificação do host da VPS**: o app valida a host key apresentada contra `~/.ssh/known_hosts` ou, na falta, contra uma fingerprint fixada no primeiro contato (TOFU) e persistida no runtime. Mismatch é rejeitado com erro claro na UI (impede MITM que terminaria o SSH e faria proxy do WebSocket). Há `readyTimeout` (15s) para não pendurar em host inalcançável.
- A **chave da API da Claude** pode ficar no app (envia requisições saindo da VPS via daemon) **ou** na VPS (configurável). Default: a chave fica no daemon da VPS (segredo não trafega à toa).

```
App desktop ──SSH tunnel──▶ vps:porta-local ──ws──▶ forge-daemon (headless engine)
                                                       └─ executa tools no FS/shell da VPS
```

## 3. Requisitos funcionais

- **RF-01** Cadastrar uma VPS: host, usuário SSH, porta, caminho da chave, e caminho/instalação do daemon.
- **RF-02** Instalar/atualizar o daemon na VPS a partir do app (script de bootstrap: baixa binário/node, instala, registra serviço).
- **RF-03** Conectar/desconectar; indicador de status (online/offline/instalando/erro) por VPS.
- **RF-04** Navegar o filesystem da VPS para escolher workspace de um projeto remoto.
- **RF-05** Rodar um chat com `runtime = <vpsId>`: o motor executa no daemon; eventos chegam idênticos à UI.
- **RF-06** Override de runtime por projeto e por chat.
- **RF-07** Reconectar automaticamente e **retomar** o stream após queda (dedupe por id de evento).
- **RF-08** Encerrar/limpar sessões remotas ao fechar o app (configurável; manter rodando p/ tarefas longas).

## 4. Daemon (forge-daemon)

- Processo Node headless que expõe a **mesma API de motor** da Spec 03 sobre WebSocket.
- Comandos aceitos: `engine.send`, `engine.interrupt`, `tool.permission.resolve`, `fs.list`, `fs.read`, `daemon.health`.
- Eventos emitidos: idênticos a [Spec 00 §5], mais `daemon.status`.
- Guarda histórico localmente? Não — o **app** é a fonte de verdade do histórico (SQLite). O daemon recebe o histórico necessário a cada turno (ou referencia uma sessão em memória curta). Decisão: histórico viaja do app para o daemon a cada `engine.send` (stateless do lado do daemon, exceto run em andamento).
- Segredos: lê `ANTHROPIC_API_KEY` do ambiente do daemon quando a chave mora na VPS.

## 5. Permissões em runtime remoto

- O gating de permissão (Spec 04) acontece **na UI** (app), mesmo quando a tool roda na VPS:
  1. daemon emite `tool.permission`,
  2. app mostra o cartão e resolve,
  3. daemon executa (ou nega) e emite `tool.result`.
- `bash`/escritas rodam no shell/FS **da VPS**. Reforçar confinamento ao workspace remoto e timeouts no daemon.

## 6. Modelo de dados

```ts
interface RemoteRuntime {
  id: string;
  label: string;
  ssh: { host: string; port: number; user: string; keyPath?: string; hostFingerprint?: string };
  daemon: { installPath: string; version?: string };
  apiKeyLocation: 'app' | 'daemon';
  status: 'offline' | 'connecting' | 'online' | 'installing' | 'error';
}
```

## 7. Contrato IPC (app)

```ts
runtimes.list(): RemoteRuntime[]
runtimes.add(input): RemoteRuntime
runtimes.connect(id): void
runtimes.disconnect(id): void
runtimes.installDaemon(id): { log: stream }
runtimes.fsList(id, path): DirEntry[]
runtimes.remove(id): void
```

## 8. Resiliência

- Heartbeat no WebSocket; reconectar com backoff.
- Reconexão re-sincroniza eventos perdidos por id (sem replay nativo no WS → buscar histórico do run em andamento).
- Se a permissão estava pendente quando caiu a conexão, restaurar o cartão ao reconectar.

## 9. Fora de escopo (v1)

- Orquestrar várias VPS no mesmo chat.
- Containers/sandbox gerenciados (poderia evoluir para um modo "self-hosted sandbox").
- Sincronização de arquivos entre local e remoto.

## 10. Critérios de aceite

1. Cadastrar VPS, instalar daemon e ver status "online".
2. Criar projeto remoto, abrir chat e o agente lê/edita arquivos **na VPS**.
3. Aprovação de permissão funciona com a tool executando remotamente.
4. Queda de rede reconecta e retoma sem corromper o histórico.
