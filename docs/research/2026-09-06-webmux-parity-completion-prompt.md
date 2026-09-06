# Prompt — completar a paridade do WebMux: o backend de mutação e a CLI

> **Leia primeiro, nesta ordem:**
> 1. `docs/research/2026-09-06-webmux-absorption-prompt.md` — o enunciado da absorção. **Todas** as restrições, invariantes, ADRs e portões dele continuam valendo aqui, sem exceção.
> 2. `docs/research/2026-09-06-webmux-absorption.md` — o plano. §14, §16, §19, §22, §45.1, §45.3, §48, §49, §50.
> 3. `docs/absorption-trace.md` — as 27 fichas do que já entrou. **Não reimplemente o que já existe, mas corrija se algo estiver quebrado ou diferente do que foi solicitado.**
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

### 1.2 A CLI tem o mesmo problema, por outro caminho

Não é só a interface web. `issue-flow` sem argumento imprime uma tabela de runs em vez de ensinar o que a ferramenta faz, e `serve` avisa que o monitor está exposto na rede sem dizer em qual endereço. O bloco E trata os dois.

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

Ordem obrigatória entre **A → B → C → D**: cada um entrega valor sozinho e o seguinte depende do anterior. Não comece o B com o A vermelho.

O **bloco E (CLI)** não depende de nenhum deles e pode vir primeiro — é barato, e é o que a pessoa encontra antes de abrir qualquer tela. Só as três subseções que chamam rotas de worktree (`archive`, `label`, `merge`, `remove`, `prune`, `restore` em E3) esperam o bloco A.

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

### Bloco E — a CLI: o que ela diz quando você a chama

Independente dos blocos A–D e sem dependência entre eles. Pode ser feito primeiro; é barato e é o que o usuário encontra antes de qualquer tela.

#### E1 — `issue-flow` sem argumento deve ensinar, não relatar

**Hoje:** `src/cli.ts:1306` faz o inverso do esperado.

```ts
program.action(async () => {
  const runs = await listLiveRuns();
  if (runs.length === 0) {
    program.help();          // ajuda só quando NÃO há nada rodando
    return;
  }
  process.exit(await runPs()); // senão, a tabela de runs
});
```

Com um run vivo — ou com um **órfão** esquecido, que é o caso mais comum — o comando nu imprime uma tabela de seis colunas e nada mais. Quem digita `issue-flow` para descobrir o que a ferramenta faz recebe um relatório de estado que não pediu, e nenhuma pista de que existem 25 subcomandos.

**Faça:** o comando nu imprime **sempre** a ajuda. A tabela de runs continua existindo, onde já existe — `issue-flow ps` — que é exatamente o subcomando que o dono do projeto pediu ("talvez através de algum subcomando"). Não crie um terceiro caminho: `ps` já faz isso e está testado.

**A ajuda precisa ficar tão informativa quanto a do upstream** (`bin/src/webmux.ts:14`, função `usage()`). Compare lado a lado antes de considerar pronto:

| Seção | Upstream | Nosso `--help` hoje |
|---|---|---|
| Uma linha dizendo **o que a ferramenta é** | `webmux — Dev dashboard for managing Git worktrees` | existe, mas enterrada em `Usage:` |
| `Usage:` com **um subcomando por linha e descrição curta** | 21 linhas legíveis | 68 linhas com descrições quebradas em 3 linhas cada |
| `Options:` | `--port`, `--app`, `--debug`, `--version`, `--help`, com o efeito de cada um | só `-V` e `-h` |
| `Environment:` | `PORT`, e a precedência em relação à flag | **não existe** |

O `--help` do Commander quebra descrição longa em três linhas e fica ilegível. Agrupe os 25 subcomandos por assunto (pipeline · sessões e worktrees · monitor · configuração e diagnóstico · skills), encurte cada descrição para caber numa linha, e acrescente a seção `Environment:` com as variáveis que o projeto realmente lê — no mínimo `ISSUE_FLOW_HOME`, `ISSUE_FLOW_PROJECT_DIR`, `ISSUE_FLOW_RUNTIME_MAX_CONCURRENT`, `ISSUE_FLOW_RUN_AUTO_CLOSE`, `ISSUE_FLOW_RUNTIME_PROFILE`, `ISSUE_FLOW_GITHUB_LINKED_REPOS`. Levante a lista real com `grep -rn "process.env\.\|env\.ISSUE_FLOW" src/ --include='*.ts'` em vez de copiar esta.

#### E2 — `serve` deve dizer por onde se chega até ele

**Hoje** (já corrigido do silêncio total, mas ainda pobre):

```
⚠ issue-flow: the terminal surface is disabled because the monitor is not bound to loopback.
⚠ Web monitor bound to 0.0.0.0: anyone on your local network can view the session state.
· Web monitor running at http://localhost:3737
· The monitor stays in the foreground; press Ctrl+C to stop it.
· Serving 1 project.
```

**Upstream:**

```
Starting webmux on port 5111...
[BE] [16:32:53.876] [oneshot-watcher] monitor started
[BE] [16:32:53.876] [session-snapshot] monitor started (interval: 30000ms)
[BE] [16:32:53.918] [serve] registered instance port=5111 projects=1
[BE] [16:32:53.918] Dev Dashboard API running at http://localhost:5111
[BE] [16:32:53.919]   Network: http://192.168.15.8:5111
[BE] [16:32:53.919]   Network: http://100.71.21.121:5111
[BE] [16:32:53.919]   Network: http://192.168.139.3:5111
[BE] [16:37:13.624] [worktree:open] name=main
```

Três coisas faltam, em ordem de valor:

1. **Os endereços de rede.** `os.networkInterfaces()`, todo IPv4 não-interno — upstream em `backend/src/server.ts:2783-2789`. É como se abre o painel do celular na mesma LAN ou por Tailscale/VPN. **Isto é especialmente incoerente hoje:** nós avisamos que o monitor está exposto na rede e não dizemos em qual endereço. Só imprima quando o bind não for loopback; em `127.0.0.1` a lista seria mentira.
2. **Que os loops de fundo subiram, e com que intervalo.** Reconciliação, GC de worktree, monitor de PR/CI, watch do diretório de sessão. Um monitor que não diz o que está observando não dá como saber se o gate de §20 está economizando chamada `gh` ou se o poll está desligado.
3. **Atividade contínua.** `[worktree:open] name=main` no upstream. Nós já temos os eventos (`agent_events`, o publisher de sessão); o que falta é uma linha por evento relevante no stdout do `serve`.

**Restrições que decidem se isto ficou certo:**

- **Um logger, não dois.** `src/ui/logger.ts` já existe e é o que o resto da CLI usa. Se for preciso timestamp e prefixo de subsistema, **estenda-o**; um segundo formatador é a duplicação que o invariante 13 proíbe.
- **`stdio: 'ignore'`.** O `serve` também é gerado em background pelo `--web` (`src/web/lock.ts`), onde a saída é descartada. Verifique que o volume novo não custa nada nesse caminho e que nada vaza para o terminal de um `run`.
- **§45.3 — telemetria com redaction.** Nenhuma linha de log carrega token, segredo de Linear ou conteúdo de prompt. Caminho de repositório e nome de branch podem; valor de credencial, nunca.
- **Não vire um firehose.** O upstream loga uma linha por abertura de worktree, não por evento de agente. Escolha o mesmo nível de granularidade: o que uma pessoa acompanharia numa janela aberta o dia todo.

#### E3 — a paridade de subcomandos, avaliada e decidida

O upstream expõe 21 subcomandos; nós expomos 25, mas o conjunto não é o mesmo. Estes existem lá e não aqui:

`add` · `oneshot` · `list` · `open` · `close` · `refresh` · `archive` · `unarchive` · `label` · `remove` · `merge` · `send` · `tab` · `prune` · `restore` · `linear` · `service` · `update`

Vários **já têm equivalente** e não devem ser duplicados: `oneshot` convergiu em `run --prompt` (§17, Fase 15) e `open`/`close`/`send` são `issue-flow session open|stop|send` (Fase 9B). Para cada um dos 18, escreva na ficha uma de três conclusões: **já existe como X** · **implementar como Y** · **deliberadamente fora, porque Z**. Nenhum fica sem veredito.

Os que dependem do bloco A (`archive`, `label`, `merge`, `remove`, `prune`, `restore`) só saem depois dele — a CLI chama a mesma camada que a rota, nunca uma segunda implementação.

`service` (instalar o monitor como serviço de sistema) e `update` são independentes: decida e registre.

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

### 6.3 A CLI, verificada rodando

Nenhum dos portões de 6.1 executa o binário empacotado. `src/completion.test.ts` é a única coisa perto disso. Para o bloco E, teste o artefato de verdade:

```bash
npm run build
node dist/cli.js                 # deve imprimir a ajuda, COM um run vivo e sem nenhum
node dist/cli.js --help          # uma linha por subcomando, com Options e Environment
node dist/cli.js ps              # a tabela de runs continua aqui, inalterada
node dist/cli.js serve --host 127.0.0.1   # loopback: sem lista de rede
node dist/cli.js serve                    # 0.0.0.0: a lista de rede aparece
```

O caso que pega a regressão de E1 é **`issue-flow` com um run vivo**: é exatamente a condição em que ele hoje troca a ajuda pela tabela, e é a condição que um teste ingênuo (repositório limpo, nada rodando) não reproduz. Deixe um lock de run vivo — ou um órfão — e confirme que a ajuda aparece do mesmo jeito.

Cubra também em `vitest`: a montagem da ajuda e a lista de endereços de rede são funções puras se você as extrair como tais. `os.networkInterfaces()` entra por parâmetro, não por leitura direta — é a mesma razão que fez `hostTotalMemoryBytes` ser parâmetro em `buildDockerRunArgs` (Fase 13): no instante em que a função lê estado do processo, o teste deixa de ser comparação literal.

### 6.4 Paridade visual contra o WebMux

Rode os dois lado a lado. Para cada tela, liste o que o WebMux oferece e o Issue Flow não. Toda diferença vira uma de duas coisas: **uma linha de trabalho**, ou **uma linha de "deliberadamente não portado" com motivo verificável**. Nenhuma diferença fica sem classificação.

Cobertura mínima: barra lateral (lista, busca, arquivados, atalhos) · cabeçalho do worktree (nome editável, badge de agente, Archive/Merge/Remove) · estado vazio ("Open Session") · diálogo de novo worktree (prompt, branch, base, agente, múltipla seleção, salvar default) · rodapé (branch, Cursor, Pull, Linear) · **diálogo de configurações inteiro**.

### 6.5 Critério de conclusão

1. Os três blocos de §50.7 verdes, aferidos como manda 6.2.
2. Todo item de 6.4 classificado — implementado, ou justificado por escrito.
3. Todos os portões de 6.1 verdes, com as três armadilhas evitadas.
4. Nenhum diálogo portado inalcançável: se o componente existe, ou a rota existe, ou a ficha diz por que não.
5. `issue-flow` sem argumento ensina, `serve` diz por onde se chega até ele, e os 18 subcomandos de E3 têm veredito escrito.
6. Orçamentos de §35 medidos de novo e sem regressão — os valores atuais estão no quadro consolidado de `docs/absorption-trace.md`.

---

## 7. Postura de execução

Vale integralmente a seção 9 do enunciado anterior: decida sozinho pré-requisito ausente, divergência entre spec e código, dependência nova, nome, layout de arquivo e ordem de parâmetro. Não peça validação para o que é reversível.

Bloqueio só existe com credencial indispensável ausente, recurso externo obrigatório inacessível sem fixture, ou decisão de consequência externa irreversível. Mesmo então: marque **só** a parte afetada, termine todo o resto e descreva objetivamente o que falta.

**Uma lição do ciclo anterior, que custou caro.** Quatro relatórios de subagente descreveram um estado que a árvore já não tinha — um patch dado como pendente e já aplicado, uma lacuna dada como aberta e já fechada, uma quebra de build atribuída à fase errada, um campo dito inexistente que existia. Em nenhum caso o relato batia com o código.

**Relatório é indício; código é evidência.** Antes de agir sobre qualquer afirmação — sua, de um subagente, ou deste documento — confirme no código. E quando corrigir algo, corrija também a ficha que propagava a afirmação obsoleta: ela é o que sobra para quem mantiver isto depois.
