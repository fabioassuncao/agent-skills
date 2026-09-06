# Prompt — completar a paridade do WebMux: as rotas de mutação que ficaram de fora

> **Leia primeiro, nesta ordem:**
> 1. `docs/research/2026-09-06-webmux-absorption-prompt.md` — o enunciado da absorção. **Todas** as restrições, invariantes, ADRs e portões dele continuam valendo aqui, sem exceção.
> 2. `docs/research/2026-09-06-webmux-absorption.md` — o plano. §14, §16, §19, §22, §45.1, §45.3, §48, §49, §50.
> 3. `docs/absorption-trace.md` — as 27 fichas do que já entrou. **Não reimplemente o que já existe.**
> 4. `docs/provenance.md` — o mapa origem → destino.
>
> Baseline congelado: `.references/webmux-main/` @ `d8c9d5fa2fc061bff1425de2910d784a48961f1e`. **Somente leitura.**

---

## 1. O diagnóstico, medido

A absorção portou **o frontend inteiro** (39 componentes, 148 casos de teste) e **não escreveu o backend de mutação**. O resultado é uma interface que parece completa no código e é inerte na tela.

Medido no código, não inferido:

```
Rotas que o servidor atende hoje (src/web/server.ts):
  /api/agent-events   /api/agent-sessions  /api/config      /api/config/agent
  /api/config/routing /api/diagnostics     /api/events      /api/health
  /api/project-inits  /api/projects        /api/sessions    /api/status
  /api/stream         /api/terminal/token  /api/worktrees   ← GET, leitura apenas

Métodos que o frontend já chama e que NÃO EXISTEM no servidor:
  api.createWorktree      api.mergeWorktree     api.removeWorktree
  api.pullMain            api.createAgent       api.createWorktreeTab
```

Sete diálogos já portados estão importados, montados e **inalcançáveis**, porque a capability que os libera nunca é anunciada: `CreateWorktreeDialog`, `WorktreeLabelDialog`, `WorktreeProfileDialog`, `AgentEditorDialog`, `DiffDialog`, `CommentReviewDialog`, `CiDetailsDialog`.

A ficha da Fase 8D registra isso textualmente — *"são o backend que `worktrees` promete e que ninguém escreveu"* — e mesmo assim o Roteiro A de §48.6 foi declarado verde. **Foi um erro de aferição:** os fluxos foram verificados contra a existência dos módulos, não contra o que a interface entrega a uma pessoa. Não repita isso; a seção 6 deste documento existe exatamente para impedi-lo.

### 1.1 Uma causa imediata, separada das demais

O monitor sobe em `0.0.0.0` por default. Por ADR-10, **toda** capability de escrita é retida fora de loopback (`src/commands/serve.ts:140,165` → `writable: isLoopbackHost(host)`). Com isso, `session:open` não é anunciada e o botão "Nova sessão" — que **existe** em `web/src/App.svelte:1611` — não renderiza.

`issue-flow serve --host 127.0.0.1` devolve o botão e a superfície de terminal hoje, sem nenhuma mudança de código. Isso **não** resolve nada do resto deste documento, mas separa um problema de configuração de um problema de porte. Confirme esse comportamento antes de começar, para não atribuir ao porte o que é do bind.

---

## 2. Duas decisões que o dono do projeto está revertendo — deliberadamente

Estas duas ausências **não** eram defeitos: eram decisões documentadas. O dono do projeto pediu explicitamente as duas de volta. Implemente-as sabendo que está sobrepondo uma decisão registrada, e **atualize os ADRs em vez de contradizê-los em silêncio**.

| Decisão original | Onde | Revertida para |
|---|---|---|
| **ADR-14 — Linear não é absorvido** (`DISCARD`, 2.128 LOC, 79 casos descartados) | plano §3 cap. 40, §22, §50.8 | Portar a integração Linear: auto-create de worktrees por ticket, o painel, o badge, o "postar conversa" e a seção de configuração |
| **§50.4 colisão 3 — 5 paletas viram 3 modos** (`system`/`light`/`dark`) | plano §50.4, ADR-19 | Portar as 5 paletas do upstream (GitHub Dark, Dracula, Nord, Solarized Dark, One Dark) **como adição**, mantendo os 3 modos |

**Sobre as paletas — a única parte com condição técnica.** ADR-19 diz que os tokens do Issue Flow são a fonte da verdade e que o gate é a tabela de contraste. Os 19 pares são recalculados **na página** por `web/src/lib/contrast.ts` e medidos por `web/measure.html`. Uma paleta nova entra **com os 19 pares medidos e aprovados**, ou não entra. Se uma das cinco reprovar num par, ajuste o token daquele papel naquela paleta até passar e **registre o ajuste** — não baixe o limiar, não desligue o teste, não adicione exceção. O limiar de badge é 4,5:1 e não 3:1, e `web/AGENTS.md` explica por quê.

Atualize `docs/absorption-trace.md`, `docs/provenance.md` e o texto dos ADRs 14 e 19 para refletir a reversão, com a data e o motivo ("pedido do dono do projeto"). Uma decisão revertida que continua escrita como vigente é pior do que nunca ter sido registrada.

---

## 3. O que implementar

Ordem obrigatória: **bloco A → B → C → D**. Cada bloco entrega valor sozinho e o seguinte depende do anterior. Não comece o B com o A vermelho.

### Bloco A — as rotas de mutação de worktree

O núcleo. Sem ele, nada na tela funciona.

| Rota | Upstream (`backend/src/server.ts`) | Handler upstream | Destino no Issue Flow |
|---|---|---|---|
| `POST /api/worktrees` | `:1998` | `apiCreateWorktree` `:1218` | `src/web/worktrees-api.ts` |
| `DELETE /api/worktrees/:name` | `:2006` | `apiDeleteWorktree` | idem |
| `POST /api/worktrees/:name/open` | `:2015` | `apiOpenWorktree` | idem |
| `POST /api/worktrees/:name/close` | `:2033` | `apiCloseWorktree` | idem |
| `POST /api/worktrees/:name/merge` | `:2143` | `apiMergeWorktree` `:1494` | idem |
| `PUT /api/worktrees/:name/archive` | `:2051` | `apiSetWorktreeArchived` | idem |
| `PUT /api/worktrees/:name/label` | `:2078` | `apiSetWorktreeLabel` `:1447` | idem |
| `PUT /api/worktrees/:name/profile` | `:2087` | `apiSetWorktreeProfile` | idem |
| `GET /api/worktrees/:name/diff` | `:2152` | `apiGetWorktreeDiff` `:1750` | idem |
| `POST /api/worktrees/:name/send` | `:2096` | `apiSendPrompt` | idem |
| `POST /api/pull-main` | `:2173` | `apiPullMain` | idem |
| `GET /api/branches` · `GET /api/base-branches` | `:1917` · `:1921` | `apiListBranches` · `apiListBaseBranches` | idem |

**A regra que decide se este bloco ficou certo.** Nenhuma dessas rotas reimplementa nada. Todo o comportamento já existe e está testado:

- criar/remover worktree → `src/runtime/worktree/lifecycle.ts` (`createWorktreeManager`)
- merge com rollback → `src/runtime/worktree/git.ts` (`mergeBranch`, restaura o checkout mesmo na falha)
- abrir/fechar sessão no worktree → `src/agents/session/open.ts` (`openAgentSession`, `stopAgentSession`)
- enviar prompt → `src/agents/session/open.ts` (`sendToAgentSession`)
- profiles → `src/runtime/profiles.ts` · portas e saúde → `src/runtime/services.ts`
- listar branches → `src/utils/git.ts`

A rota é **transporte**: valida a entrada, chama o módulo, traduz o erro em status. Se você se pegar escrevendo lógica de git, de tmux ou de sessão dentro de `worktrees-api.ts`, pare — é a duplicação que §25 e o invariante 13 proíbem, e será rejeitada na revisão.

`GET /api/worktrees` **já existe** e é uma projeção de `agent_sessions`. Mantenha essa propriedade: não crie um segundo registro de worktrees.

**Autorização (ADR-10, inegociável):** toda rota de mutação exige loopback **e** capability anunciada. Leitura pode responder em qualquer bind. Uma rota nova sem esse gate é falha de segurança, não descuido de estilo.

**Anuncie `worktrees`** em `src/web/server.ts` quando — e só quando — as rotas existirem e o bind for loopback. É essa capability que acende os sete diálogos já portados.

### Bloco B — agentes personalizados (CRUD)

| Rota | Upstream | Destino |
|---|---|---|
| `GET /api/agents` | `:1929` | `src/web/agents-api.ts` (novo) |
| `POST /api/agents` | `:1930` | idem |
| `POST /api/agents/validate` | `:1934` | idem |
| `PUT /api/agents/:id` | `:1941` | idem |
| `DELETE /api/agents/:id` | `:1946` | idem |

O domínio **já existe** em `src/agents/custom.ts` (Fase 7): template, placeholders como referência de variável, valores por env. Persistência segue a escada de configuração de `src/config/`. O tipo do cliente já está declarado em `web/src/lib/api.ts` (`UpsertCustomAgentRequest`, `ValidateCustomAgentResponse`); o `AgentEditorDialog` já está portado.

**§45.3:** o comando do agente é **argv**, nunca string de shell (ADR-04). Permissão é semântica de três níveis, nunca `yolo: boolean`.

### Bloco C — configuração: Linear, GitHub e o resto do diálogo

| Rota | Upstream | Observação |
|---|---|---|
| `PUT /api/linear/auto-create` | `:2165` | reverte ADR-14 — ver seção 2 |
| `GET /api/linear/issues` | `:2157` | idem |
| `POST /api/worktrees/:name/linear` | `:2060` | "postar conversa no ticket" |
| `PUT /api/github/auto-remove-on-merge` | `:2169` | consome `src/runtime/worktree/gc.ts`, **já portado** |
| `GET /api/project/auto-name` | `:2161` | consome `src/conventions/git/auto-name.ts`, **já portado** |

Fonte upstream do Linear: `backend/src/services/linear-*.ts` e os componentes `LinearPanel`, `LinearBadge`, `LinearDetailDialog`, `LinearPostDialog` em `frontend/src/lib/`. O `SettingsDialog` já portado tem os lugares vazios — preencha-os em vez de criar um segundo diálogo (§50.3: **uma** superfície de configuração).

**Host SSH / "Abrir no Cursor":** o campo já existe na UI e não tem consumidor. Ligue-o: o link `cursor://` / `vscode://` do upstream está em `frontend/src/lib/CursorButton.svelte`, já portado.

**Segredo do Linear é credencial.** Não vai para `.issue-flow.json` versionado, não aparece em log, não entra em telemetria — §45.3 exige redaction. Siga o que `src/issues/github/client.ts` já faz com o token do `gh`.

### Bloco D — abas por worktree

`POST/DELETE /api/worktrees/:name/tabs` (`:2114`, `:2134`), `POST .../tabs/:id/select` (`:2124`), `POST .../agent-terminal/refresh` (`:2042`).

**Este é o único bloco com uma pergunta de arquitetura em aberto.** A Fase 9B registrou que o modelo de layout multi-aba não foi portado, e §27 é explícito sobre os sete conceitos de sessão não se misturarem. Antes de escrever a rota, decida **e registre na ficha**: uma aba é uma `AgentSession` a mais no mesmo worktree, ou é estado de layout do painel? Se for sessão, use `agent_sessions` e não crie tabela nova (ADR-16). Se for layout, ela não pertence ao backend de sessão.

`refreshAgentTerminal` do upstream **mata e recria o pane**. §27 corrigiu isso com `reattach`/`resume`, que reabre sem destruir. **Não porte o comportamento destrutivo.** Se a UI precisa de "recarregar", ligue-a ao caminho que já existe.

---

## 4. O que NÃO fazer

| Nunca | Por quê |
|---|---|
| Copiar arquivo do `.references/` | Bun-only, não compila em Node; e o upstream não publica `LICENSE`. `PORT`/`ADAPT`, sempre |
| Editar qualquer coisa em `.references/webmux-main/` | É a baseline de verificação de paridade |
| Reimplementar worktree, tmux, sessão, profile, porta ou args de docker | Já existem e estão testados. A rota chama; não refaz |
| Rota de mutação sem loopback + capability | ADR-10 |
| String de shell em vez de argv | ADR-04 |
| `spawn`/`execa` fora do chokepoint `run()` | §45.3. As exceções legítimas estão em `src/utils/AGENTS.md` |
| `writeFile` direto | Use `writeFileAtomic` |
| Reusar sessão em `review`/`pr-review` | ADR-07 |
| Paleta nova sem os 19 pares medidos | ADR-19 |
| Remover ou marcar `skip` num teste existente | Um teste que perdeu o assunto **muda de assunto** e vira linha na ficha |
| Adotar Bun | ADR-01 |

---

## 5. Rastreabilidade (§46) — parte da entrega

- Ficha por bloco em `docs/absorption-trace.md`, no formato das 27 existentes e em **pt-BR**: *WebMux original → comportamento existente → implementação → adaptações → deliberadamente NÃO portado → testes de paridade → orçamentos*.
- Linhas em `docs/provenance.md` (origem → destino → estratégia).
- Atualize os ADRs 14 e 19 com a reversão da seção 2.
- Atualize `web/AGENTS.md`, `src/web/AGENTS.md`, `docs/web-monitor.md` e `docs/configuration.md`.
- Atualize o checklist de §50.7 em `docs/research/2026-09-06-webmux-absorption.md` — e desta vez **contra a tela**, não contra a existência dos módulos.

---

## 6. Como testar — e por que os testes anteriores não pegaram isto

A absorção terminou com 3.442 testes verdes e uma interface inerte. Isso não é azar: **nenhum daqueles testes exercia o caminho que uma pessoa percorre**. Os portões abaixo existem para fechar essa lacuna. Rodá-los é obrigatório; um bloco não está pronto com qualquer um vermelho.

### 6.1 Portões automatizados

```bash
cd packages/issue-flow
npm run check                                      # biome + tsc + svelte-check
npx vitest run                                     # unitários da CLI
npm run test:web                                   # painel (happy-dom)
npm run test:contract                              # contrato HTTP tipado
npx vitest run --config vitest.integration.config.ts   # git, tmux e docker REAIS
npm run build && npm run smoke && npm run skills:check
```

**Armadilha conhecida, não a repita:** `happy-dom` **não tem cascata de CSS nem layout**. `getComputedStyle` devolve string vazia para custom property e `getBoundingClientRect()` devolve zeros. Um teste de contraste ou de responsividade escrito ali **passa sempre, medindo nada**. Use `web/measure.html` + `web/src/measure.ts` num Chromium de verdade, como as fases 8C e 8D fizeram.

**Segunda armadilha, também já ocorrida:** em teste de integração de terminal, a sessão dona e o *viewer* precisam do **mesmo socket tmux** (`socketName`). Sem isso o viewer anexa no socket errado, não acha a janela, e toda asserção de "saída ao vivo" é satisfeita pelo shell ecoando a própria entrada. Foi assim que o caso C6 passou sem medir nada.

**Terceira:** `it.runIf(...)` é avaliado na **coleta**. Uma flag de disponibilidade setada em `beforeAll` faz o arquivo inteiro pular em silêncio. Calcule com `spawnSync` no topo do módulo.

### 6.2 O portão que faltava — Roteiro A **na tela**, não no código

Para **cada** um dos nove fluxos de §48.6, com o monitor rodando de verdade (`issue-flow serve --host 127.0.0.1`) e um navegador aberto:

```
add project → create worktree → start agent → open terminal → interact
→ switch session → inspect service status → inspect PR/CI → reconnect
```

Um fluxo só é verde quando **a pessoa consegue completá-lo clicando**. "O módulo existe" e "a rota responde 200" não são o critério — foi exatamente esse o erro que produziu este documento. Registre, por fluxo: o que clicou, o que apareceu, e o que mudou no disco ou no tmux.

### 6.3 Paridade visual contra o WebMux

Rode os dois lado a lado. Para cada tela, liste o que o WebMux oferece e o Issue Flow não. Toda diferença vira uma de duas coisas: **uma linha de trabalho**, ou **uma linha de "deliberadamente não portado" com motivo verificável**. Nenhuma diferença fica sem classificação.

Cobertura mínima: barra lateral (lista, busca, arquivados, atalhos) · cabeçalho do worktree (nome editável, badge de agente, Archive/Merge/Remove) · estado vazio ("Open Session") · diálogo de novo worktree (prompt, branch, base, agente, múltipla seleção, salvar default) · rodapé (branch, Cursor, Pull, Linear) · **diálogo de configurações inteiro**.

### 6.4 Critério de conclusão

1. Os três blocos de §50.7 verdes, aferidos como manda 6.2.
2. Todo item de 6.3 classificado — implementado, ou justificado por escrito.
3. Todos os portões de 6.1 verdes, com as três armadilhas evitadas.
4. Nenhum diálogo portado inalcançável: se o componente existe, ou a rota existe, ou a ficha diz por que não.
5. Orçamentos de §35 medidos de novo e sem regressão — os valores atuais estão no quadro consolidado de `docs/absorption-trace.md`.

---

## 7. Postura de execução

Vale integralmente a seção 9 do enunciado anterior: decida sozinho pré-requisito ausente, divergência entre spec e código, dependência nova, nome, layout de arquivo e ordem de parâmetro. Não peça validação para o que é reversível.

Bloqueio só existe com credencial indispensável ausente, recurso externo obrigatório inacessível sem fixture, ou decisão de consequência externa irreversível. Mesmo então: marque **só** a parte afetada, termine todo o resto e descreva objetivamente o que falta.

**Uma lição do ciclo anterior, que custou caro.** Quatro relatórios de subagente descreveram um estado que a árvore já não tinha — um patch dado como pendente e já aplicado, uma lacuna dada como aberta e já fechada, uma quebra de build atribuída à fase errada, um campo dito inexistente que existia. Em nenhum caso o relato batia com o código.

**Relatório é indício; código é evidência.** Antes de agir sobre qualquer afirmação — sua, de um subagente, ou deste documento — confirme no código. E quando corrigir algo, corrija também a ficha que propagava a afirmação obsoleta: ela é o que sobra para quem mantiver isto depois.
