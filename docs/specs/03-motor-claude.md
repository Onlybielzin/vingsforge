# Spec 03 — Motor Claude (Engine)

> Depende de: [00 Visão Geral](00-visao-geral.md)
> Status: rascunho

## 1. Objetivo

O **motor** é o loop agêntico que conversa com a API da Claude: monta o prompt, faz streaming,
detecta `tool_use`, executa ferramentas (com permissão), realimenta resultados e repete até o
agente terminar o turno. É o mesmo código no runtime local e no daemon remoto.

## 2. Decisões de plataforma

- **SDK:** `@anthropic-ai/sdk` (TypeScript), chamado diretamente com loop agêntico **manual** (controle fino para gating de permissão, logging e interrupção). *Não* usar o tool runner automático, porque precisamos pausar para aprovação humana.
- **Modelo padrão:** `claude-opus-4-8`. Selecionável por projeto/chat.
- **Pensamento:** `thinking: { type: 'adaptive', display: 'summarized' }` para mostrar progresso de raciocínio.
- **Effort:** `output_config: { effort: 'high' }` por padrão; configurável (`low|medium|high|xhigh|max`).
- **Streaming:** sempre usar `client.messages.stream(...)` (turnos podem ser longos; evita timeout de HTTP).
- **`max_tokens`:** 64000 (streaming) por padrão.

> Regra de modelo: usar exatamente os IDs canônicos (`claude-opus-4-8`, etc.), sem sufixo de data.
> Pensamento adaptativo é a única opção nas famílias 4.7/4.8 — `budget_tokens` retorna 400.

## 3. Montagem do prompt

Ordem de renderização `tools → system → messages` (relevante para cache de prompt):

1. **tools** — definições estáveis e ordenadas deterministicamente (ver [Spec 04](04-ferramentas-permissoes.md)).
2. **system** — prompt base do app + instruções do projeto (`AGENTS.md` + `systemPromptExtra`). Mantido **congelado** (sem timestamps/IDs voláteis) para preservar cache. `cache_control: { type: 'ephemeral' }` no último bloco de system.
3. **messages** — histórico do chat reconstruído dos blocos persistidos (Spec 02), com breakpoint de cache na última mensagem.

Contexto volátil (data atual, modo) entra como mensagem `role: 'system'` no fim de `messages`
(suportado no Opus 4.8) — preserva o prefixo cacheado.

## 4. Loop agêntico (pseudocódigo)

```ts
async function runTurn(chat, userText, emit) {
  const messages = buildMessages(chat, userText);
  while (true) {
    const stream = client.messages.stream({
      model: chat.model ?? 'claude-opus-4-8',
      max_tokens: 64000,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: chat.effort ?? 'high' },
      system: buildSystem(chat),
      tools: buildTools(chat),
      messages,
    });

    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'thinking_delta')
        emit({ type: 'thinking.delta', text: ev.delta.thinking });
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta')
        emit({ type: 'message.delta', text: ev.delta.text });
    }

    const msg = await stream.finalMessage();
    persistAssistant(chat, msg);
    messages.push({ role: 'assistant', content: msg.content });

    if (msg.stop_reason === 'refusal') { emit(refusal); break; }
    if (msg.stop_reason !== 'tool_use') { emit({ type: 'turn.end', ... }); break; }

    // executar tool_use blocks (com permissão), coletar tool_result
    const results = [];
    for (const block of msg.content.filter(b => b.type === 'tool_use')) {
      emit({ type: 'tool.start', tool: block.name, input: block.input, callId: block.id });
      const decision = await maybeAskPermission(chat, block, emit);   // Spec 04
      const out = decision.allow
        ? await executeTool(block.name, block.input, runtime)         // local ou remoto
        : { error: decision.denyMessage, is_error: true };
      emit({ type: 'tool.result', callId: block.id, output: out, isError: !!out.is_error });
      results.push({ type: 'tool_result', tool_use_id: block.id, content: out, is_error: !!out.is_error });
    }
    messages.push({ role: 'user', content: results });  // todos os resultados em UMA mensagem
  }
}
```

Regras importantes:
- Reanexar `msg.content` completo (inclui `thinking` e `tool_use`) ao histórico antes de processar tools.
- Todos os `tool_result` de um turno vão em **uma única** mensagem `user`.
- `stop_reason === 'pause_turn'` (tools server-side): reenviar para continuar; não adicionar "Continue.".
- Verificar `stop_reason === 'refusal'` **antes** de ler `content`.

## 5. Interrupção

`chats.interrupt(chatId)` aborta o stream atual (AbortController) no fim do bloco corrente; o motor
para de pedir novas tools e emite `turn.end` com stopReason `interrupted`. Estado persiste consistente.

## 6. Execução de ferramenta x runtime

`executeTool` é resolvido pelo **runtime ativo**:
- `local`: executa na máquina do usuário (fs/processos locais).
- `remote`: encaminha a chamada ao daemon na VPS, que executa lá e devolve o resultado (ver [Spec 05](05-execucao-remota-vps.md)).

O loop agêntico é idêntico; só a implementação de `executeTool` muda.

## 7. Configuração & chaves

- Chave de API lida de Settings (ver [Spec 07](07-configuracoes.md)); nunca hardcoded; nunca commitada.
- Suporta `ANTHROPIC_API_KEY`. (Futuro: perfis/OAuth.)

## 8. Eventos emitidos

Ver contrato unificado em [Spec 00 §5](00-visao-geral.md).

## 9. Fora de escopo (v1)

- Subagentes / orquestração multi-agente.
- Compaction server-side (entra quando chats ficarem longos).
- MCP servers (gancho previsto, implementação posterior).

## 10. Critérios de aceite

1. Um turno com leitura+edição de arquivo completa o loop e persiste corretamente.
2. Streaming de texto e de raciocínio aparece em tempo real.
3. Interromper no meio deixa histórico válido e continuável.
4. Trocar `effort`/modelo por chat tem efeito observável.
