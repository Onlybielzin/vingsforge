# Spec 06 — Interface / UI

> Depende de: todas as specs de feature
> Status: rascunho

## 1. Objetivo

Definir a estética e a navegação. Meta: **interface bonita** e fluida, no nível dos coding agents
modernos, com foco em legibilidade do chat, cartões de ferramenta claros e troca rápida de
projeto/chat/runtime.

## 2. Princípios de design

- **Sem emoji** em UI ou código. Ícones via MCP `magic` / `logo_search` (regra do usuário).
- Layout de 3 colunas, denso mas respirável; dark mode por padrão, light opcional.
- Tipografia legível para chat; fonte mono para diffs/terminal.
- Microinterações e transições suaves; nada de "AI slop" genérico (evitar gradiente roxo padrão, fontes system).
- Feedback de estado sempre visível (streaming, executando tool, aguardando permissão, offline).

## 3. Layout

```
┌──────────────┬───────────────────────────────┬──────────────────┐
│  Sidebar     │  Painel principal             │  Painel direito  │
│  - Projetos  │  - Lista de chats / Conversa  │  - Explorer      │
│    (local +  │  - Input + seletor modelo/    │    de arquivos   │
│     VPS)     │    runtime + interromper      │  - ou Detalhes   │
│  - Settings  │                               │    do tool/diff  │
└──────────────┴───────────────────────────────┴──────────────────┘
```

- **Sidebar:** projetos agrupados por runtime, com badge local/VPS e status. Botão "novo projeto". Acesso a Settings.
- **Painel principal:** quando nenhum chat aberto → lista de chats do projeto + "novo chat". Quando aberto → a conversa.
- **Painel direito:** alterna entre explorer do workspace e o detalhe do tool/diff selecionado. Recolhível.

## 4. Conversa (detalhe)

- Bolhas user/assistant; markdown renderizado; blocos de código com highlight e botão copiar.
- **Painel de raciocínio** colapsável por turno (mostra `thinking.delta`).
- **Cartões de ferramenta** inline:
  - read/grep/glob → compacto, resultado colapsável.
  - edit/write → diff colorido.
  - bash → terminal embutido (comando + saída).
  - Estados: pendente / aguardando permissão / executando / ok / erro.
- **Cartão de permissão**: destaque visual, botões Permitir uma vez / Sempre permitir / Negar (+ motivo).
- **Barra de input**: textarea com envio por atalho, seletor de modelo, seletor de runtime, toggle auto-aprovar/read-only, botão interromper (durante turno).
- **Rodapé**: tokens do turno + acumulado + custo estimado.

## 5. Telas/estados

- Onboarding: pedir chave de API se ausente (ver [Spec 07](07-configuracoes.md)).
- Vazio: sem projetos → CTA criar projeto.
- Erros: chave inválida, refusal, VPS offline → banners claros e acionáveis.
- Loading/streaming: skeletons e indicadores de digitação/execução.

## 6. Acessibilidade & UX

- Navegação por teclado (trocar chat, novo chat, enviar, interromper).
- Command palette (busca de projetos/chats/ações).
- Persistir tamanho de painéis e último projeto/chat aberto.

## 7. Componentes (sugestão de implementação)

- React + Tailwind (ou CSS modules), componentes via MCP `magic` quando aplicável.
- Editor de diff: usar lib de diff/editor existente (ex.: CodeMirror/Monaco) no painel direito.

## 8. Fora de escopo (v1)

- Temas customizáveis pelo usuário além de dark/light.
- Layout mobile.

## 9. Critérios de aceite

1. Trocar entre projetos e chats é instantâneo e preserva estado/scroll.
2. Diffs e saída de bash são legíveis e copiáveis.
3. Cartão de permissão é óbvio e bloqueia o fluxo até decisão.
4. Nenhum emoji na UI; ícones consistentes.
