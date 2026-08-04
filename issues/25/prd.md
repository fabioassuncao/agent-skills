# PRD: [Architecture] Nova fase pr-review para revisão de Pull Request na pipeline

> Issue: [#25](https://github.com/fabioassuncao/issue-flow/issues/25) — `enhancement`, `architecture`, `medium`, `backend`

## Context

Hoje o ciclo do Issue Flow termina na criação do Pull Request. A fase `review`
(`packages/issue-flow/src/commands/review.ts` + `prompts/review.md`) responde a uma pergunta
específica — *"a implementação atende aos critérios de aceite do PRD/tasks.json?"* — e alimenta o
laço de auto-correção em `run.ts:268-309`. É um gate de **conformidade com o requisito**, executado
**antes** do PR existir.

Falta a pergunta complementar, que qualquer revisor humano faria antes do merge: *"este Pull
Request, como um todo, deve entrar no repositório?"*. Isso envolve o diff completo, arquitetura
resultante, duplicação entre stories, legibilidade, regressões fora do escopo, cobertura de testes,
qualidade das mensagens de commit e a própria descrição do PR. Nada disso é avaliado: o PR é criado
(`commands/pr.ts`), a issue é fechada automaticamente pelo provider (`run.ts:357-365`) e a pipeline
termina.

O diagnóstico do código atual confirma três lacunas concretas:

1. **O número do PR criado é descartado.** `pr.ts:98-107` extrai a URL com `parsePrUrl()`, imprime
   no terminal e persiste apenas `plan.pipeline.prCreated = true`. Nenhuma fase posterior sabe qual
   PR foi criado.
2. **`run.ts:370-384` monta um comando quebrado** — `gh pr list --head '' --json url --limit 1`.
   Com `--head` vazio o filtro por branch não é aplicado, e a URL exibida no resumo final pode ser
   de qualquer PR aberto do repositório. `listPullRequests()` (`core/session-git.ts:35-68`) já faz
   isso corretamente.
3. **Não há campo de estado nem artefato** para revisão de PR em `tasks.json` ou em `issues/N/`, e
   nenhuma estrutura que suporte múltiplas rodadas.

O mecanismo de extensão já existe e está validado: `PipelineManager` opera sobre `activePhases`
injetado no construtor (`core/pipeline.ts:36-40`), e `PIPELINE_PHASES_NO_BRANCH` (issue #20) já
provou que remover/variar fases funciona sem tocar no resto. `run.ts` monta `runners` (linhas
252-311) e instrumenta cada um com `phase:start`/`phase:end` + `publishGitState()` (linhas 317-339),
de modo que adicionar uma fase é adicionar uma entrada em três mapas e um runner.

Esta mudança fecha o ciclo de qualidade e, principalmente, cria a base arquitetural (porta
`PrReviewPublisher` + `findings` estruturados) para que a futura integração com o review do GitHub
seja a adição de um adaptador, não uma reescrita.

## Goals

1. A fase **`pr-review`** existe como etapa final e **opcional** da pipeline, imediatamente após
   `pr`, ativada por `issue-flow run <N> --pr-review`.
2. O comando **`issue-flow pr-review [pr]`** é utilizável isoladamente, inclusive em PRs que nunca
   passaram pela pipeline.
3. **Zero impacto** em quem não usar a flag: sem `--pr-review`, `activePhases`, `phaseOrder`,
   `runners`, saída de terminal, códigos de retorno e o conteúdo de `tasks.json` permanecem
   idênticos aos atuais — garantido por teste em `run.test.ts`.
4. O PR é descoberto automaticamente por uma ordem de precedência determinística, com confirmação
   apenas em TTY interativo e nunca no fluxo autônomo.
5. O resultado é persistido em artefatos versionáveis (`issues/<N>/pr-review/pr-<N>-round-<k>.md` +
   `index.json`), com suporte a múltiplas rodadas aditivas.
6. O estado da fase é representado em `tasks.json` de forma **retrocompatível**: todo `tasks.json`
   escrito por versões anteriores continua carregando sem erro de validação Zod.
7. Códigos de saída distinguem falha de execução (`1`) de veredito negativo (`2`), tornando a fase
   scriptável em CI.
8. A arquitetura fica preparada para publicação futura no GitHub via porta/adaptador, **sem
   implementar nada disso agora**.
9. Paridade mantida entre CLI, prompts, skills (`skills/review-pr/`) e documentação, como fizeram
   `create-pr` e `review-issue`.

## User Stories

### US-001 — Conjunto de fases da pipeline com `pr-review`

**Como** mantenedor do Issue Flow
**Quero** que `pr-review` seja uma fase declarada, mas fora do conjunto padrão
**Para** ativá-la explicitamente sem alterar o comportamento de retomada de quem não a usa.

Arquivo: `packages/issue-flow/src/core/pipeline.ts`

**Critérios de aceite**

- [ ] `PIPELINE_PHASES` permanece **exatamente** `['init','prd','plan','execute','review','pr']`.
- [ ] Existe `PIPELINE_PHASES_WITH_PR_REVIEW = [...PIPELINE_PHASES, 'pr-review'] as const`.
- [ ] `PipelinePhase` passa a ser derivado de `PIPELINE_PHASES_WITH_PR_REVIEW`.
- [ ] `PHASE_TO_FIELD` ganha `'pr-review': 'prReviewCompleted'`.
- [ ] `PIPELINE_PHASES_NO_BRANCH` continua excluindo `pr` e **não** contém `pr-review` (o
      predicado de tipo é ajustado para `Exclude<PipelinePhase, 'pr' | 'pr-review'>`).
- [ ] `PipelineManager` não é modificado — continua operando sobre `activePhases` injetado.
- [ ] Teste em `pipeline.test.ts`: com `PIPELINE_PHASES` (default) e todas as fases completas,
      `getNextPhase()` retorna `null` mesmo com `prReviewCompleted` ausente ou `false`.
- [ ] Teste em `pipeline.test.ts`: com `PIPELINE_PHASES_WITH_PR_REVIEW` e `prReviewCompleted:
      false`, `getNextPhase()` retorna `'pr-review'` e `canResume('pr-review')` é `true`.
- [ ] `npm run typecheck` verde — todo `Record<PipelinePhase, …>` afetado pela união ampliada é
      revisitado.

---

### US-002 — Estado retrocompatível em `tasks.json`

**Como** usuário com pipelines já executados no disco
**Quero** que os campos novos sejam opcionais
**Para** que nenhum `tasks.json` existente seja invalidado pelo Zod.

Arquivos: `src/types.ts`, `src/schemas.ts`, `src/core/state-manager.ts`

**Critérios de aceite**

- [ ] `PipelineState` ganha `prReviewCompleted?: boolean` (opcional, no padrão de
      `analyzeCompleted?`).
- [ ] `TaskPlan` ganha `pullRequest?: { number, url, headBranch, createdAt }` e
      `prReview?: { enabled, pullRequestNumber?, rounds, lastRecommendation?, lastReviewedAt? }`.
- [ ] `pipelineStateSchema` e `taskPlanSchema` refletem os campos com `.optional()`;
      `lastRecommendation` é `z.enum(['APPROVE','APPROVE_WITH_SUGGESTIONS','REQUEST_CHANGES'])`.
- [ ] `initializeState()` **preserva** os campos quando presentes e **não os introduz** quando
      ausentes — um `tasks.json` gerado sem a flag continua sendo escrito sem os campos novos.
- [ ] Teste em `state-manager.test.ts`: `loadTaskPlan()` de um `tasks.json` sem nenhum dos campos
      novos carrega sem erro; um round-trip `load → save` não adiciona chaves.
- [ ] Teste: um `tasks.json` **com** os três campos novos carrega, valida e sobrevive ao
      round-trip sem perda.

---

### US-003 — A fase `pr` persiste o Pull Request criado

**Como** fase posterior da pipeline
**Quero** ler o PR criado a partir de `tasks.json`
**Para** não precisar consultar o GitHub de novo.

Arquivo: `src/commands/pr.ts`

**Critérios de aceite**

- [ ] Após `parsePrUrl()` retornar uma URL, `pr.ts` persiste
      `plan.pullRequest = { number, url, headBranch, createdAt }` no mesmo bloco que já grava
      `prCreated = true`.
- [ ] `number` é extraído da URL (`/pull/(\d+)`); `headBranch` vem da branch já resolvida na
      função; `createdAt` usa `isoNow()`.
- [ ] Quando `parsePrUrl()` retorna `null`, o comportamento atual é preservado: `prCreated = true`,
      nenhum `pullRequest` gravado, mensagem `PR creation completed`, código de saída `0`.
- [ ] Falha ao carregar/salvar `tasks.json` continua sendo silenciosa (o `catch` existente).
- [ ] Teste cobrindo: URL válida → campo persistido com número correto; saída sem URL → campo
      ausente.

---

### US-004 — Descoberta automática do Pull Request

**Como** usuário que roda `issue-flow pr-review` sem argumento
**Quero** que o PR seja descoberto em uma ordem previsível
**Para** não precisar informar o número no caso comum, e nunca revisar um PR "chutado".

Arquivo novo: `src/core/pr-review/discovery.ts` (+ `discovery.test.ts`)

**Critérios de aceite**

- [ ] `resolvePullRequest()` implementa, nesta ordem: (1) argumento explícito; (2)
      `snapshot.pullRequests[]` do publisher ativo; (3) `plan.pullRequest` de
      `issues/<N>/tasks.json`; (4) `listPullRequests(await getCurrentBranch())` — PR mais recente;
      (5) falha explícita.
- [ ] As fontes são injetáveis por parâmetro, no padrão de `GitStateSources`
      (`session-git.ts:23-29`), permitindo testes sem rede.
- [ ] Quando o PR vem das fontes 2–4 **e** `process.stdin.isTTY && process.stdout.isTTY`, exibe o
      número, o título e a branch e pede confirmação `(Y/n)` antes de revisar.
- [ ] Em não-TTY, com `CI` definido, com `--yes` ou quando chamado a partir do `run`, a confirmação
      é pulada e o número descoberto é registrado no log.
- [ ] Nenhum PR encontrado → erro acionável instruindo `issue-flow pr-review <número>`; a função
      nunca retorna um PR arbitrário.
- [ ] Testes por fonte (2, 3, 4), para ausência total de PR e para o caso "usuário respondeu `n`".

---

### US-005 — Parser, relatório e índice estruturado

**Como** consumidor futuro dos resultados (GitHub publisher, automações)
**Quero** o veredito em forma estruturada além do Markdown
**Para** que a integração seja mecânica em vez de um reparse de Markdown.

Arquivos novos: `src/core/pr-review/report.ts` (+ `report.test.ts`),
`src/core/pr-review/publisher.ts`

**Critérios de aceite**

- [ ] `parsePrReviewResult()` lê o bloco `<pr-review-result>` com `RECOMMENDATION:` e `BLOCKERS:`,
      sendo tolerante no espírito de `parseReviewResult()` (`review.ts:18-43`): sem o bloco, tenta
      detectar `RECOMMENDATION:` no texto cru.
- [ ] Saída malformada ou recomendação desconhecida **não** vira `APPROVE` por omissão: resulta em
      falha de parse (exit `1`), com a saída bruta preservada no relatório.
- [ ] O relatório `pr-<N>-round-<k>.md` contém todas as seções exigidas: resumo executivo, pontos
      positivos, problemas encontrados, sugestões de melhoria, observações arquiteturais, riscos
      identificados, itens obrigatórios antes do merge e recomendação final.
- [ ] `index.json` segue o formato `{ schemaVersion: 1, pullRequest, rounds: [{ round, at,
      recommendation, headSha, reportPath, findings: [{ severity, file, line, title }] }] }`.
- [ ] Escrita atômica via `writeFileAtomic()` (`utils/fs.ts`), o mesmo mecanismo de `saveTaskPlan`.
- [ ] Rodadas são **aditivas**: escrever a rodada N+1 nunca sobrescreve relatórios anteriores nem
      remove entradas de `index.json`. `--round <n>` reescreve uma rodada específica.
- [ ] Diretório de artefatos: `issues/<N>/pr-review/` quando há issue associada;
      `issues/pr-<N>/pr-review/` quando não há.
- [ ] `publisher.ts` define `interface PrReviewPublisher { publish(report): Promise<void> }` e
      `LocalReportPublisher` (escreve `.md` + `index.json`); nenhuma chamada de escrita ao GitHub.
- [ ] Testes de parse para os três vereditos, para saída malformada e para a numeração de rodadas.

---

### US-006 — Prompt `pr-review.md`

**Como** operador da fase
**Quero** um template que cubra todos os eixos de análise e force um formato de saída
**Para** que o veredito seja parseável e a revisão, abrangente.

Arquivo novo: `packages/issue-flow/prompts/pr-review.md`

**Critérios de aceite**

- [ ] Placeholders suportados: `__PR_NUMBER__`, `__ISSUE_NUMBER__`, `__TASKS_PATH__`,
      `__PRD_PATH__`, `__REPORT_PATH__`, `__ROUND__`.
- [ ] Instrui a coletar contexto via `gh pr view`, `gh pr diff`, `git log`, PRD/`tasks.json`,
      `CLAUDE.md`/`README`.
- [ ] Cobre: descrição do PR, relação issue ↔ PRD ↔ implementação, diff completo, qualidade de
      código, arquitetura, complexidade, legibilidade, duplicação, aderência aos padrões do
      projeto, regressões, riscos, cobertura de testes, documentação, mensagens de commit e
      oportunidades de simplificação.
- [ ] Contra estouro de contexto: instrui a começar por `gh pr diff --name-only` e `--stat` e
      priorizar arquivos de maior impacto; em PRs muito grandes, produzir relatório com **escopo
      declarado** em vez de falhar.
- [ ] Define critérios explícitos por veredito (o que caracteriza `APPROVE`,
      `APPROVE_WITH_SUGGESTIONS` e `REQUEST_CHANGES`) para reduzir não-determinismo.
- [ ] Exige, ao final, o bloco:
      `<pr-review-result>` / `RECOMMENDATION: …` / `BLOCKERS:` / `</pr-review-result>`.

---

### US-007 — Comando `issue-flow pr-review [pr]`

**Como** desenvolvedor
**Quero** rodar a revisão de um PR isoladamente
**Para** usar o Issue Flow como ferramenta de code review assistido, com ou sem issue associada.

Arquivo novo: `src/commands/pr-review.ts`

**Critérios de aceite**

- [ ] `runPrReview(prArg?: string, opts): Promise<number>` segue os cinco passos de `review.ts`:
      resolver alvo → `loadPrompt('pr-review')` + `applyPlaceholders()` → `runHeadless()` → parse
      determinístico → persistência de estado.
- [ ] `runHeadless` é chamado com `maxTurns: 40`, `timeout: getGlobalTimeout() ?? 900_000`,
      `outputFormat: 'text'` e `allowedTools: ['Bash','Read','Glob','Grep']` — a fase é read-only
      por construção.
- [ ] `--timeout` global continua sobrescrevendo o timeout.
- [ ] Códigos de saída: `0` para `APPROVE`/`APPROVE_WITH_SUGGESTIONS`; `2` para
      `REQUEST_CHANGES`; `1` para falha de execução (headless, `gh`, PR não encontrado, parse).
- [ ] `--fail-on <level>` aceita `request-changes` (padrão), `suggestions` e `none`; `none` força
      `0` mesmo em `REQUEST_CHANGES`.
- [ ] Quando há issue associada, `plan.pipeline.prReviewCompleted` vira `true` apenas em
      `APPROVE`/`APPROVE_WITH_SUGGESTIONS`; em `REQUEST_CHANGES` permanece `false`.
- [ ] `plan.prReview` é atualizado com `pullRequestNumber`, `rounds`, `lastRecommendation` e
      `lastReviewedAt`; nenhum outro campo de `pipeline` é alterado.
- [ ] A resolução da issue é **best-effort**: revisar um PR sem issue associada não falha.
- [ ] O comando depende apenas da interface `PrReviewPublisher`, nunca de `LocalReportPublisher`
      diretamente.

---

### US-008 — Registro na CLI

**Como** usuário da CLI
**Quero** o comando e a flag disponíveis com as opções documentadas
**Para** invocar a fase pelos dois caminhos.

Arquivo: `src/cli.ts` (e `src/cli-options.ts` se necessário)

**Critérios de aceite**

- [ ] `withGlobalOptions(program.command('pr-review'))` com `.argument('[pr]', 'Pull Request
      number')` e as opções `--issue <n>`, `--round <n>`, `--yes`, `--fail-on <level>`.
- [ ] Import dinâmico do módulo da fase (lazy loading), como todos os outros comandos.
- [ ] `run` ganha `--pr-review`; a descrição do comando passa a mencionar a fase opcional.
- [ ] `--pr-review` combinado com `--no-branch` falha com mensagem explicativa ("sem PR não há o
      que revisar") e código `1`, antes de qualquer trabalho.
- [ ] A validação da combinação de flags vive em `cli-options.ts` (testável), não em `cli.ts`.

---

### US-009 — Integração com o comando `run`

**Como** usuário de `issue-flow run <N> --pr-review`
**Quero** a fase executada após `pr`, sem confirmação interativa
**Para** obter o relatório ao fim do fluxo autônomo.

Arquivo: `src/commands/run.ts`

**Critérios de aceite**

- [ ] O conjunto ativo é resolvido pela mesma lógica de três vias de `--no-branch`: flag → valor
      persistido (`plan.prReview.enabled`) → default.
- [ ] Existe `RUNNABLE_PHASES_WITH_PR_REVIEW` análogo a `RUNNABLE_PHASES` (`run.ts:39-40`).
- [ ] `plan.prReview.enabled = true` é persistido após a fase `plan`, no mesmo ponto em que
      `noBranch` é persistido (`run.ts:256-265`).
- [ ] O runner `'pr-review'` chama `runPrReview(undefined, { issue: issueNumber, yes: true })`;
      código `1` lança erro (derruba a fase); código `2` **não** derruba a pipeline.
- [ ] Em `REQUEST_CHANGES`: aviso destacado com o caminho do relatório, **supressão do fechamento
      automático da issue** (`run.ts:357-365`), veredito refletido no resumo final e `run`
      retornando `0`.
- [ ] O runner entra no mapa `runners`, herdando `phase:start`/`phase:end`, `publishGitState()` e a
      task `listr2` da instrumentação existente (`run.ts:317-339`).
- [ ] Teste em `run.test.ts`: sem a flag, `activePhases` e `phaseOrder` são idênticos aos atuais e
      o fechamento da issue continua ocorrendo.
- [ ] Teste em `run.test.ts`: com a flag e veredito `REQUEST_CHANGES`, `provider.close()` **não** é
      chamado e o código de retorno é `0`.

---

### US-010 — Correção do `gh pr list --head ''`

**Como** usuário que lê o resumo final do `run`
**Quero** a URL do PR correto
**Para** não ser levado a um PR não relacionado.

Arquivo: `src/commands/run.ts:370-384`

**Critérios de aceite**

- [ ] O bloco `execa('gh', ['pr','list','--head','', …])` é substituído por
      `listPullRequests(branch)` (`core/session-git.ts`), usando a branch atual real.
- [ ] Quando `plan.pullRequest.url` existe, ela é usada preferencialmente, evitando a chamada ao
      `gh`.
- [ ] Sem PR encontrado, o resumo continua exibindo `unknown` — sem exceção propagada.
- [ ] As condições atuais são preservadas: a busca só ocorre quando `!effectiveNoBranch &&
      resolvedIssue.source === 'github'`.

---

### US-011 — Superfícies de UI e monitoramento

**Como** usuário com `--web` ou terminal interativo
**Quero** ver a fase corretamente rotulada e contabilizada
**Para** acompanhar o progresso sem uma etapa "sem nome".

Arquivos: `src/ui/pipeline-renderer.ts`, `src/ui/summary.ts`, `src/commands/run.ts`

**Critérios de aceite**

- [ ] `PHASE_LABELS['pr-review'] = 'PR Review'` (`pipeline-renderer.ts:42-48`).
- [ ] `publishSessionStart()` recebe o conjunto ativo já resolvido (comportamento atual), de modo
      que `pr-review` aparece em `phases[]` do `session.json` e entra no cálculo de
      `progress.phasesTotal` da UI web.
- [ ] O resumo final do `run` exibe a recomendação e o caminho do relatório quando a fase rodou.
- [ ] Sem a flag, a árvore `listr2` e o resumo final são idênticos aos atuais.

---

### US-012 — Configuração `prReview` em `.issue-flow.json`

**Como** mantenedor de projeto
**Quero** configurar o publisher por arquivo
**Para** que a troca futura por um adaptador do GitHub seja de configuração, não de código.

Arquivos: `src/config.ts`, `src/schemas.ts`

**Critérios de aceite**

- [ ] `loadPrReviewConfig()` segue o padrão de `loadWebConfig()` (`config.ts:269-286`), reusando
      `readProjectConfigFile()` e a precedência flag > env > arquivo > default.
- [ ] `prReviewConfigSchema` valida a chave `prReview`; em v1 apenas `publisher: 'local'` é aceito
      (default `'local'`).
- [ ] Valor inválido degrada para o default com `printWarning`, nunca lança.
- [ ] Teste cobrindo: chave ausente, valor válido, valor inválido.

---

### US-013 — Skill `review-pr` e registro no agente

**Como** usuário do Issue Flow via Claude Code
**Quero** a skill correspondente ao comando
**Para** manter a paridade que `create-pr` e `review-issue` estabeleceram.

Arquivos novos: `skills/review-pr/SKILL.md`, `skills/review-pr/README.md`
Arquivos alterados: `agents/resolve-issue.md`, `docs/skills-and-agents.md`

**Critérios de aceite**

- [ ] `SKILL.md` com frontmatter no formato de `skills/create-pr/SKILL.md` (`name`, `description`
      com gatilhos em linguagem natural, `compatibility`).
- [ ] A skill descreve os mesmos eixos de análise do prompt e o mesmo formato de saída.
- [ ] `agents/resolve-issue.md` e a tabela de componentes de `docs/skills-and-agents.md` listam a
      nova skill.

---

### US-014 — Documentação e validação final

**Como** novo usuário
**Quero** a fase documentada de ponta a ponta
**Para** entender quando e como usá-la.

Arquivos: `README.md`, `docs/skills-and-agents.md`

**Critérios de aceite**

- [ ] `README.md` documenta: o comando `pr-review` e suas opções, a flag `--pr-review` do `run`, a
      ordem de descoberta do PR, o layout dos artefatos, os códigos de saída, os campos novos de
      `tasks.json` e a chave `prReview` de `.issue-flow.json`.
- [ ] O diagrama/descrição da pipeline passa a mostrar
      `init → prd → plan → execute → review → pr → pr-review (opcional)`.
- [ ] `npm run check` (biome + `tsc --noEmit`) e `npm test` verdes em
      `packages/issue-flow/`.
- [ ] Validação manual: `issue-flow pr-review <N>` executado contra um PR real deste repositório,
      produzindo relatório e `index.json`.

## Technical Approach

### Integração com a pipeline

`PIPELINE_PHASES` permanece o conjunto padrão e o novo conjunto é **derivado**, seguindo o
precedente de `PIPELINE_PHASES_NO_BRANCH`:

```ts
export const PIPELINE_PHASES = ['init','prd','plan','execute','review','pr'] as const;
export const PIPELINE_PHASES_WITH_PR_REVIEW = [...PIPELINE_PHASES, 'pr-review'] as const;
export type PipelinePhase = (typeof PIPELINE_PHASES_WITH_PR_REVIEW)[number];
```

**Restrição crítica:** `pr-review` **nunca** entra em `PIPELINE_PHASES`. Se entrasse,
`getNextPhase()` passaria a retornar `'pr-review'` para todo pipeline concluído, quebrando a
retomada automática de quem não usa a fase (`run.ts:211-223`). A ativação é sempre explícita.

`PipelineManager` não muda: já opera sobre `activePhases` injetado no construtor.

### Anatomia do comando

`pr-review.ts` reproduz os cinco passos comuns a `review.ts`/`pr.ts`:

1. resolver o PR alvo (US-004) e o diretório de artefatos;
2. `loadPrompt('pr-review')` + `applyPlaceholders()`;
3. `runHeadless({ maxTurns: 40, timeout: 900_000, allowedTools: ['Bash','Read','Glob','Grep'] })` —
   contexto maior que o de `review` (25/300s) porque o diff completo é o maior insumo da pipeline;
4. parse determinístico do bloco `<pr-review-result>`;
5. escrita dos artefatos via `PrReviewPublisher` e atualização de `plan.pipeline`/`plan.prReview`
   com `loadTaskPlan`/`saveTaskPlan`.

### Retrocompatibilidade do estado

Três campos **opcionais** em `tasks.json`, no padrão já usado por `analyzeCompleted?`
(`types.ts:23`, `schemas.ts:22`):

```jsonc
{
  "pipeline": { "…": true, "prReviewCompleted": false },
  "pullRequest": { "number": 184, "url": "…", "headBranch": "…", "createdAt": "…" },
  "prReview": {
    "enabled": true, "pullRequestNumber": 184, "rounds": 2,
    "lastRecommendation": "APPROVE_WITH_SUGGESTIONS", "lastReviewedAt": "…"
  }
}
```

**Decisão que refina a proposta da issue:** `initializeState()` **preserva** os campos quando
presentes, mas **não os introduz** quando ausentes. Isso mantém o `tasks.json` de quem não usa a
flag byte-a-byte idêntico ao atual, cumprindo o objetivo de impacto zero de forma mais estrita do
que preencher defaults incondicionalmente. O `run.ts` grava `prReview.enabled` apenas quando a flag
é usada.

`prReviewCompleted` vira `true` em `APPROVE` e `APPROVE_WITH_SUGGESTIONS`; em `REQUEST_CHANGES`
permanece `false`, de modo que a retomada re-executa a fase — o comportamento desejado.

### Artefatos

```
issues/42/
  pr-review/
    pr-184-round-1.md      # relatório legível, versionável
    pr-184-round-2.md
    index.json             # índice estruturado das rodadas
```

Os campos `findings[].file/line/severity` e `headSha` existem exatamente para viabilizar
comentários inline no futuro sem reprocessar Markdown. Sem issue associada, os artefatos vão para
`issues/pr-<N>/pr-review/`, mantendo o layout.

### Porta para o GitHub

`PrReviewPublisher` é a única dependência do comando, no mesmo idioma de
`SessionPublisher`/`FilePublisher`/`NullPublisher` (`core/session-state.ts`). Um
`GitHubReviewPublisher` futuro (comentários inline via `gh api`, `gh pr review --approve |
--request-changes`) entra como implementação nova, sem tocar no comando nem no prompt.

### Ordem de implementação

`US-001 → US-002` (fundação de tipos e fases) → `US-003 → US-004` (descoberta do PR) → `US-005 →
US-006 → US-007` (núcleo da fase) → `US-008 → US-009 → US-010` (integração) → `US-011 → US-012`
(superfícies) → `US-013 → US-014` (paridade e docs).

### Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Quebrar a retomada automática | Nunca adicionar a fase a `PIPELINE_PHASES`; teste explícito de `getNextPhase() === null` |
| `tasks.json` existentes invalidados | Todos os campos `.optional()`; teste de round-trip sem os campos |
| Diff grande estourando o contexto | Prompt começa por `--name-only`/`--stat`; `maxTurns`/`timeout` maiores; relatório com escopo declarado em vez de falha |
| PR não encontrado (branch sem PR, detached HEAD, fork) | Falha acionável; nunca revisar um PR "chutado" |
| Prompt interativo travando CI | Confirmação só com `stdin.isTTY && stdout.isTTY`; `--yes` e o caminho via `run` sempre não-interativos |
| `REQUEST_CHANGES` lido como falha de execução | Código de saída dedicado (`2`), documentado; `--fail-on none` |
| Não-determinismo do veredito | Critérios explícitos por veredito no prompt; rodadas preservadas como histórico |
| `PipelinePhase` mais amplo quebrando `Record<PipelinePhase, …>` | Erro de compilação, não de runtime; `tsc --noEmit` no CI acusa antes do merge |

## Out of Scope

- **Publicação no GitHub na v1** — nenhum comentário inline, `gh pr review --approve` ou
  `--request-changes`. Apenas a porta `PrReviewPublisher` e o `LocalReportPublisher`. Exige tratar
  permissões de token, idempotência de comentários, âncoras de linha em diffs que mudam e limites
  de rate.
- **Re-execução automática da pipeline após `REQUEST_CHANGES`.** O `headSha` por rodada no
  `index.json` é o que tornará isso possível depois (comparar `headSha` para saber se o PR mudou).
- **Realimentar o laço de auto-correção** de `review` (`run.ts:268-309`) com o veredito de
  `pr-review` — as semânticas são distintas e o acoplamento seria indevido.
- **Estender a fase `review` existente** com critérios de code review. `review` roda antes do PR
  existir, alimenta o laço de auto-correção e não permite revisar um PR arbitrário sem issue.
- **Tornar a fase obrigatória.** Alteraria custo (tokens/tempo) e comportamento de todos os
  usuários atuais; o precedente do projeto é o opt-in (`--web`, issue #22).
- **Delegar ao `/code-review` do Claude Code** — comando interativo, não invocável do modo headless
  e sem artefatos no formato `issues/N/`.
- **Interromper a pipeline em `REQUEST_CHANGES`.** Na v1 o `run` continua e retorna `0`; apenas o
  fechamento automático da issue é suprimido.
- **Suporte a `pr-review` em modo `--no-branch`.** Sem PR não há o que revisar; a combinação é
  rejeitada.
- **Publishers além de `local`.** A chave de configuração existe, mas só `'local'` é aceito.

## Dependencies

**Externas (já exigidas pelo projeto)**

- `gh` CLI autenticado, com acesso ao repositório do PR — usado por `gh pr view`, `gh pr diff` e
  `listPullRequests()`. `init.ts` já valida a presença de `gh` quando o provider preferido é
  `github`.
- `git` e `claude` (Claude Code Headless) — já validados por `validateDependencies()`
  (`config.ts:97-115`).
- Node.js >= 22 (`package.json:engines`).

**Internas (código existente reaproveitado)**

| Necessidade | Existente | Arquivo |
|---|---|---|
| Descobrir PRs de uma branch | `listPullRequests(branch)` | `src/core/session-git.ts:35-68` |
| Branch atual / base / commits | `getCurrentBranch()`, `getBaseBranch()`, `getCommitsSince()` | `src/utils/git.ts` |
| PR criado na sessão atual | `snapshot.pullRequests[]` | `src/core/session-state.ts` |
| Persistência validada e atômica | `loadTaskPlan`/`saveTaskPlan` + `writeFileAtomic` | `src/core/state-manager.ts`, `src/utils/fs.ts` |
| Config em camadas | `loadWebConfig()` / `readProjectConfigFile()` | `src/config.ts:132-286` |
| Padrão de porta plugável | `SessionPublisher` / `FilePublisher` / `NullPublisher` | `src/core/session-state.ts` |
| Execução headless | `runHeadless()` | `src/core/headless.ts` |
| Prompt + placeholders | `loadPrompt()`, `applyPlaceholders()` | `src/core/prompt-resolver.ts` |
| Resolução de issue (best-effort) | `resolveCommandIssue()`, `issuePlaceholders()` | `src/issues/context.ts` |

**Pré-requisitos de sequência**

- US-002 depende de US-001 (o tipo `PipelinePhase` precisa existir antes do mapa de campos).
- US-004 depende de US-003 (a fonte 3 lê `plan.pullRequest`).
- US-007 depende de US-004, US-005 e US-006.
- US-009 depende de US-007 e US-008.

**Relação com outras issues**

- **#23** (Issue Providers, já implementada e merged em `9e88e7d`) — o código atual já expõe
  `resolveCommandIssue`/`getProvider`. Um `GitHubReviewPublisher` futuro deve nascer sobre a
  abstração de provider (`createReview`, `createReviewComment`) em vez de chamar `gh` diretamente.
- **#22** (monitoramento web, fechada) — precedente de opt-in que não altera o padrão; a fase nova
  precisa aparecer no snapshot de sessão introduzido por ela.
- **#20** (`--no-branch`, fechada) — precedente do mecanismo de conjunto de fases variável
  reaproveitado aqui.
- **#6** (skill `create-pr`, fechada) — define a convenção de paridade CLI ↔ skill que
  `review-pr` deve seguir.
