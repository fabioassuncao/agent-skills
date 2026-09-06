# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions refer to the `issue-flow` npm package (`packages/issue-flow`). Releases
that were tagged but never published to the registry are marked as such.

Entries for 0.5.1 through 0.8.0 were reconstructed from the commit history after
the fact, so they list what changed rather than explaining why. Everything from
0.9.0 onwards was written at release time.

## [0.19.1] - 2026-09-06

- Share dependency validation and next-story inspection between standalone Skill helpers and the CLI; add `artifacts plan|issue --json`.
- Enforce story prerequisites before agent execution and reject malformed review results without inferring approval.
- Keep execution and pipeline delivery completion distinct; preserve current-branch execution.
- Require explicit `--close-issue` for issue closure, persist/revoke authorization and retry confirmed closure safely. Legacy runs leave issues open.
- Keep local generation free of GitHub discovery; fix `status --json` output.
- Make `build` generate Skills/prompts and compile the CLI; retain the pre-generation drift gate and add generated workflow provenance.

## [Unreleased]

### Added

- **OpenCode CLI as a fifth agent provider (#117).** `opencode` is selectable
  with `agent.provider`, `--agent`, `--agent-phase` and failover/routing. The
  runner uses `opencode run --format json --dir <workspace> --auto` with an
  explicit `OPENCODE_PERMISSION` policy (`question` denied; `external_directory`
  limited to requested `addDirs`; `read-only` denies `edit` and mutating
  `bash`). `--auto` is not a sandbox. Tokens are reported only when the stream
  includes them; cost stays absent. Default remains `claude`.

- Eleven independent Agent Skills, including portable `resolve-issue`, with
  deterministic source-to-artifact generation, isolated bundled helpers,
  installer validation and opt-in behavioral evals (#111).

- **SQLite as the canonical structured-state store (#91).** Versioned
  migrations, transactional repositories, automatic non-destructive import,
  JSON compatibility mode, indexed monitor/`ps`/`usage`, projection
  verification, issue history and database maintenance commands replace
  directory scans for structured state. Legacy event journals remain an
  explicit `db import --with-events` operation because of their volume.

- **An explicit experimental-project notice.** `docs/project-status.md` states
  how the project was built (mostly with AI coding agents), the risks that come
  with that — bugs, incomplete implementations, regressions, possibly
  undiscovered security flaws — where it should **not** be used yet (real
  projects, production, critical systems, repositories with sensitive
  information), and that token consumption is not optimized yet. The notice is
  surfaced at the top of both READMEs and printed by `issue-flow init`, the first
  command a new user runs.

### Fixed

- Clarify that the CLI installs from the `issue-flow` npm package rather than
  the `fabioassuncao/issue-flow` GitHub shorthand, and exercise a global-prefix
  installation in the packed-package check.
- Preserve the `node:sqlite` import in production bundles; npm artifact isolation
  now exercises the full pipeline without installed Skills.
- Use supported GitHub diff commands in PR review prompts and align smoke
  assertions with global storage and unverified acceptance contracts.

### Changed

- **Breaking:** Issue Flow now requires Node.js `>=22.13.0` to use its built-in
  SQLite storage foundation. Earlier Node 22 releases do not provide the
  supported `node:sqlite` runtime surface.

## [0.18.0] - 2026-08-30

O painel de monitoramento ganha uma hierarquia visual consolidada (#98), e o
routing opinativo passa a escolher entre os harnesses que a máquina realmente
pode usar (#105) — sem pinar um provider ausente ou não autenticado.

### Added

- **Routing por readiness (#105).** Inventário concorrente dos quatro harnesses
  com estado (`ready` / `conditional` / `unavailable`), autenticação
  (`confirmed` / `failed` / `unverified`), proveniência e TTL. Em
  `recommend`/`active`, o router recebe o snapshot e rankeia só o que é
  attemptável; `authProbe: 'none'` (Claude, Antigravity) fica `conditional`,
  nunca auth confirmada.
- **Fallback pela lista ranqueada.** Se o alvo opinativo falhar no probe entre
  decisão e uso, o próximo candidato elegível é tentado e o fallback fica no
  diagnóstico.
- **`routing use recommended --active`.** Grava política e `mode: active` num
  único comando; o `init` deixa de perguntar o agente quando o router já é dono
  da seleção.
- **Escalas tipográficas e de espaçamento no painel (#98, US-001–US-012).**
  Tokens fechados de tipografia, espaço e raio; header sem marca duplicada;
  aba Execução reagrupada por importância; foco, abas ARIA e `prefers-reduced-motion`.

### Changed

- **Política recomendada sem pin de harness.** `preferredTier` e afinidade
  suave substituem `preferHarness` como filtro de elegibilidade — um único
  harness pronto cobre todas as fases.
- **Catálogo do monitor.** `GET /api/config` e o painel expõem authentication,
  state e idade da observação além de `installed`/`authenticated`.

### Fixed

- **Filas multi-issue.** Issues descobertas já fechadas deixam de ser
  agendadas ao planejar ou retomar uma fila; relações fechadas continuam como
  contexto.

## [0.17.0] - 2026-08-30

Routing passa a escolher harness **e** modelo, com política recomendada opt-in
e controles no painel. No mesmo ciclo, o Epic de organização (#103) redistribui
os três arquivos que concentravam a pipeline — sem mudar o que a ferramenta
faz, só onde o código mora — e coloca o Biome sobre o pacote inteiro.

### Added

- **Convenção de organização do código (#99, #103).**
  [`docs/code-organization.md`](docs/code-organization.md) descreve a camada
  de cada diretório sob `src/`, onde vai código novo e o limite de tamanho
  como sinal. Os cinco `AGENTS.md` que faltavam (`conventions`, `execution`,
  `issues`, `scaffold`, `utils`) fecham a cobertura dos 17 diretórios.

- **Routing por harness e modelo (#104).** O catálogo versionado expande cada
  harness em tiers `fast`, `mid` e `strong`; os perfis ponderam qualidade,
  custo relativo e latência relativa, e a escada de escalada agora resolve um
  modelo concreto sem repetir tiers já tentados.
- **Política recomendada opt-in.** A tabela de economia de tokens virou código
  e pode ser ativada com `issue-flow routing use recommended --global`,
  inspecionada por fase com `routing explain` ou aplicada pelo painel.
- **Configuração de routing no monitor.** Em loopback, cada fase salva harness
  e modelo, e o mesmo card controla modo, perfil e política. A API adiciona
  `POST /api/config/routing` e devolve o catálogo em `GET /api/config`.

### Changed

- **Organização interna sem mudança de comportamento (#100–#103).**
  `run.ts`, `config.ts` e `session-state.ts` passaram a fachadas sobre
  `commands/run/`, `config/` e `core/session/`. A escrita atômica convergiu
  em `utils/fs.ts` (mkdir do destino + tratamento de `EXDEV`). `tasks.json`,
  `session.json`, `.issue-flow.json`, variáveis de ambiente e exit codes
  documentados permanecem iguais.

- **Biome cobre o pacote inteiro (#99).** `web/public/`, `scripts/*.mjs` e
  `*.config.ts` entram no `includes`. `npm run check` deixou de mutar a
  árvore (reproduz o gate do CI); o comportamento mutante ficou em
  `npm run fix`.

- **`recommend` e `active` agora têm efeito.** `recommend` imprime o alvo;
  `active` aplica harness/modelo somente em fases sem seleção explícita e
  degrada para a seleção original com diagnóstico de warning se o alvo não
  puder ser aplicado. O default continua `shadow`, sem política ativa.

## [0.16.0] - 2026-08-30

A versão sai de `issue-flow --version` e passa a aparecer onde o usuário já está
olhando: na headline da TUI, no header do painel e — quando a CLI e o monitor
estão em releases diferentes — nos dois lados, dizendo que estão. Era o dado que
faltava para o `--restart-web` da 0.15.0 ser acionável: sem ver as duas versões,
não há como saber que o painel na tela é o antigo.

### Added

- **A versão na TUI.** A visão limpa abre com
  `Issue Flow v0.16.0 · #42 · <título>`, e `run`/`execute` começam com
  `Issue Flow v0.16.0 · starting pipeline for issue #42 …`, o que também torna
  todo `run.log` atribuível a um build.

- **A versão no painel.** Um chip ao lado da marca nos dois headers — dashboard
  e detalhe. Ele mostra a versão do **monitor**, vinda de `/api/health`: os
  assets da página vivem na memória daquele processo, então é ela que explica o
  que está na tela.

- **As duas versões, lado a lado.** Quem executa o pipeline e quem serve o
  painel são processos distintos e podem estar em releases diferentes. O card
  *Harnesses e configuração efetiva* ganha `Issue Flow (execução)` — versão,
  Node e plataforma — e `Monitor (este painel)`; divergindo, o card explica e
  aponta `--restart-web`. A CLI diz o mesmo no terminal: a linha de reúso passa
  a nomear a versão do monitor reaproveitado, e um aviso compara as duas. Nada é
  imposto — o run segue contra o monitor antigo.

- **`environment.cliVersion` no `session.json`.** Aditivo como `agent` e
  `model`: um snapshot escrito antes dele lê `null`. A TUI projeta esse campo em
  vez de ler o manifesto, então uma sessão retomada ou reexibida continua
  nomeando o build que a produziu, não o que está lendo.

### Changed

- **Uma única leitura da versão** (`src/version.ts`), usada pela CLI, pelo
  servidor web e pelo snapshot da sessão. Eram três caminhos relativos
  diferentes, e o do servidor já havia falhado em silêncio no bundle. Uma versão
  errada é pior do que nenhuma quando a tela promete nomear o build em execução.

## [0.15.0] - 2026-08-30

Depois de atualizar o Issue Flow, o monitor web continuava servindo a interface
antiga: o processo detached lê `index.html`, `app.css` e `app.js` uma vez, na
partida, e os mantém em memória junto do cache de ETag do status. Só reiniciar o
processo invalida esses caches. `--restart-web` faz exatamente isso — e nada
além disso. O servidor passa a ter identidade de instância, o que permite a uma
aba já aberta perceber a troca e se recarregar sozinha, e um monitor órfão deixa
de ser um conflito de porta insolúvel.

### Added

- **`--restart-web` em `run` e `execute`.** Uma ação efêmera que implica
  `--web`: para o monitor verificado anterior de forma graciosa e sobe um novo
  processo detached pelo entry point da CLI que está executando o comando. Sem a
  flag, o comportamento de reúso da instância única continua idêntico. O log
  registra o PID e a versão antigos e os novos. A flag não tem variável de
  ambiente nem chave em `.issue-flow.json` — é um pedido pontual, não uma
  configuração. Numa fila de issues ela vale apenas para a primeira. Como o
  restart usa a versão do pacote em execução, atualizar o pacote junto é
  `npx issue-flow@latest run 42 --restart-web`.

- **Identidade de instância no monitor.** Todo servidor gera um `instanceId` na
  partida, exposto em `GET /api/health` — junto de `pid` e `startedAt` — e
  devolvido em toda resposta no header `X-Issue-Flow-Instance`. O painel guarda
  a primeira identidade que observa e chama `window.location.reload()` quando
  ela muda: é assim que uma aba aberta troca de assets depois de um restart, sem
  intervenção. Uma aba carregada por uma versão anterior à identidade precisa de
  um reload manual. O campo entra em `web.lock` como opcional, de modo que locks
  escritos por versões antigas seguem válidos.

- **`web.restart.lock`.** Um lock irmão, de vida curta, que serializa a janela
  de manutenção de `--restart-web` e de `web stop`. Um dono morto é tratado como
  stale e o arquivo é removido. Falha de restart nunca derruba o pipeline.

### Fixed

- **Monitor órfão depois de remover `~/.issue-flow`.** O processo seguia vivo
  sem `web.lock`, e a porta virava um conflito que nenhum comando resolvia.
  Agora o Issue Flow sonda a porta configurada e só reconstrói o lock quando o
  endpoint de saúde **e** a linha de comando do processo que escuta provam que
  aquilo é um `issue-flow web serve`. Um dono ambíguo nunca é encerrado.

- **`/api/health` reportando `0.0.0` no bundle.** A versão era lida em um
  caminho relativo que só existe na árvore de fontes; no `dist/` a leitura
  falhava em silêncio, o que justamente escondia o diagnóstico de qual versão
  estava servindo o painel. Os dois layouts passam a ser tentados.

- **`--refresh` do servidor lido mesmo com preferência salva.** O painel só
  buscava `/api/health` quando não havia escolha em `localStorage`, e assim
  perdia `capabilities` — o card de configuração ficava read-only sem motivo. A
  saúde agora é sempre consultada; a preferência do usuário continua vencendo o
  valor sugerido.

## [0.14.0] - 2026-08-30

O monitor web deixa de ser uma vitrine e passa a explicar a própria execução.
Um único drawer de detalhes serve fases, stories e cards do Kanban; a
configuração efetiva de harness/modelo aparece com a camada que a decidiu; a
saída dos processos e os diagnósticos correlacionados ficam a um clique. Fora do
painel, todo run passa a gravar um log estruturado em `~/.issue-flow/logs/`,
independente de projeto e de `--web`. E o painel ganha tema claro e escuro, com
contraste medido em vez de estimado.

### Added

- **Tema claro e escuro no monitor web** (#97). A paleta do `app.css` foi
  reorganizada como tokens por papel (`--surface*`, `--text*`, `--border*`,
  `--accent*`, `--state-*`, `--focus-ring`), e o tema escuro vive em dois blocos
  gêmeos — `@media (prefers-color-scheme: dark)` guardado por
  `:not([data-theme='light'])` e `:root[data-theme='dark']` — para a escolha
  manual vencer o sistema nos dois sentidos. Um `<select>` de três estados
  (Sistema/Claro/Escuro) aparece espelhado nos dois headers, e a preferência é
  persistida em `localStorage` sob `issue-flow:theme`, por navegador: não há
  flag de CLI, variável de ambiente nem chave em `.issue-flow.json`, e a escolha
  nunca chega ao servidor. No modo `Sistema` — e só nele — um listener de
  `matchMedia` repinta o painel quando o SO troca de tema, sem reload. Um script
  inline no `<head>`, antes do `app.css`, aplica o tema armazenado antes do
  primeiro paint, de modo que um reload com tema forçado não pisca a paleta
  oposta; com `localStorage` bloqueado o painel carrega em modo sistema e o
  seletor continua funcionando na aba. Cada bloco declara seu próprio
  `color-scheme` (o `<meta name="color-scheme">` foi removido do `index.html`),
  então `<select>`, `<progress>` e as barras de rolagem seguem o tema
  **efetivo**, não o do SO. Todos os pares texto/fundo foram calculados e
  atendem WCAG AA — 4,5:1 para texto, 3:1 para o anel de foco —, com a tabela
  dos valores medidos em `web/AGENTS.md`. Nada é carregado da rede: o painel
  continua funcionando offline.

- **Log de diagnóstico global** (`~/.issue-flow/logs/issue-flow-YYYY-MM-DD.jsonl`).
  Todo run grava JSON Lines estruturado, independentemente do projeto e de o
  monitor web estar ligado. Cada registro carrega os campos de correlação
  disponíveis (`project`, `projectRoot`, `sessionId`, `executionId`, issue, fase,
  story, harness e modelo), além de nível, timestamp, mensagem, contexto e o
  stack da exceção quando existe. A escrita é enfileirada e best-effort — uma
  falha de logging não pode quebrar o pipeline —, com rotação em 10 MiB, cinco
  gerações por dia, retenção de 30 dias e redação recursiva de chaves e valores
  parecidos com credenciais.

- **Diagnóstico de execução no `session.json`.** O snapshot passa a projetar
  `executions` (as invocações canônicas de `tasks.json`, upsert por id),
  `processLogs` (cauda limitada e redigida da saída do harness), `configuration`
  (provider/modelo efetivos com a camada de origem, escada de precedência,
  fallbacks e overrides) e `history` por story (transições de estágio,
  append-only). `git` ganha `branchCreated`, `startCommit` e, por commit,
  `committedAt` e `storyId`.

- **Rotas de leitura e um card de configuração no painel.**
  `GET /api/config?session=<id>` devolve a configuração capturada no snapshot e
  `GET /api/diagnostics?session=<id>` filtra o log global pela sessão. O card de
  configuração renderiza o valor capturado — não uma resolução nova feita no
  navegador —, apresentando a escada como *built-in default → global do usuário
  → projeto → ambiente → CLI → override de fase* com o valor efetivo destacado.

### Changed

- **Um único drawer de detalhes** para fases, linhas de story e cards do Kanban.
  Clicar (ou focar e apertar Enter) em qualquer um deles abre o mesmo
  componente, agora com status e tempos, harness/modelo efetivos, telemetria de
  tokens/cache/custo por invocação, transições de estágio, retries, fallbacks e
  correções, e blocos expansíveis com a saída do processo e os diagnósticos
  globais correlacionados. Descrição, critérios de aceitação e dependências
  continuam ali para stories. O drawer segue fechando pelo overlay, pelo botão
  ou por `Esc`, devolvendo o foco ao elemento que o abriu, e permanece aberto
  entre refreshes, atualizando no lugar.

- **O painel deixa de ser read-only por construção e passa a ser read-only por
  binding.** O estado de execução nunca é gravável. A única rota de escrita,
  `POST /api/config/agent`, salva a preferência global de provider/modelo para
  runs futuros e existe apenas quando o servidor está ligado a loopback: em
  binding remoto ela some de `/api/health.capabilities` e responde `403`. Uma
  sessão ativa nunca é reconfigurada retroativamente.

## [0.13.0] - 2026-08-30

Quatro providers atrás de um contrato único, e um pipeline que passa a medir a
si mesmo. `AgentRunner` desacopla cada fase do binário `claude`; Codex, Cursor e
Antigravity entram por configuração, com failover por saúde de provider. A
telemetria por invocação grava harness, modelo, tokens, custo e latência em
`tasks.json`; o contrato de aceitação executa checks reais e introduz
`unverified` — um pipeline que não pôde verificar deixa de se apresentar como
verde. O router decide em modo shadow sem mudar a invocação, e a convenção Git
passa a ser derivada da issue, nunca do executor.

### Added

- **Escalada por não-convergência e tetos** (#86). `src/routing/budget.ts` e
  `escalation.ts` são puros: tetos `null` e `escalation.enabled: false` por
  default. Custo `unknown` não consome teto de custo. A escada só sobe.
  `provider_down` não entra nela. Enforcement no `invokeSelectedAgent`, não
  em flag de harness. `--no-escalation`, `--max-cost`, `--max-duration`.
  Não toca `src/resilience/`. `detectNonConvergence()` está implementada e
  testada mas ainda não é chamada pelo gate: a escalada por não-convergência
  não age nesta versão. Experimento no corpus da #79 fica pendente.

- **Antigravity CLI (`agy`) como quarto provider** (#80). `AntigravityRunner`
  traduz `permission` via `--mode`, passa `--add-dir` do workspace,
  `--dangerously-skip-permissions` e `--disable-slash-commands` em toda
  invocação, e traduz `timeout` (inclusive `0`) para `--print-timeout`.
  Negação de permissão com `status: SUCCESS` e `status: WAITING` são
  `configuration`. Tokens sem USD; `num_turns: 0` → `usage: null`.
  `agent.antigravity.*` e `ISSUE_FLOW_ANTIGRAVITY_*`. Default continua
  `claude`. Integração ao vivo (`ISSUE_FLOW_E2E_ANTIGRAVITY=1`) fica
  fora do `npm test`.

- **Router em modo shadow** (#84, estágios 1–2). `src/routing/` classifica a
  tarefa, filtra por `AgentCapabilities` e pontua priors. Default `shadow`:
  grava `selected`/`actual` no `ExecutionRecord` e não muda a invocação.
  `issue-flow routing` e `routing report`. `active`/`recommend` e aprendizado
  ficam para estágios 3–4.

- **Quick wins de overhead** (#89). Remove o `sleep(2)` e o `gh pr list` por
  iteração (`publishGitState` fica na fronteira de fase). `storiesPerIteration`
  default `1`. `--strict-mcp-config` acompanha `ignoreUserConfig`, com escape
  `strictMcpConfig: false`. Header mostra estimativa N × p50 da baseline #79.
  Ritual e validação no prompt passam a ser proporcionais. Tabela before/after
  real ainda pendente.

- **Contrato de aceitação e `unverified`** (#85, estágios 1–2). `src/verify/`
  descobre typecheck/lint/test (ou um contrato declarado), roda os checks
  sem interpretar prosa e grava `verify.json` ligado ao `executionId`.
  Contrato vazio ou que não pôde rodar é `unverified` — o pipeline segue,
  sem se apresentar como sucesso verificado. L1 é o default; L2
  (`--verify-level L2` ou gatilho configurado) escolhe um revisor
  independente sempre `read-only`. A tabela L1 vs L2 no corpus fica
  pendente (estágio 3) e nenhum gatilho vira default sem ela.

- **Cascata a partir de um container** (#74). Uma issue com filhas (Epic)
  entra na fila como `container`: nomeia a branch e o PR, não roda fase
  nenhuma, e só fecha quando as filhas concluem. `--cascade` (e `--yes`
  sobre um container) executa a hierarquia. Sem TTY e sem flag o comando
  falha em vez de implementar o guarda-chuva. `Closes`/`Refs` no PR
  seguem o estado do plano (#77).

- **Instrumentação de latência por invocação** (#79). `parseUsage` passa a
  ler `duration_ms`, `duration_api_ms`, `ttft_ms` e `num_turns`. O
  `ExecutionRecord` guarda `cliDurationMs`, `harnessStartupMs`
  (wall − envelope), `ttftMs` e `numTurns` — ausente continua "não
  reportado", nunca zero. Cada fase do snapshot distingue
  `harnessExecutionMs` de `orchestrationOverheadMs`. Benchmark sintético
  em CI (`src/benchmark/`); tabela *before* em
  `docs/research/2026-08-30-harness-baseline.md`. Quick wins e
  `storiesPerIteration` ficam na #89.

- **`--background` / `issue-flow ps`** (#82). `run -d` destaca o pipeline
  depois da confirmação de escopo, escreve `run.log` (com rotação) e marca
  `run.lock.detached`. `issue-flow ps` (e a invocação nua quando há runs)
  lista todas as execuções da máquina a partir do lock, sem depender de
  `--web`.

- **Cursor CLI (`cursor-agent`) como terceiro provider** (#76).
  `AgentCapabilities` declara o que cada runner sabe fazer. Sem
  `--add-dir`, o Cursor concede `~/.issue-flow/**` via
  `~/.cursor/cli-config.json` (opt-in em `agent use cursor`). `--force`
  é invariante nas fases que escrevem. Tokens e custo do Cursor são
  ausentes, nunca zero.

- **Telemetria por invocação em `tasks.json`** (#78). Cada chamada de agente
  grava um `ExecutionRecord` com harness, provider, modelo, propósito,
  tentativa, tokens, custo (informado / estimado / desconhecido) e status.
  Estimativa de preço é opt-in (`telemetry.pricing.estimate`). Novo comando
  `issue-flow usage`. Git continua descrevendo o que mudou; a telemetria
  descreve como foi produzido.

- **Camada de agentes (`src/agents/`)** (#62). `AgentRunner` desacopla o
  pipeline do binário `claude`. `runHeadless` e `executeClaude` continuam as
  fachadas; o runner é a peça trocável dentro delas. Default continua
  `claude`, com o mesmo argv de sempre quando não há configuração.
- **Codex CLI** (`codex exec`) como segundo provider. Prompt por stdin,
  `--json` + `--output-last-message`, `--sandbox` sempre explícito.
  `autonomous` fica em `workspace-write`. `danger-full-access` só por
  opt-in, com warning. Flags `--dangerously-bypass-*` não são expostas.
- **Seleção por fase.** Chave `agent` na escada CLI > `ISSUE_FLOW_AGENT*` /
  `ISSUE_FLOW_CODEX_*` > `.issue-flow.json` > `~/.issue-flow/config.json` >
  default. `phases` mergeia chave a chave. `--agent` / `--agent-model`
  sobrepõem tudo; `--agent-phase` afina uma fase.
- **`issue-flow agent`** e `issue-flow agent use`, com `--json` versionado
  para as Agent Skills. `issue-flow init` verifica o provider selecionado
  e oferece a escolha só com TTY, fora de CI e sem configuração prévia.
- Observabilidade: agente/modelo no início do run, no header, em
  `session.json` → `environment`, e tokens segmentados por agente só em
  run misto. Codex não reporta USD (`costUsd` ausente, nunca zero).
- **Failover entre providers de agente** (#69). A saúde de cada provider é
  persistida em `providers.json`; circuit breaker, cooldown exponencial,
  probe `half_open` e a cadeia de fallback passam a atuar por `FailureKind`.
  Falhas de autenticação bloqueiam o run, enquanto falhas lógicas e de rede
  não contaminam a saúde do provider.
- **Observabilidade de resiliência no monitor web** (#70). `session.json`
  projeta tentativa, provider, última falha, cooldown e atividade do agente;
  o painel exibe esses dados e ganha uma aba de histórico alimentada por
  `events.jsonl` (incluindo a geração rotacionada).

### Changed

- **Saída do terminal em modo clean** (#81). `issue-flow run` deixa de
  despejar o relatório do agente e a lista de stories: a tela renderiza o
  `SessionSnapshot` (fases, `N/M`, story ativa, tempos). `--verbose` preserva
  o detalhe anterior, linha a linha. Sem `--web` o reducer roda em memória e
  o disco continua intocado. `issue-flow init` segue imprimindo o relatório
  completo.

- **Convenção Git default** (#77). Branches passam de `issue/{N}-{slug}` para
  `{type}/{N}-{slug}`, com o tipo resolvido por Issue Type, labels, prefixo do
  título ou fallback `feat`. Commits e títulos de PR seguem Conventional
  Commits mesmo quando o repositório não declara convenção. Branches
  existentes não são renomeadas; `issue/{N}-*` continua reconhecida na
  extração do número, e uma execução retomada conserva `tasks.json.branchName`.
  Novo comando `issue-flow conventions {branch,commit,pr-title}`.

### Fixed

- **Preflight pedia o binário errado** para Cursor e Antigravity: um run com
  Cursor abortava pedindo `claude`, e um com Antigravity passava sem `agy`
  instalado e só falhava dentro da fase. O binário vem de
  `runnerFor(id).versionCommand()`.

- **Check declarado voltou a ser fatal por default.** `expectFiles` que
  falhava era gravado como não-fatal e o contrato inteiro ficava verde.

- **Stall do Cursor e do Antigravity** chegava só em `error`, e `classify()`
  lê `rawOutput`: um agente que imprimia algo antes de emudecer perdia a
  classificação `stalled` e as três tentativas. O silêncio reportado é o que
  o watchdog mediu, e a mensagem nomeia o binário que travou.

- **`half_open` não recuperava uma probe órfã.** Um run morto por SIGKILL
  deixava `probeInFlight: true` para sempre e o run seguinte esperava um
  cooldown que não terminava.

- **`verify.json` registrava o veredito superado.** A evidência era escrita
  antes do revisor L2 e nunca reescrita: um L2 que reprovava deixava
  `passed` no disco. Agora é escrita antes e reescrita depois, com o nível e
  o veredito que o pipeline usou.

- **Comando de contrato com aspas** era cortado em espaço — `pytest -k "not
  slow"` virava três argumentos, e os checks rodam sem shell.

- **Estimativa de custo era inerte na prática.** A tabela é indexada por
  família e o que chega é o id resolvido ou um alias; `normalizeModelKey`
  reduz snapshot, prefixo de vendor e alias antes da consulta.

- **`--max-cost` colidia** entre `bench` e as opções globais.

- **`verify.json` resolvido por `getIssuePaths`**, como todo artefato.

- **PR recuperado quando a URL não volta** (#68), e a referência da issue sem
  o placeholder morto.

- **Monitor web**: sessões ao vivo deixam de sumir do painel (#75), e a
  quarta linha não vaza mais sob o clamp do card do dashboard.


## [0.12.0] - 2026-08-30

Execução autônoma de longa duração: a camada de resiliência da issue #63. O
pipeline deixa de assumir execução perfeita — uma queda de rede de trinta
segundos, um `Ctrl+C` ou um agente travado passam a ter resposta, e o que
não tem resposta automática vira uma pergunta explícita a um humano.

Três limites valem para tudo o que segue: **falha lógica de implementação nunca
entra em retry** (um teste que quebra tem o ciclo de correção, não backoff);
**nenhuma operação destrutiva é executada para "consertar" estado**; e todo
comportamento novo é opt-in ou tem default idêntico ao de antes.

### Added

- **Camada de resiliência (`src/resilience/`)** (#63, #64). `errors.ts`
  classifica a falha a partir de sinal estruturado — `errno`, status HTTP, como
  o processo terminou, exit code — e só recorre ao texto em último caso;
  `policy.ts` traz a política por tipo de falha (tentativas, backoff exponencial
  com full jitter, teto, `Retry-After`); `retry.ts` é o **único executor de
  retry do projeto**, para onde `core/phase-runner.ts` e o loop do `execute`
  passaram a delegar.
- **Chave `resilience` na escada de configuração** (#64). CLI > env
  (`ISSUE_FLOW_RESILIENCE_*`) > `.issue-flow.json` > `~/.issue-flow/config.json`
  > defaults, com o `retry` mesclado dois níveis — por tipo de falha *e* por
  campo. Ausência de configuração resolve para `{}`, que é exatamente o
  comportamento de todas as versões anteriores.
- **`--retry-limit` e `--retry-forever` no `run`** (#64), até então exclusivos
  do `execute` — o modo que a maioria usa era o que tinha menos controle.
- **Journal append-only (`events.jsonl`)** (#66). Uma linha JSON por
  `SessionEvent`, com `seq` monotônico e rotação por tamanho. Fica **ao lado**
  do `session.json`: o snapshot continua sendo a projeção, o journal é a
  história — e relê-lo pelo mesmo reducer reconstrói o snapshot. Opt-in via
  `resilience.journal.enabled`.
- **`run.lock` com heartbeat** (#66). Dono de execução por projeto: uma segunda
  invocação recusa nomeando pid, host e horário do último heartbeat, em vez de
  disputar o `tasks.json` e a branch. Um lock cujo dono morreu é assumido e
  registrado como run interrompida.
- **`issue-flow resume`** (#66). Retomada explícita: lê o lock, os planos e o
  journal (o último `phase:start` sem `phase:end` diz o que estava rodando),
  roda o preflight e retoma da primeira fase incompleta. O auto-resume do `run`
  continua igual.
- **Preflight de repositório** (#66). Rebase, merge, cherry-pick ou revert em
  curso, conflito não resolvido, HEAD destacado ou branch diferente da do plano
  **param** a fase com o comando de saída sugerido. Nada é consertado
  automaticamente: sem `reset --hard`, sem `--abort`, sem stash implícito.
- **Encerramento gracioso** (#67). `Ctrl+C` agora aborta o sinal do processo
  (cortando qualquer backoff pendente), grava o checkpoint com a issue em
  `paused`, manda `SIGTERM` ao agente com 15s de tolerância antes do `SIGKILL`,
  publica `session:end` e fecha o journal. Um segundo `Ctrl+C` encerra na hora.
- **Watchdog de inatividade** (#70). `--inactivity-timeout <s>` (default 600,
  `0` desliga) distingue "tarefa longa" de "travado": sem nenhum evento no
  stream por tempo demais, o agente é parado e a falha é classificada como
  `stalled` — retentável. O timeout absoluto continua existindo como teto.
- **`--on-issue-failure <stop|skip|block>`** (#70). Numa fila, `skip` põe a
  issue de lado, segue com as independentes e volta a ela no fim; `block` a
  reserva para um humano. `stop` continua o default.
- **`--continuous` / `--resilient`** (#70): um perfil, não um mecanismo. Liga
  retry infinito para rede e rate limit, failover, `--on-issue-failure skip`,
  journal e watchdog — e cada um deles continua ajustável em separado, com
  qualquer flag granular vencendo o perfil.
- **Superfície de operação** (#70): `issue-flow status` (quem está rodando, em
  que fase, em que tentativa, há quanto tempo sem atividade), `runs` (histórico
  com status, duração e causa), `logs` (o journal, com `--follow` e `--kind`),
  `pause` e `cancel`. Os dois últimos apenas sinalizam o dono da run — que já
  sabe parar bem.
- **Relatório de decomposição** (#71). Dois ou mais sinais de "issue grande
  demais" (timeouts repetidos na mesma fase, mais de 15 stories, 5 iterações
  seguidas sem concluir nada, mais de 40 arquivos tocados, corpo com mais de
  20 000 caracteres, `execute` esgotando as iterações) geram
  `decomposition.md` e marcam a issue `blocked`. Quebrar a issue é decisão de
  produto: o default é relatar. `--auto-decompose` cria as sub-issues, e recusa
  fazê-lo quando a branch já tem trabalho commitado.

### Changed

- **Toda chamada `gh` passa a ter política de retry** (#65). Uma oscilação de
  DNS durante `resolveCommandIssue()` — chamado no início de *toda* fase —
  deixa de derrubar a run: a falha é classificada e ganha o orçamento do seu
  tipo (rede: 8 tentativas, 2s a 120s com jitter; rate limit: o `Retry-After`
  do servidor). Uma credencial expirada **não** é retentada: para na hora e diz
  o que fazer (`gh auth login`).
- **`utils/shell.ts:run()` aceita `retry` opcional** (#65). Sem ele o
  comportamento é byte a byte o de antes. Operações destrutivas de git
  (`push --force`, `reset --hard`, `rebase`, `cherry-pick`, …) nunca são
  repetidas, mesmo sob `retryForever`.
- **O stream de eventos é sempre pedido à CLI** (#70). `--output-format json`
  entregava uma única escrita no fim, o que deixava o modo não-verbose sem
  sinal nenhum enquanto o agente trabalhava. Agora é sempre `stream-json`, e
  só a renderização muda: verbose imprime, não-verbose alimenta spinner e
  heartbeat. O que o chamador recebe é o mesmo.
- **A fase `pr` adota um Pull Request já aberto para a branch** (#68) em vez de
  abrir um segundo — risco que cresceu quando o timeout passou a ser
  corretamente classificado como transitório e a fase ganhou suas retentativas.
- **Checkpoint pós-commit de story no `execute`** (#68). Se o commit da story
  já está na branch e a árvore está limpa, ela é adotada em vez de reexecutada:
  a janela entre o commit e a escrita do `passes` deixa de custar trabalho
  refeito. O `passes` do agente continua sendo a fonte primária.
- **`prReview.publisher` aceita `github`** (#68), que comenta no Pull Request
  **atualizando** o comentário da mesma rodada em vez de empilhar cópias. O
  default segue `local`.
- **`tasks.json` ganha `runState` e a fila ganha `blocked`/`skipped`,
  `attempts` e `blockedReason`** (#66) — tudo aditivo, `schemaVersion`
  inalterado, e um arquivo escrito por versão anterior continua sendo lido.

### Known limitations

- **Failover entre providers de agente não entrou.** Saúde, cooldown e cadeia
  de fallback (`src/agents/health.ts` e `select.ts`) dependem da camada de
  agentes da #62, ainda aberta. A configuração já existe
  (`resilience.providers.*`, `--no-failover`, e `--continuous` ligando
  `failover: true`), então falta apenas a implementação em cima da #62.
- No dashboard, os campos de *provider* e *cooldown* dependem da mesma #62; a
  aba de histórico lendo o journal ainda não existe.

## [0.11.1] - 2026-08-29

### Fixed

- **A headless timeout was reported as `claude exited with code 143`, and cost
  the phase every retry it had** (#72). `runHeadless()` runs execa with
  `reject: false`, so a timeout *resolves* instead of throwing — the `catch`
  block never saw one, and the only other check looked for `signalName`, a
  property execa 9 does not have. Detection now reads the finished result and
  covers all three shapes it arrives in (`timedOut: true`,
  `signal: SIGTERM/SIGKILL`, or a bare 143/137 exit code left behind by a CLI
  that handles the signal itself), guarded by the elapsed time so an unrelated
  external kill is not relabelled. The message keeps the words `timed out`,
  which is what `isTransientFailure()` matches on, so the phase gets its three
  attempts back — and now says how to raise the limit.

### Changed

- **One timeout for every single-invocation phase, raised to 15 minutes**
  (#72). `analyze`, `prd`, `plan`, `review`, `pr` and `generate` each carried a
  literal `300_000`, `pr-review` carried `900_000`, and the README documented a
  third number. They now share `DEFAULT_HEADLESS_TIMEOUT_MS`, so `--timeout`
  still wins and `--timeout 0` still means no limit. The `execute` loop remains
  the deliberate exception, with no limit at all, because its iteration budget
  is what bounds it.

## [0.11.0] - 2026-08-29

### Added

- **Convention-aware initialization** — Issue Flow now works predictably both in
  repositories that already have conventions and in ones that have none.
  - **A documented default convention set** (`src/conventions/defaults.ts`,
    [`docs/conventions.md`](docs/conventions.md)): six issue types (Idea,
    Research, Epic, Feature, Bug, Task — the last three being GitHub's own
    defaults), a small cross-cutting label vocabulary, and an explicit list of
    what is deliberately *not* a type. It applies only where the repository, its
    organization and the user's configuration are all silent.
  - **`issue-flow init` now reports and can create what a repository is
    missing**: `--apply` writes, `--json` emits the plan, `--scope` resolves a
    monorepo subdirectory, `--check-only` restores the old prerequisites-only
    behavior. The convention half never changes the exit code, so a script that
    treats `init` as a prerequisite gate is unaffected.
  - **The `init-repository` skill** drives the same core through
    `issue-flow init --json` rather than re-deriving the analysis, so both
    interfaces produce the same plan.
  - Initialization is **non-destructive and idempotent**: nothing that exists is
    ever overwritten, existence is re-checked immediately before each write, and
    a second run writes nothing.
  - **`AGENTS.md` is established as the canonical agent entry point** and
    `CLAUDE.md` as a one-line bridge to it. Scaffolding generates both that way,
    and a repository whose `CLAUDE.md` carries its own instructions is reported
    for a human decision — promoting it means moving text somebody wrote, which
    is never automatic.

### Fixed

- **Organization-published Issue Forms were invisible.** GitHub's
  `issueTemplates` GraphQL connection only returns *markdown* templates, so a
  repository whose organization publishes `.yml` Issue Forms looked like a
  repository with no templates at all — and would have been given a local copy of
  the organization's. Discovery now also reads the organization's `.github`
  repository tree, in a single call that returns names and contents together.

- **The repository policy reaches the flows** (issues #57, #58, #59, #60, #61).
  v0.10.0 shipped the discovery layer with no consumers; this connects it.
  - **Projection into the prompts and per-repository overrides** (#57): the
    `__REPO_*` placeholders carry a *summary* of the policy, budgeted by
    `policy.contextBudget` (default 1500 tokens) and degrading a whole section to
    a pointer rather than truncating mid-rule. `__REPO_DOCS__` carries **paths,
    never content** — the agent has `Read`, and embedding documents would
    multiply the cost of every run. A repository may now adjust any prompt via
    `.issue-flow/prompts/<name>.append.md` (recommended) or `<name>.md`
    (replacement, which makes the repository inherit that prompt's maintenance).
  - **Issue creation aware of templates, types and labels** (#58): the
    applicable Issue Template defines the body; Issue Types are passed with
    `--type`; the title follows the repository's convention, with no textual
    prefix when the repository uses Issue Types.
  - **Reviews validate conformance** (#60): `review` and `pr-review` gain an
    explicit policy-conformance axis. Every violation cites the document and
    section that defines the rule — a violation without a citation is an opinion
    the author cannot check. Severity is calibrated: a mandatory rule, a missing
    required template field or a wrong base branch blocks; a formatting
    divergence is an observation. `CODEOWNERS` is recorded, never blocked on.
  - **Parity between the Agent Skills and the CLI** (#61): both paths now decide
    from the same resolved policy, through `issue-flow policy --json` — a
    published contract with a `schemaVersion`, since skills are markdown and
    cannot import TypeScript. `skills/_shared/repository-policy.md` is the single
    source every policy-aware skill references rather than reproduces, and a
    parity test fails if one starts deciding differently. The step is
    best-effort by design: without the CLI, the network, or a declared policy,
    every skill continues with its documented defaults.

### Fixed

- **Pull Requests were opened against the wrong base branch** (#59) —
  `prompts/pr.md` hard-coded `main` in `git log main..HEAD`, `git diff
  main...HEAD` and `gh pr create --base main`. In a repository based on
  `develop`, `main` usually **exists** too, so nothing failed: the agent simply
  reviewed the wrong diff and opened the Pull Request against the wrong target.
  The base is now resolved from the repository (`policy.pullRequests.baseBranch`,
  then `origin/HEAD`, then `main`), and the same fix reaches `review-issue`,
  `create-pr`, `review-pr` and the `resolve-issue` agent.
- The branch pattern `issue/{N}-*` is no longer normative in `create-pr`:
  repositories using `feat/`, `fix/`, `docs/` or `chore/` are following a common
  convention, and refusing to open their Pull Requests was the skill's problem.
  The issue number now falls back to a `Closes #N` in the branch's commits and to
  the run in progress before asking.
- The execute loop no longer commits every story as `feat`. When the repository
  declares a commit convention, the type must match the nature of the change: a
  bug fix committed as `feat:` corrupts the changelog and any version bump
  computed from the history.

### Changed

- **Issue Flow no longer creates labels.** A label suggested for an issue that
  the repository does not have is dropped with a warning instead of being
  created. This is a deliberate behavior change: a team that deleted
  `high`/`medium`/`low` in favor of a native priority field, or
  `bug`/`enhancement` in favor of Issue Types, made a governance decision, and
  recreating those labels undoes it silently and repository-wide — worse than a
  failure, because it succeeds. Set `policy.issues.allowLabelCreation: true` to
  restore the previous behavior.
- `mergeConfigLayers()` gained a `discovered` layer, between the defaults and the
  global configuration, so repository-discovered values beat a fallback Issue
  Flow invented and lose to anything the user configured explicitly.

### Compatibility

A repository that declares no policy renders every prompt **byte for byte** as it
did before, which a test pins over every file in `prompts/`. The single
intentional exception is label creation, above.

## [0.10.0] - 2026-08-29

### Added

- **Repository policy discovery and resolution** (issue #56) — a single layer,
  `packages/issue-flow/src/policy/`, that finds what the consumer repository
  already declares about itself, resolves the hierarchy applying to a path, and
  returns one typed `RepositoryPolicy` with the provenance of every value.
  - **Discovers** Issue Templates and Forms (`.github/ISSUE_TEMPLATE/**`,
    `docs/ISSUE_TEMPLATE/**`, the root, plus the single-file `ISSUE_TEMPLATE.md`
    variant of each), the Pull Request template in every layout GitHub supports
    including the directory of several, `AGENTS.md` and `CLAUDE.md` from the
    root down to the scope, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
    `CODEOWNERS`, the labels that really exist (`gh label list`), the
    organization's Issue Types (`gh api orgs/{org}/issue-types`) and the base
    branch (`origin/HEAD`, then a local `main`/`master`).
  - **Organization defaults** come from the GraphQL `issueTemplates` connection,
    consulted only when the local tree has none: a repository with no
    `.github/ISSUE_TEMPLATE/` still serves the organization's on github.com, and
    filesystem discovery cannot see them. REST has no issue-template endpoint at
    all, and the GraphQL connection returns the bodies inline, so the whole
    lookup costs one round-trip.
  - **Documents are followed, not scanned**: the markdown links of `AGENTS.md`
    are walked one level. Scanning `docs/` blindly would pull in changelogs and
    ADR archives the repository never nominated as policy.
  - **Silent degradation is the contract.** A repository declaring none of this
    resolves to an empty policy, with no error and no warning — the exact input
    every flow had before. A missing or unauthenticated `gh`, or no network,
    degrades the same way; `sources` then records the source as `unavailable`,
    which is what distinguishes "declares nothing" from "could not find out".
    Every network call carries a timeout, each kind of data costs at most one
    `gh` invocation, and the resolution is cached once per `(root, scope)`.
  - **Precedence** reuses `mergeConfigLayers()`, which gains a `discovered`
    layer: defaults < discovered < `.issue-flow.json` < `ISSUE_FLOW_POLICY_*` <
    CLI. The new `policy` key declares what discovery cannot infer
    (`issues.titleConvention`, `pullRequests.baseBranch` and
    `titleConvention`, `git.branchConvention` and `commitConvention`) and turns
    off what it gets wrong (`discovery.*`); `policy.enabled: false` returns
    before a single `stat()` or network call.
  - **New command** `issue-flow policy [--scope <dir>] [--json]` prints the
    resolved policy and its provenance. It is the debugging surface and the
    bridge to the Agent Skills, which are markdown and cannot import TypeScript
    — hence the `schemaVersion` stamped on the JSON payload rather than on the
    CLI.

  Fully additive: no prompt, skill or phase consumes the layer yet, and no
  observable behavior changes. An `.issue-flow.json` without the `policy` key
  stays valid.

## [0.9.0] - 2026-08-20

### Added

- **Multiple issues and hierarchies in the pipeline** (issues #50, #51, #52, #53).
  - Hierarchy and dependency **discovery** (#50): `IssueProvider.fetchRelations?`
    plus a GitHub implementation reconciling the Sub-issues API, the Issue
    Dependencies API (`blocked_by`/`blocking`), timeline cross-references and a
    documented textual heuristic over the issue body. `buildDependencyGraph`
    walks it breadth-first with configurable node/depth limits and records
    cycles instead of throwing.
  - **Ordered plan and confirmation** (#51): `issue-flow run` accepts `42,43,50`
    and `42 43 50`; when a larger structure is found the run stops before any
    phase, shows the suggested order and offers "only what I informed" / "the
    whole hierarchy" / "cancel". `--yes` and `--only` answer it non-interactively
    (outside a TTY one of them is required). The order respects dependencies →
    hierarchy → priority labels → issue number, and a dependency cycle is an
    explicit error.
  - **Sequential execution on one branch** (#52): the whole queue runs in a
    single process, sharing one branch, with commits scoped per issue
    (`feat(issue-51): …`), per-issue token/cost accounting, and resume from the
    issue that failed without redoing the ones already completed. Queue state
    lives in `~/.issue-flow/projects/<id>/queues/<queue-id>/execution-plan.json`.
  - **One consolidated Pull Request** (#53): a single PR for the whole queue,
    with the issues implemented, the execution order, the pending items and one
    `Closes #N` per issue hosted on GitHub. The reference is replicated to every
    issue's `tasks.json`, so `pr-review --issue <any>` still finds it.

- **User Story numbering continuity** (issue #36, PR #48) — `plan` no longer
  restarts at `US-001` on every run. The highest `US-NNN` already used anywhere
  in the project is recovered from the global storage and the new plan continues
  from it, so ids no longer collide between issues of the same project.
  - `--start-us <n>` forces a starting number, ignoring history; `--continue`
    names the (already automatic) history-based behavior explicitly. Combining
    both fails with a clear error before anything runs.
  - The decision is always logged and persisted to the project's
    `metadata.json` for audit.

- **Real-time execution state of User Stories** (issue #38, PR #49) — each entry
  of `stories[]` in the session snapshot now carries `stage`, `stageSince` (ISO
  timestamp of the event that produced the stage) and `stageDetail` (a short
  human string, currently only used by `in_correction`). Where `status` is the
  four-value board summary, `stage` tracks the real pipeline cycle a story goes
  through: `execute` → `review` → correction (when needed) → `done`/`failed`.
  - Stages are set directly by the event that causes the transition, not
    recomputed on every reduction, so `in_correction` survives an unrelated
    `stories:update` in between. `iteration:start` gained an optional `storyId`
    and `correction:cycle` already carried `cycle`/`maxCycles`.
  - `done` and `failed` are the only terminal stages; `session:end` closes
    whatever was still `executing`, `in_review` or `in_correction`.
  - The terminal shows the active story's stage, and the web panel highlights
    the story being executed.

- **Multi-project dashboard in the web monitor** (issue #35, PR #55) — with two
  or more active sessions the monitor's home page becomes a dashboard with one
  card per execution (repository, issue number and title, short description,
  current phase, progress, elapsed time, status, and a live indicator while
  `status` is `running`). Clicking a card opens that session's existing detail
  view; a "Todas as execuções" control returns to the dashboard.
  - With exactly one active session the behavior is unchanged: the monitor opens
    the detail view directly, with no extra click.
  - `GET /api/sessions` was enriched with the card summary fields, so the client
    no longer needs N× `/api/status` fetches just to paint the list.
    `issueDescription` is a whitespace-collapsed preview, not the full body.
  - The mode is re-evaluated on every poll, so a second run started while the
    monitor is already open switches to the dashboard with no manual reload.

### Changed

- `core/session-metrics.ts` keeps a **stack** of usage scopes instead of a single
  module-level accumulator, so several issues can run in one process without
  their costs leaking into each other's summary (the caveat previously
  documented in `src/core/CLAUDE.md`).
- **Behavior change**: `plan` runs on a project that already has plans now start
  above the last used number instead of at `US-001`. Re-running `plan` for the
  same issue is idempotent — the plan it is about to overwrite is excluded from
  the scan. Pass `--start-us 1` to restore the old behavior for a single run.
- A storage failure while scanning the numbering history now aborts with an
  explicit error instead of silently restarting the numbering at `US-001`.

### Compatibility

- A single issue with no discovered relations behaves exactly as before: no
  prompt, no queue artifact, the same commit format and the same Pull Request
  body.
- A run asking for **one** issue never fails because of its hierarchy: a
  dependency cycle discovered around it, or a non-interactive terminal with no
  `--yes`/`--only`, degrades to the plain single-issue pipeline with a warning
  instead of exiting `1`. Only an explicitly multi-issue request is refused.
- `--start-us <n>` applies to the first issue of a queue only; the rest continue
  from the history those plans just wrote.
- A queue that already completed is reported and left untouched, instead of
  being re-planned and overwriting its recorded Pull Request.

## [0.8.0] - 2026-08-04

### Added

- Kanban view of the user stories in the web monitor (issue #31, PR #47)

## [0.7.7] - 2026-08-04

### Added

- US-007 - Cobertura de testes dos cenarios de instancia unica
- US-002/US-003/US-004/US-005/US-006 - Servidor web desacoplado, multi-sessao e modo legado
- US-001 - Lock/PID file com detecção de instância viva

### Fixed

- OnSignal deve chamar handle.close para incluir cleanup de lock/poller

### Changed

- US-008 - Atualizar Web Monitoring com o modelo de instancia unica

## [0.7.6] - 2026-08-04

### Added

- US-003 - Estender card de User Stories com status, progresso e dependencias
- US-002 - Adicionar card Repositorio ao painel
- US-001 - Adicionar card Resumo da Issue ao painel

### Fixed

- Usar checagem explícita de null/undefined para story.status

### Changed

- US-004 - Atualizar Web Monitoring com os novos cards do painel

## [0.7.5] - 2026-08-04

### Added

- US-006 - Documentacao do formato do snapshot e nao-regressao
- US-005 - Publicar a secao repository no snapshot
- US-004 - Publicar a secao issue enriquecida no snapshot
- US-003 - Semear as user stories do tasks.json existente no inicio da sessao
- US-002 - Expor status e dependencies no SessionStorySnapshot com derivacao no reducer
- US-001 - Estender o schema de user story com status e dependencies

### Fixed

- Strip embedded credentials from published repository.remoteUrl

## [0.7.4] - 2026-08-04

### Fixed

- Update @biomejs/biome version in package.json and package-lock.json to 2.4.10 and 0.27.7 respectively

## [0.7.3] - 2026-08-04

### Added

- US-012 - Retrocompatibilidade e não-regressão
- US-011 - Documentação dos novos campos e limitações
- US-010 - Tokens e tempo no painel web
- US-009 - Tokens e custo no terminal
- US-008 - Métricas por story persistidas em tasks.json
- US-007 - Métricas por iteração e por story na fase execute
- US-006 - Fases de invocação única publicam suas métricas
- US-004 - Evento metrics:update e sua redução
- US-005 - Campos de métricas no SessionSnapshot e schema em lockstep
- US-003 - Instrumentar executor.ts (fase execute)
- US-002 - headless.ts passa a capturar métricas corretamente
- US-001 - Parser único de métricas do CLI (core/metrics.ts)

### Changed

- Update README and CLAUDE.md to clarify per-story attribution and usage counters
- CLAUDE.md de src/core com contratos do redutor e do executor

## [0.7.2] - 2026-08-04

### Added

- US-011 - Documentação e .gitignore
- US-010 - Suíte de testes no novo layout, incluindo cenário real de migração
- US-009 - Eliminar getIssueDir() e travar a regra por teste
- US-008 - Migrar LocalFileIssueProvider
- US-007 - Migrar resolvePaths() / execute
- US-006 - Migrar run e o FilePublisher
- US-005 - Migrar review, pr e pr-review
- US-004 - Migrar analyze, prd e plan
- US-003 - Fases headless conseguem escrever fora do repositório
- US-002 - Aviso de migração visível ao usuário
- US-001 - Resolver central de paths de issue com migração automática

### Fixed

- LocalFileIssueProvider.isAvailable() não deve criar diretório global

## [0.7.1] - 2026-08-04

### Added

- US-009 - Implementa correção de revisão e persistência de resultados
- US-008 - Documentacao da nova estrutura
- US-007 - Compatibilidade e migracao nao destrutiva
- US-006 - loadGlobalConfig() e precedencia documentada
- US-005 - Schemas Zod de storage
- US-004 - Resolucao centralizada de paths de issue
- US-003 - Geracao deterministica de project-id
- US-002 - Leitura normalizada do remote git
- US-001 - Resolucao do diretorio global com override por env var

### Fixed

- Elimina segunda chamada a getRemoteUrl em migrateLegacyStorage

### Changed

- Atualiza plano e progresso da issue 32 (US-002)

## [0.7.0] - 2026-08-03

### Added

- US-014 - Documentacao e validacao final
- US-013 - Skill review-pr e registro no agente
- US-012 - Configuracao prReview em .issue-flow.json
- US-011 - Superficies de UI e monitoramento
- US-010 - Correcao do gh pr list --head vazio
- US-009 - Integracao com o comando run
- US-008 - Registro na CLI
- US-007 - Comando issue-flow pr-review [pr]
- US-006 - Prompt pr-review.md
- US-005 - Parser, relatorio e indice estruturado
- US-004 - Descoberta automatica do Pull Request
- US-003 - A fase pr persiste o Pull Request criado
- US-002 - Estado retrocompativel em tasks.json
- US-001 - Conjunto de fases da pipeline com pr-review

### Changed

- Update .gitignore to exclude issues and node_modules directories
- Remove obsolete results.json file from vitest directory
- Clarify read-only nature of PR review phase and update documentation
- Remove arquivos obsoletos da issue 25, incluindo .last-branch, prd.md, progress.txt e tasks.json
- Marca fase review como concluida na issue 25
- Marca US-013 como concluida e registra progresso
- Marca US-012 como concluida e registra progresso
- Marca US-011 como concluida e registra progresso
- Consolida padroes de teste e narrowing no progresso da issue 25
- Marca US-008 como concluida e registra progresso
- Marca US-006 como concluida e registra progresso
- Marca US-004 como concluida e registra progresso
- Marca US-003 como concluida e registra progresso
- Marca US-002 como concluida e registra progresso
- Marca US-001 como concluida e registra progresso
- Unify issue directory resolution across commands

## [0.6.0] - 2026-08-03

### Added

- US-015 - Documentacao e validacao final
- US-014 - Prova executavel de extensibilidade
- US-013 - Skill generate-local-issue
- US-012 - generate multi-destino
- US-011 - init nao bloqueia quando a origem e local
- US-008 - Migracao atomica dos cinco templates de prompt
- US-010 - run resolve uma vez e delega fechamento ao provider
- US-009 - Comandos da pipeline consomem resolveIssue
- US-007 - IssueResolver com matriz de cenarios
- US-006 - Configuracao de providers em .issue-flow.json
- US-005 - LocalFileIssueProvider
- US-004 - GitHubIssueProvider
- US-003 - Interface IssueProvider e registry
- US-002 - Schema de metadados e afrouxamento do taskPlanSchema
- US-001 - Modelo de dominio Issue e hash de conteudo

### Changed

- Remove deprecated files and finalize issue 23
- Marca review da issue 23 como concluido
- Consolida padroes da issue 23 (skills e flags de CLI)
- Atualiza plano e progresso da issue 23 (US-008/009/010)

## [0.5.2] - 2026-08-03

### Fixed

- Expõe monitor --web em 0.0.0.0 e adiciona retry às fases do pipeline

### Changed

- Delete obsolete files related to issue #22

## [0.5.1] - 2026-08-03

### Changed

- Version-only release: the tag carries nothing but the manifest bump. It exists
  because the 0.5.0 publish had already been made and the version had to move on.

## [0.5.0] - 2026-08-03

### Added

- **Web monitoring** (issue #22, PR #24) — `issue-flow run --web` starts a local
  HTTP server that serves a live dashboard of the running pipeline.
  - `src/core/session-state.ts` and `src/core/session-publisher.ts` — state
    publishing layer writing an atomic `issues/{N}/session.json` snapshot.
  - `src/web/server.ts` — zero-dependency HTTP server with polling endpoint.
  - `web/public/{index.html,app.js,app.css}` — dashboard UI, packaged with the
    CLI and resolved at runtime alongside `prompts/`.
  - Execution instrumentation: current phase, story, active tool, and tracking
    of commits and PRs created during the run.
  - Configuration via CLI flags, environment variables, and `.issue-flow.json`.
- `LICENSE` file (MIT) at the repository root and inside the package — the
  manifest declared MIT but no license file existed.
- `CHANGELOG.md` (this file).

### Changed

- Monitoring is strictly non-invasive: publish failures are swallowed with a
  single warning, a busy port (`EADDRINUSE`) skips the server, and killing the
  server mid-run has no effect on the pipeline. With `--web` off, terminal
  output and behavior are unchanged.
- `PIPELINE_PHASES` declaration simplified in `src/core/pipeline.ts`.
- CI matrix now runs Node 22 and 24, matching `engines.node >= 22.0.0`
  (it was testing Node 18 and 20, which the package does not support).

### Fixed

- `npm version` no longer bumps the manifest without creating a commit and a
  tag. npm only runs its git step when it finds a `.git` directory inside the
  package folder; in this monorepo `.git` is at the root, so the bump was
  silently untagged — the root cause of 0.4.3 and 0.4.4 reaching npm with no
  tag. `preversion`/`postversion` hooks (`scripts/git-version.mjs`) now refuse
  to bump a dirty tree and create the release commit and annotated tag.
- `prepack` and `prepublishOnly` scripts added to the package manifest, so
  `npm publish` always rebuilds `dist/` and gates on lint, typecheck, and tests.
  Previously a stale or missing `dist/` could be published silently.
- Package metadata completed with `author`, `homepage`, and `bugs`.
- `tsconfig.json` no longer declares `declaration`, `declarationMap`, and
  `outDir`, which the tsup-based build (`dts: false`) never used.
- Release documentation in `packages/issue-flow/CONTRIBUTING.md` rewritten: it
  described a `.github/workflows/publish.yml` that had been deleted, so anyone
  following it would push a tag and publish nothing.

## [0.4.4] - 2026-04-01

### Removed

- The `analyze` phase was removed from the pipeline; related documentation
  updated accordingly.

### Documentation

- Added an example of running on the current branch without creating a PR.

## [0.4.3] - 2026-04-01

### Added

- `--no-branch` flag (issue #20): run the pipeline on the current branch
  without creating a new one, with the execution mode persisted in `tasks.json`.
- Configurable pipeline phases in `PipelineManager`.
- Conditional summary output.

### Changed

- Verbosity checks for logging and bottom bar display adjustments.
- Invalid flag combinations are now rejected explicitly.

## [0.4.2] - 2026-04-01

### Fixed

- The version reported by the CLI is now read from `package.json` at runtime
  instead of being hardcoded, so `issue-flow --version` can no longer drift out
  of sync with the published version.

## [0.4.1] - 2026-04-01

> Tagged but **never published to npm**.

### Fixed

- Duplicate `execute` output (issue #17): direct stderr writes were removed from
  the executor and all output routed through the output callback.
- Non-TTY / CI output verified to remain readable.

## [0.4.0] - 2026-04-01

### Added

- Terminal UI redesigned around listr2 (issue #15): single-writer pipeline
  progress display, execute-phase subtask progress, and CI-friendly fallback
  rendering for non-interactive environments.

### Changed

- Output routing consolidated in `core/engine.ts`; verbose mode kept compatible
  with the new renderer.

### Removed

- `PipelineTracker`, superseded by the new progress display.
- `.github/workflows/publish.yml` — automated npm publishing was dropped in
  favor of a manual release flow. (The documentation was not updated at the
  time; this was corrected in 0.5.0.)

## [0.3.1] - 2026-04-01

### Changed

- Formatting and type-safety improvements in the CLI and headless modules.

## [0.3.0] - 2026-04-01

First release published to npm under the `issue-flow` name.

### Added

- Subcommand architecture for the CLI: `init`, `generate`, `analyze`, `prd`,
  `plan`, `execute`, `review`, `pr`, and the `run` full-pipeline orchestrator.
- `core/headless.ts` — typed wrapper for Claude Code Headless invocations.
- `core/pipeline.ts` — pipeline state machine with resume support.
- Zod validation schemas for headless outputs and pipeline state.
- Global `--timeout` and `--verbose` options.
- Biome for formatting, linting, and import organization.
- CI workflow (`.github/workflows/ci.yml`).
- `CONTRIBUTING.md` with development and publishing instructions.

### Changed

- Package renamed from `ralph-agent` to `issue-flow`.
- Node.js requirement raised to `>= 22.0.0`.

### Removed

- The Ralph pattern and `ralph.sh`; prompts unified under Issue Flow.
- Obsolete marketplace and plugin configuration files.

## [0.2.0] - 2026-03-19

> Skills-only release, predating the npm package. **Never published to npm.**

### Added

- Skills for the full issue lifecycle: `analyze-issue`, `generate-prd`,
  `convert-prd-to-json`, `execute-tasks`, and the `resolve-issue` orchestrator.
- `ralph.sh` for autonomous task execution, with dependency validation,
  Bash version checks, a portable shebang, and remote execution support.

### Changed

- Project renamed from `agent-skills` to `issue-flow`.

## [0.1.0] - 2026-03-18

> Skills-only release, predating the npm package. **Never published to npm.**

### Added

- Initial set of Claude Code Agent Skills, including issue generation with
  environment validation, language detection, and scope control.
- Installation documentation via `skills.sh` and manual setup.

[0.18.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.18.0
[0.19.1]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.19.1
[0.17.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.17.0
[0.16.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.16.0
[0.15.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.15.0
[0.14.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.14.0
[0.13.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.13.0
[0.12.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.12.0
[0.11.1]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.11.1
[0.11.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.11.0
[0.10.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.10.0
[0.9.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.9.0
[0.8.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.8.0
[0.7.7]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.7.7
[0.7.6]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.7.6
[0.7.5]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.7.5
[0.7.4]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.7.4
[0.7.3]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.7.3
[0.7.2]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.7.2
[0.7.1]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.7.1
[0.7.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.7.0
[0.6.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.6.0
[0.5.2]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.5.2
[0.5.1]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.5.1
[0.5.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.5.0
[0.4.4]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.4.4
[0.4.3]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.4.3
[0.4.2]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.4.2
[0.4.1]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.4.1
[0.4.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.4.0
[0.3.1]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.3.1
[0.3.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.3.0
[0.2.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.2.0
[0.1.0]: https://github.com/fabioassuncao/issue-flow/releases/tag/v0.1.0
