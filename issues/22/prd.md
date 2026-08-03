# PRD: [Enhancement] Modo opcional de monitoramento web em tempo real para sessões

> Issue: [#22](https://github.com/fabioassuncao/issue-flow/issues/22) · Labels: `enhancement`, `medium`, `backend`, `monitoring`

## Context

O comando `issue-flow run <N>` executa o pipeline completo (`init → prd → plan → execute → review → pr`) de forma autônoma. Em issues médias e grandes, a fase `execute` (`packages/issue-flow/src/core/engine.ts`) itera uma instância headless do Claude Code por user story; somado ao ciclo de auto-correção da fase `review` (até `maxCorrectionCycles`, default 3) e ao backoff de retries (até 900s em `src/utils/retry.ts`), uma execução real pode durar horas.

Durante todo esse período, a única superfície de observação é o terminal onde o processo foi iniciado (árvore `listr2` renderizada por `src/ui/pipeline-renderer.ts`), o que impõe três limitações:

1. **Presença física obrigatória** — acompanhar exige acesso ao terminal (local, `tmux`/`screen` ou SSH).
2. **Estado efêmero** — o renderer sobrescreve linhas; não há histórico consultável após fechar o terminal.
3. **Sem visão consolidada** — o estado real está fragmentado entre `issues/N/tasks.json`, `issues/N/progress.txt`, o histórico do git e o GitHub. Dados voláteis (iteração atual, retries, ferramenta em uso, durações por fase/story) existem apenas em memória e são descartados ao fim do processo.

A necessidade concreta é acompanhar remotamente uma sessão em andamento dentro da rede privada (Tailscale), abrindo uma página no navegador e entendendo imediatamente o estado da execução — sem depender do terminal e sem interferir no processo.

O projeto já possui os *seams* necessários: o choke point de logs `emit()` (`src/ui/logger.ts:76-83`), o parse de `tool_use` em `printStreamEvent()` (`src/core/headless.ts:76-127`), as fronteiras de fase centralizadas em `src/commands/run.ts` + `src/ui/pipeline-renderer.ts`, a escrita atômica validada de `src/core/state-manager.ts` e a resolução de assets de `src/core/prompt-resolver.ts`. A referência de implementação é o dashboard do projeto CNPJ Pipeline (`run_state.py` + `dashboard.py`), com divergências deliberadas documentadas na issue (sem CDN, sem framework, serve da memória, assets em arquivos).

## Goals

1. Oferecer um modo **opcional e desligado por padrão** de monitoramento remoto via HTTP, ativado por flag explícita (`--web` / `--serve`).
2. Introduzir uma **camada única de publicação de estado** (`src/core/session-state.ts`), desacoplada da execução, que sirva à UI web hoje e a webhooks/SSE/controle remoto no futuro.
3. Expor um **endpoint JSON estável e versionado** (`GET /api/status`, `schemaVersion: 1`) e o arquivo equivalente `issues/N/session.json` em disco, que sobrevive ao processo como artefato de post-mortem.
4. Entregar uma **interface web autocontida** (HTML/CSS/JS puros, sem framework, sem CDN, sem acesso à internet) que responda "o que está acontecendo agora?" em um relance.
5. Garantir **impacto zero na execução**: desligado, não custa nada (publisher nulo); ligado, jamais falha, atrasa ou derruba o pipeline.
6. **Nenhuma dependência de runtime nova** — o `package.json` permanece com as 6 dependências atuais (`node:http` e `node:fs` cobrem tudo).
7. Preparar o terreno para controle remoto futuro (parar, pausar, reexecutar, múltiplas sessões) **sem implementá-lo** e sem exigir refatoração depois (`readOnly`/`capabilities` no payload, namespace `POST /api/control/*` reservado, estado por issue).

### Não-objetivos de arquitetura (restrições)

- A execução **nunca** conhece o servidor; o servidor **nunca** escreve estado; apenas `session-state.ts` conhece o formato.
- A publicação **não** usa os slots globais `setOutputCallback`/`setStoryUpdateCallback` (já ocupados pela `listr2`); instrumenta na origem. `src/ui/pipeline-renderer.ts` **não é alterado**.

## User Stories

### US-001 — Camada de publicação de estado (`src/core/session-state.ts`)

Como mantenedor do pipeline, quero uma camada de eventos + snapshot desacoplada da execução, para que qualquer superfície (arquivo, HTTP, futuros webhooks) consuma um único formato de estado.

**Critérios de aceitação:**
- [ ] Novo módulo `src/core/session-state.ts` com a união `SessionEvent` (`session:start`, `phase:start/end`, `iteration:start/end`, `retry`, `stories:update`, `activity`, `log`, `correction:cycle`, `session:end`) e a interface `SessionPublisher` (`publish`, `snapshot`, `version`, `flush`, `close`).
- [ ] `publish()` é síncrono, sem `await` e sem throw; reduz o evento sobre o snapshot em memória via reducer puro.
- [ ] `NullPublisher` é o default: com `--web` desligado, cada ponto de instrumentação custa uma comparação e um retorno.
- [ ] `FilePublisher` escreve `issues/N/session.json` com escrita atômica (`mkdtemp` + `rename`, fallback `copyFile` para `EXDEV`), reaproveitando o padrão de `state-manager.ts`, com throttle (default 1000ms, configurável); eventos terminais (`phase:end`, `session:end`) forçam flush.
- [ ] Logs mantidos em ring buffer limitado (default 200 entradas) — memória constante em execuções de horas; mensagens armazenadas sem códigos ANSI.
- [ ] Toda I/O do publisher em `try/catch`, com aviso emitido uma única vez; falha de monitoramento jamais propaga erro à execução.
- [ ] `version()` retorna contador monotônico (base do ETag).
- [ ] Testes unitários do reducer em `session-state.test.ts`, sem I/O.

### US-002 — Formato do snapshot e schemas Zod

Como consumidor do estado (UI, integrações), quero um payload único, versionado e validado, servido idêntico pelo arquivo e pelo endpoint.

**Critérios de aceitação:**
- [ ] Snapshot com `schemaVersion: 1`, `sessionId`, `readOnly: true`, `capabilities: []`, dados da issue, `status` (`idle | running | completed | failed`), timestamps, `elapsedSeconds`, `progress` (percentual, contadores de fases e stories), `currentPhase`, `currentActivity` (story + ferramenta + detalhe + `since`), `phases[]` (com durações e erro), `stories[]`, `execution` (iteração, retries, ciclo de correção), `git` (branch, base, commits), `pullRequests[]`, `logs[]`, `errors[]`, `warnings[]`, `lastError`, `nextSteps[]` e `environment`.
- [ ] `estimatedRemainingSeconds` = média das durações das stories concluídas × stories pendentes; publicado como `null` com menos de duas amostras.
- [ ] `errors`/`warnings` são fatias derivadas do mesmo ring buffer de logs, não buffers separados.
- [ ] `nextSteps` derivado de `PIPELINE_PHASES` a partir de `currentPhase` (`src/core/pipeline.ts`), respeitando o modo `--no-branch` (issue #20).
- [ ] Schemas Zod do snapshot e da configuração web adicionados em `src/schemas.ts`; o payload servido valida contra o schema.

### US-003 — Configuração: flags CLI, env e `.issue-flow.json`

Como operador, quero ativar e ajustar o monitoramento por flag, variável de ambiente ou arquivo de configuração, com precedência clara.

**Critérios de aceitação:**
- [ ] Flags registradas em `src/cli.ts` nos comandos `run` e `execute`, resolvidas no hook `preAction`: `--web` / `--serve` (alias), `--port <n>`, `--host <h>`, `--refresh <s>`, `--web-log-limit <n>`, `--web-no-logs`.
- [ ] Precedência: flag CLI > env (`ISSUE_FLOW_WEB`, `ISSUE_FLOW_WEB_PORT`, `ISSUE_FLOW_WEB_HOST`, `ISSUE_FLOW_WEB_REFRESH`, `ISSUE_FLOW_WEB_LOG_LIMIT`) > arquivo `.issue-flow.json` (chaves `web.enabled`, `web.port`, `web.host`, `web.refreshSeconds`, `web.logLimit`, `web.includeLogs`) > defaults (`false`, `3737`, `127.0.0.1`, `5`, `200`, logs incluídos).
- [ ] `loadWebConfig()` em `src/config.ts` implementa a cadeia; `.issue-flow.json` é inteiramente opcional — ausência ou conteúdo inválido cai para os defaults com um aviso, sem falhar.
- [ ] Testes cobrindo a precedência.

### US-004 — Instrumentação da execução

Como operador, quero que o estado publicado reflita fielmente o que o pipeline está fazendo, sem alterar o comportamento do terminal.

**Critérios de aceitação:**
- [ ] `src/ui/logger.ts`: `emit()` passa a receber nível estruturado (`info`/`warn`/`error`) e encaminha ao publisher com ANSI removido; a saída do terminal permanece idêntica.
- [ ] `src/commands/run.ts`: emite `session:start`, `phase:start`/`phase:end` ao redor de cada runner, `correction:cycle` no laço de correção e `session:end` no encerramento; sobe/derruba o servidor.
- [ ] `src/core/engine.ts`: emite `iteration:start/end`, `retry` e `stories:update` (no ponto onde já chama `getStoryUpdateCallback()`).
- [ ] `src/core/headless.ts`: `printStreamEvent()` emite `activity` (ferramenta + detalhe) ao detectar `tool_use`.
- [ ] Os slots globais `setOutputCallback`/`setStoryUpdateCallback` **não** são usados pela publicação; `src/ui/pipeline-renderer.ts` não é modificado.

### US-005 — Rastreamento de commits e PRs durante a execução

Como operador, quero ver na interface os commits produzidos e o PR aberto, sem esperar o fim do pipeline.

**Critérios de aceitação:**
- [ ] `src/utils/git.ts` ganha `getCommitsSince(base)` e `getBaseBranch()`.
- [ ] `git.commits` e `pullRequests` são atualizados apenas em fronteiras de fase e ao fim de cada iteração (enriquecimento de baixa frequência) — nunca por requisição HTTP.

### US-006 — Servidor HTTP (`src/web/server.ts`)

Como operador, quero um endpoint HTTP resiliente que sirva o estado sem jamais afetar o pipeline.

**Critérios de aceitação:**
- [ ] `node:http` puro; nenhuma dependência de runtime nova no `package.json`.
- [ ] Rotas: `GET /` (index.html), `GET /app.css`, `GET /app.js`, `GET /api/status`, `GET /status.json` (alias), `GET /api/sessions` (lista; v1 com um elemento), `GET /api/health` (`{ ok, uptime, version }`), `*` → 404 JSON. Namespace `POST /api/control/*` reservado em comentário, não registrado.
- [ ] Serve o snapshot **da memória** (nunca relê o arquivo); serialização JSON memoizada por versão; `ETag` = `version()` → poll sem mudança responde `304` com corpo vazio.
- [ ] Headers: `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`.
- [ ] `EADDRINUSE` nunca derruba o pipeline: aviso no log e execução segue sem servidor (com teste).
- [ ] `server.unref()`; fechamento explícito em `finally` e em `SIGINT`/`SIGTERM`; o processo encerra sem travar ao fim do pipeline (com teste).
- [ ] Host default `127.0.0.1`; ao receber `0.0.0.0`, imprime aviso explícito de exposição à rede local; na subida, imprime a URL de acesso em destaque.

### US-007 — Interface web (`src/web/public/`)

Como operador, quero abrir uma página no navegador (via Tailscale) e entender imediatamente o estado da execução.

**Critérios de aceitação:**
- [ ] Três arquivos estáticos (`index.html`, `app.css`, `app.js`), JS puro, sem framework, sem CDN, sem qualquer recurso externo — funciona offline.
- [ ] Seções: cabeçalho (issue com link, branch, badge de status, tempo decorrido em tempo real, estimativa restante rotulada como estimativa); progresso global (`<progress>` nativo, percentual, contadores); "executando agora" (fase, story, ferramenta, detalhe, há quanto tempo); fases (status, duração, erro); user stories; commits e PRs (links); logs recentes com filtro por nível; erros e avisos em destaque no topo quando existirem; próximos passos.
- [ ] Seletor de intervalo de polling (3s/5s/10s/30s/pausar) persistido em `localStorage`, default vindo da configuração do servidor.
- [ ] Polling suspenso quando `document.hidden`; backoff progressivo e banner "desconectado" em falha de fetch.
- [ ] Tema claro/escuro via `prefers-color-scheme`; `aria-live="polite"` nos blocos dinâmicos; título da aba refletindo o progresso.

### US-008 — Empacotamento e resolução de assets

Como usuário do pacote publicado no npm, quero que a interface web funcione tanto em desenvolvimento (`src/`) quanto no pacote instalado (`dist/`).

**Critérios de aceitação:**
- [ ] `getPromptsDir()` generalizado em `resolvePackageDir(name)` (`src/core/prompt-resolver.ts`), reaproveitado por `prompts/` e `web/`; assets lidos uma vez na inicialização.
- [ ] `"web"` incluído em `files` no `package.json`; `npm pack --dry-run` inclui `web/`.
- [ ] Teste que resolve o diretório `web/` a partir de `dist/`.

### US-009 — Garantia de impacto zero e qualidade

Como mantenedor, quero garantir que o modo desligado é indistinguível do comportamento atual e que a suíte permanece verde.

**Critérios de aceitação:**
- [ ] `issue-flow run 42` (sem flags) não sobe servidor, não cria `session.json` e produz saída de terminal byte a byte idêntica à atual (teste de regressão).
- [ ] Matar o servidor / fechar o navegador durante a execução não afeta o pipeline.
- [ ] Ao término, `issues/N/session.json` contém o estado final.
- [ ] `npm run typecheck`, `npm run lint` e `npm test` passam; nenhuma dependência de runtime nova.

### US-010 — Documentação

Como usuário, quero documentação clara do novo modo.

**Critérios de aceitação:**
- [ ] `README.md` atualizado: seção do comando `run`, tabela de flags/env/config, exemplo de uso com Tailscale (IP `100.x.y.z`) e formato do `session.json`.
- [ ] Orientação para adicionar `issues/*/session.json` ao `.gitignore` do projeto consumidor, quando aplicável.

## Technical Approach

Três camadas novas com dependência estritamente unidirecional:

```
execução (engine, commands, logger, headless)
        │  emite eventos  (fire-and-forget, no-op se desligado)
        ▼
core/session-state.ts   ← reducer + snapshot em memória + escrita atômica throttled
        │  lê snapshot   (nunca escreve)
        ▼
web/server.ts  →  GET /api/status  →  web/public/{index.html, app.css, app.js}
```

- **Publicação por eventos, não mutação direta**: a união `SessionEvent` + reducer puro permite que um futuro comando remoto entre como mais um produtor de eventos. `NullPublisher` como default segue o idioma de `core/verbose.ts` (estado global com getter/setter).
- **Persistência**: reaproveita o padrão atômico de `state-manager.ts` (`mkdtemp` + `rename`, fallback `EXDEV`), com throttle de 1s e flush em eventos terminais. O endpoint serve da memória, eliminando a classe de leitura de JSON truncado.
- **Instrumentação na origem** (~12 pontos: `logger.emit`, `run.ts`, `engine.ts`, `headless.ts`, `git.ts`), evitando deliberadamente os slots globais de callback ocupados pela `listr2` (causa do bug da issue #17) — `pipeline-renderer.ts` intocado.
- **Servidor**: `node:http` puro (~120 linhas), `unref()`, ETag/304, serialização memoizada, tolerante a `EADDRINUSE`.
- **Frontend**: JS puro com uma função `render(state)` aplicando o snapshot no DOM — divergência deliberada da referência CNPJ Pipeline (que usa Alpine.js via CDN), pois a página roda em rede privada possivelmente sem internet.
- **Ordem de implementação** (plano da issue): (1) session-state + testes → (2) schemas Zod → (3) config → (4) flags CLI → (5) logger → (6) run.ts → (7) engine/headless → (8) git utils → (9) resolvePackageDir + files → (10) server → (11) frontend → (12) testes integrados → (13) documentação. As stories US-001…US-010 seguem essa ordem topológica.

### Alternativas rejeitadas (registradas na issue)

Express/Fastify + WebSockets (dependências pesadas, polling basta); apenas `session.json` servido externamente (exige segundo processo); Alpine.js via CDN (rede sem internet); derivar estado de `tasks.json` + `progress.txt` sob demanda (não cobre dados só em memória, acopla o servidor a formatos internos); HTML como template string em TS (perde lint/diff/highlight).

### Riscos e mitigações principais

| Risco | Mitigação |
|---|---|
| Porta ocupada derrubar o pipeline | `EADDRINUSE` capturado; aviso e execução segue (com teste) |
| `--host 0.0.0.0` expor além do tailnet | Default `127.0.0.1`; aviso explícito; README recomenda IP `100.x.y.z` |
| Colisão com callbacks da `listr2` | Instrumentação na origem; teste de regressão do terminal |
| Falha de I/O do publisher interromper execução | `try/catch` total; aviso único; nunca propaga |
| Crescimento de memória em execuções longas | Ring buffer limitado; snapshot pequeno por construção |
| Servidor manter processo vivo em CI | `unref()` + `close()` em `finally`/sinais (com teste) |
| Assets ausentes no pacote publicado | `"web"` em `files`; teste em `dist/`; `npm pack --dry-run` |
| Estimativa de tempo enganosa | `null` com < 2 amostras; rotulada como estimativa na UI |
| Vazamento de conteúdo sensível no endpoint sem auth | Documentado; `--web-no-logs`; default `127.0.0.1` |

## Out of Scope

- **Controle remoto** (parar, pausar, reexecutar stories, instruir o agente) — apenas o terreno é preparado: `readOnly`/`capabilities` no payload, namespace `POST /api/control/*` reservado em comentário, estado por issue.
- **Autenticação** no endpoint — a segurança depende do isolamento de rede (Tailscale/localhost), conforme escopo definido na issue.
- **WebSockets / SSE / push** — o requisito é polling; a camada de eventos fica pronta para essas superfícies no futuro.
- **Webhooks / notificações** — o `notifier` da referência CNPJ Pipeline não é replicado nesta versão.
- **Modo multi-sessão** — `GET /api/sessions` retorna lista com um elemento; varredura de `issues/*/session.json` fica para depois sem mudança de formato/rotas.
- **Alterações em `src/ui/pipeline-renderer.ts`** — a UI do terminal permanece intacta por decisão explícita.
- **Frameworks HTTP ou de frontend** e qualquer dependência de runtime nova.

## Dependencies

- **Node.js ≥ 22** (engine já exigida pelo pacote) — `node:http`, `node:fs` da biblioteca padrão.
- **Dependências de runtime existentes** (chalk, commander, execa, listr2, ora, zod) — nenhuma adição; Zod valida os novos schemas, commander registra as novas flags.
- **`git` e `gh` CLI** já usados pelo projeto — necessários para `getCommitsSince`/`getBaseBranch` e enriquecimento de PRs (`gh pr list`).
- **Infraestrutura interna pré-existente** (prerequisitos já satisfeitos): escrita atômica de `state-manager.ts`, resolução de assets de `prompt-resolver.ts`, choke point `emit()` de `logger.ts`, parse de `tool_use` em `headless.ts`, `PIPELINE_PHASES` em `pipeline.ts`.
- **Issues relacionadas**: #15 (UI do terminal com `listr2` — não alterar), #17 (bug de saída duplicada — evitar os slots globais de callback), #20 (`--no-branch` — refletir `noBranch` no snapshot e em `nextSteps`).
- **Rede Tailscale** para o caso de uso remoto (dependência operacional do usuário, não do código).
