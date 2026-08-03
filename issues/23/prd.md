# PRD: [Architecture] Abstrair origem das Issues com Issue Providers (GitHub e local)

## Context

Hoje o Issue Flow assume, em toda a sua extensão, que **uma Issue é um objeto do GitHub**. Essa premissa não está isolada em um módulo — está espalhada por três camadas:

1. **TypeScript** — `packages/issue-flow/src/commands/run.ts:329` chama `gh issue close` e `gh pr list` (`run.ts:338`) diretamente; `runInit` (`packages/issue-flow/src/commands/init.ts:105`) trata `gh` autenticado como pré-requisito bloqueante.
2. **Prompts** — o acoplamento mais forte e menos visível. `prompts/analyze.md`, `prompts/prd.md`, `prompts/review.md` e `prompts/pr.md` começam com `gh issue view __ISSUE_NUMBER__ --json ...`, e `prompts/plan.md` manda derivar `issueUrl` de `gh issue view N --json url`. **A recuperação da Issue não acontece no código — acontece dentro do agente.**
3. **Dados** — `taskPlanSchema` (`packages/issue-flow/src/schemas.ts:34`) exige `issueNumber: number().int().positive()` e `issueUrl: string()` obrigatórios, o que só faz sentido para origem remota.

Em contrapartida, tudo que fica **depois** da recuperação já é agnóstico à origem: `resolvePaths` (`packages/issue-flow/src/config.ts:45`) só conhece `issues/<N>/`, o `PipelineManager` só conhece o objeto `pipeline` do `tasks.json`, e o `runEngine` só conhece `tasks.json` + `progress.txt` + `branchName`. **A fronteira arquitetural já existe de fato — ela só não está declarada.**

Consequências práticas do estado atual:

- Não é possível usar o Issue Flow offline, em repositório sem remote GitHub, ou onde o usuário não pode abrir issues.
- Não é possível planejar uma demanda antes de expô-la publicamente.
- Cada fase paga um round-trip `gh issue view` dentro do agente, com o conteúdo da Issue variando entre fases conforme o agente decide o que buscar — dado não determinístico e não testável.
- Adicionar GitLab, Jira ou Linear exigiria reescrever os cinco templates de prompt e as chamadas `gh` do `run.ts`.

Esta mudança declara a fronteira: introduz uma camada de **Issue Providers**, transforma "Issue" em abstração própria do sistema, e faz `run`, `analyze`, `prd`, `plan`, `execute`, `review` e `pr` operarem sobre uma representação única. **O suporte a Issues locais é a primeira consequência dessa arquitetura, não o objetivo dela.**

## Goals

- Existe um modelo único `Issue`, independente de origem, consumido por todo o pipeline.
- Existe `IssueProvider` com duas implementações registradas: `GitHubIssueProvider` e `LocalFileIssueProvider`.
- Nenhum comando em `src/commands/` referencia `gh issue view/create/close` diretamente; nenhum template em `prompts/` contém `gh issue view`.
- Adicionar um novo provider não exige alterar nenhum comando nem nenhum prompt — provado por um `MemoryIssueProvider` de teste que roda o pipeline sem tocar em comando ou template.
- `generate` seleciona destino (`--github`, `--local`, `--both`) sem duplicação de comandos.
- Issues locais vivem em `issues/<N>/issue.md` + `issues/<N>/metadata.json`, na mesma estrutura dos artefatos existentes.
- Quando local e remota coexistem, o sistema compara conteúdo por hash e resolve o conflito de forma explícita e configurável.
- **Compatibilidade total:** quem usa apenas GitHub roda exatamente os mesmos comandos, com o mesmo comportamento, sem nenhuma flag nova e sem nenhum arquivo de configuração.
- A arquitetura suporta sincronização bidirecional futura sem mudança de formato (campos `remote.ref`, `syncedAt`, `syncedContentHash` já previstos).

## User Stories

As histórias estão ordenadas por dependência. US-001 a US-007 são **puramente aditivas** — não alteram nenhum comportamento observável. US-008 a US-012 fazem a migração. US-013 a US-015 fecham documentação e validação.

---

### US-001 — Modelo de domínio `Issue` e hash de conteúdo

**Como** mantenedor do Issue Flow, **quero** um tipo `Issue` independente de origem e uma função pura de hash de conteúdo, **para que** GitHub e local produzam a mesma representação e o mesmo hash para o mesmo conteúdo.

**Critérios de aceitação:**
- `packages/issue-flow/src/issues/types.ts` exporta `IssueSource` (`'github' | 'local'`), `Issue`, `IssueDraft` e `ResolvedIssue`.
- `Issue` contém: `id: string`, `number: number | null`, `title`, `body`, `labels: string[]`, `state: 'open' | 'closed'`, `source`, `remoteRef: string | null`, `createdAt`, `updatedAt`, `contentHash`, `raw?: unknown`.
- `packages/issue-flow/src/issues/hash.ts` exporta `hashIssueContent(title, body)` retornando `sha256:<hex>` via `node:crypto`.
- `hashIssueContent` é determinística: mesma entrada → mesma saída, em qualquer plataforma; normaliza quebras de linha (`\r\n` → `\n`) e espaços em branco nas bordas antes de hashear.
- Testes cobrem determinismo, normalização de CRLF e sensibilidade a mudança de título e de corpo.
- Typecheck passa.

---

### US-002 — Schema de metadados e afrouxamento do `taskPlanSchema`

**Como** usuário com uma demanda local sem contraparte remota, **quero** que `tasks.json` aceite ausência de `issueUrl`, **para que** o pipeline funcione sem origem no GitHub — sem quebrar planos já existentes em disco.

**Critérios de aceitação:**
- `packages/issue-flow/src/schemas.ts` exporta `issueMetadataSchema` validando: `schemaVersion: 1`, `id`, `number: number | null`, `source`, `title`, `labels`, `state`, `createdAt`, `updatedAt`, `contentHash`, e `remote` opcional (`{ provider, ref, syncedAt, syncedContentHash }`).
- Em `taskPlanSchema`, `issueUrl` passa a ser opcional (com default `''`) e `issueNumber` aceita identificadores locais mantendo compatibilidade com números.
- **Somente afrouxamento** — nenhuma restrição nova é introduzida.
- Teste de regressão obrigatório: um `tasks.json` no formato gerado pela versão 0.4.4/0.5.2 (com `issueUrl` e `issueNumber` presentes) carrega sem erro de schema via `loadTaskPlan`.
- Teste: um `tasks.json` sem `issueUrl` carrega sem erro.
- `TaskPlan` em `src/types.ts` é atualizado em conjunto (`issueUrl?: string`).
- Typecheck passa.

---

### US-003 — Interface `IssueProvider` e registry

**Como** mantenedor, **quero** uma interface comum e um registry de providers, **para que** adicionar uma origem seja criar um arquivo e registrar uma linha.

**Critérios de aceitação:**
- `packages/issue-flow/src/issues/provider.ts` exporta a interface `IssueProvider` com `readonly name: IssueSource`, `isAvailable(): Promise<boolean>`, `get(id): Promise<Issue | null>`, `create(draft): Promise<Issue>` e `close?(id): Promise<void>` (opcional).
- Métodos de escrita além de `create` são opcionais — um provider somente-leitura implementa apenas `get`/`isAvailable`.
- `packages/issue-flow/src/issues/registry.ts` mapeia `IssueSource → IssueProvider`, com `getProvider(source)` e `registerProvider(provider)`.
- `getProvider` de uma origem não registrada lança erro com mensagem acionável listando as origens disponíveis.
- Testes cobrem registro, recuperação e erro de origem desconhecida.
- Typecheck passa.

---

### US-004 — `GitHubIssueProvider`

**Como** usuário do GitHub, **quero** que a busca da Issue aconteça em código TypeScript testável, **para que** o conteúdo seja determinístico e igual em todas as fases.

**Critérios de aceitação:**
- `packages/issue-flow/src/issues/providers/github.ts` implementa `IssueProvider` com `name = 'github'`.
- `get(id)` executa `gh issue view <id> --json number,title,body,labels,state,url,createdAt,updatedAt` via `execa` (padrão de `src/utils/shell.ts`) e mapeia o resultado para `Issue`, com `remoteRef` = URL e `contentHash` calculado por `hashIssueContent`.
- `get` retorna `null` quando a issue não existe (exit code diferente de zero com mensagem de "not found"), e lança apenas em falhas reais (rede, autenticação).
- `state` do GitHub (`OPEN`/`CLOSED`) é normalizado para `'open'`/`'closed'`.
- `create(draft)` executa `gh issue create --title ... --body ...` (com `--label` por label) e retorna a `Issue` criada.
- `close(id)` executa `gh issue close <id>`.
- `isAvailable()` verifica `gh --version` e `gh auth status`, reaproveitando a lógica de `checkGh` em `src/commands/init.ts:34`.
- Testes com `execa` mockado cobrem: sucesso de `get`, issue inexistente, `gh` ausente, `create` e `close`.
- Typecheck passa.

---

### US-005 — `LocalFileIssueProvider`

**Como** usuário sem acesso ao GitHub (offline, repositório sem remote, demanda ainda privada), **quero** declarar a demanda em arquivos locais, **para que** o pipeline rode sobre ela.

**Critérios de aceitação:**
- `packages/issue-flow/src/issues/providers/local.ts` implementa `IssueProvider` com `name = 'local'`.
- `get(id)` lê `issues/<id>/issue.md` (título no H1, corpo no restante) e `issues/<id>/metadata.json`, valida com `issueMetadataSchema` e retorna a `Issue`; retorna `null` quando o diretório ou `issue.md` não existe.
- Quando `metadata.json` está ausente mas `issue.md` existe, o provider deriva metadados mínimos (id, título do H1, `state: 'open'`, timestamps do arquivo) em vez de falhar.
- Quando `metadata.json` é inválido contra o schema, o erro é explícito e cita o caminho e o campo.
- `create(draft)` escreve `issue.md` + `metadata.json` com escrita atômica (write-to-temp + rename, incluindo fallback `EXDEV`, no padrão de `saveTaskPlan` em `src/core/state-manager.ts:38`).
- `close(id)` atualiza `state: 'closed'` e `updatedAt` no `metadata.json`.
- Alocação de identificador local: consulta o maior número existente em `issues/*/metadata.json` e, quando o GitHub estiver alcançável, também o maior número remoto, alocando acima de ambos. Havendo colisão detectada, a criação é recusada com mensagem sugerindo outro identificador.
- `isAvailable()` retorna `true` sempre que o diretório do projeto for gravável.
- Testes cobrem: leitura completa, `issue.md` sem `metadata.json`, `metadata.json` inválido, criação, fechamento e alocação de ID com colisão.
- Typecheck passa.

---

### US-006 — Configuração de providers em `.issue-flow.json`

**Como** usuário, **quero** declarar provider preferido e política de conflito em arquivo, **para que** o comportamento seja estável entre execuções sem repetir flags.

**Critérios de aceitação:**
- `src/config.ts` passa a ler a chave `issues` do arquivo já existente `.issue-flow.json` (constante `WEB_CONFIG_FILENAME`, `src/config.ts:119`), na mesma mecânica de `loadWebConfig`.
- `issuesConfigSchema` (Zod) valida `defaultGenerateTarget` (`github` | `local` | `both`, default `github`), `preferredProvider` (`github` | `local`, default `github`), `conflictPolicy` (`ask` | `prefer-local` | `prefer-github`, default `ask`) e `requireConfirmation` (boolean, default `true`).
- Precedência implementada e testada: **flag de CLI > `.issue-flow.json` > defaults**.
- Todos os defaults reproduzem o comportamento atual — a ausência do arquivo é indistinguível do estado de hoje.
- Arquivo ausente, JSON inválido ou chave `issues` inválida degradam para os defaults com aviso, sem lançar (mesmo contrato de `loadWebConfig`).
- Testes cobrem as três camadas de precedência e cada modo de degradação.
- Typecheck passa.

---

### US-007 — `IssueResolver` com matriz de cenários

**Como** usuário com Issue local e remota ao mesmo tempo, **quero** que o sistema me informe divergências e aplique uma política explícita, **para que** nenhuma escolha silenciosa aconteça.

**Critérios de aceitação:**
- `packages/issue-flow/src/issues/resolver.ts` exporta `resolveIssue(id, opts): Promise<ResolvedIssue>` — ponto único chamado por todos os comandos.
- Matriz implementada e coberta por teste:

  | Cenário | Comportamento |
  |---|---|
  | Só local | usa a local |
  | Só GitHub | usa a remota — **fluxo atual, inalterado** |
  | Ambas, `contentHash` iguais | informa a equivalência e segue com o preferido, sem prompt |
  | Ambas, `contentHash` diferentes | informa a divergência e aplica `conflictPolicy` |
  | Nenhuma | erro atual preservado (mensagem e exit code) |

- Com `conflictPolicy: 'ask'` **e** `process.stdin.isTTY` verdadeiro, exibe as diferenças e oferece `1 - Local / 2 - GitHub / 3 - Cancelar` via `node:readline`; a opção `3` aborta com exit code diferente de zero.
- Com `conflictPolicy: 'ask'` em ambiente **não-interativo** (CI, headless), aplica `preferredProvider`, emite aviso e **não bloqueia**.
- `prefer-local` e `prefer-github` nunca exibem prompt.
- Testes cobrem os cinco cenários da matriz, mais TTY vs. não-TTY e cada opção do prompt (com `stdin` injetável/mockado).
- Typecheck passa.

---

### US-008 — Migração atômica dos cinco templates de prompt

**Como** agente executando uma fase, **quero** receber a Issue já resolvida no prompt, **para que** eu não gaste turns buscando-a e o conteúdo seja idêntico entre fases.

**Critérios de aceitação:**
- `analyze.md`, `prd.md`, `plan.md`, `review.md` e `pr.md` deixam de instruir `gh issue view` e passam a consumir os placeholders `__ISSUE_TITLE__`, `__ISSUE_BODY__`, `__ISSUE_LABELS__`, `__ISSUE_SOURCE__` e `__ISSUE_URL__`.
- Os cinco templates são migrados **no mesmo bloco de trabalho** — migração parcial produziria análise vazia silenciosa para Issues locais.
- Teste automatizado varre `packages/issue-flow/prompts/*.md` e falha se qualquer arquivo contiver `gh issue view`.
- `plan.md` recebe `__ISSUE_URL__` com a URL real quando a origem é GitHub, e com a referência do arquivo (`issues/<N>/issue.md`) quando a origem é local; as regras do template deixam de mandar derivar a URL via `gh`.
- `pr.md`: quando a Issue é local **sem** `remote.ref`, a referência `Closes #N` é omitida e o corpo do PR cita `issues/<N>/issue.md`.
- `applyPlaceholders` (`src/core/prompt-resolver.ts:60`) é usado sem alteração.

---

### US-009 — Comandos da pipeline consomem `resolveIssue`

**Como** usuário, **quero** que `analyze`, `prd`, `plan`, `review` e `pr` funcionem igual independentemente da origem, **para que** o pipeline seja agnóstico.

**Critérios de aceitação:**
- `runAnalyze`, `runPrd`, `runPlan`, `runReview` e `runPr` chamam `resolveIssue` e injetam os placeholders de US-008.
- Nenhum arquivo em `src/commands/` referencia `gh issue view`, `gh issue create` ou `gh issue close` diretamente (verificável por busca).
- Flags `--local`, `--github`, `--prefer-local`, `--prefer-github` e `--ask` são adicionadas via helper compartilhado em `src/cli.ts` (no padrão de `withGlobalOptions`, `src/cli.ts:25`), sem duplicação por comando.
- As flags sobrepõem `.issue-flow.json`, que sobrepõe os defaults.
- `--local` e `--github` são mutuamente exclusivas; combiná-las falha com mensagem clara.
- Comandos executados sem nenhuma flag nova e sem arquivo de config produzem exatamente o comportamento atual.
- Typecheck passa.

---

### US-010 — `run` resolve uma vez e delega fechamento ao provider

**Como** usuário rodando o pipeline completo, **quero** que a origem seja decidida uma única vez, **para que** eu não seja perguntado cinco vezes nem tenha fases lendo origens diferentes.

**Critérios de aceitação:**
- `runPipeline` (`src/commands/run.ts:30`) resolve a Issue **uma única vez** no início e propaga a decisão a todas as fases.
- `gh issue close` (`src/commands/run.ts:329`) é substituído por `provider.close?.(id)`; quando o provider não implementa `close`, a etapa é pulada silenciosamente sem falhar o pipeline.
- Falha ao fechar continua sendo não-fatal (aviso), como hoje.
- O resumo final continua exibindo Branch / Stories / Duration / PR; a busca de URL do PR via `gh pr list` só ocorre quando a origem resolvida é GitHub e o modo não é `--no-branch`.
- `session.json` continua válido contra `sessionSnapshotSchema`: para identificadores locais não numéricos, `issue.number` é publicado como `null` em vez de `0`.
- Teste cobre: resolução única (o resolver é chamado exatamente uma vez em uma execução de múltiplas fases) e provider sem `close`.
- Typecheck passa.

---

### US-011 — `init` não bloqueia quando a origem é local

**Como** usuário em repositório sem `gh` autenticado, **quero** que `init` aprove o ambiente quando o provider resolvido é local, **para que** eu consiga rodar o pipeline.

**Critérios de aceitação:**
- `runInit` (`src/commands/init.ts:105`) aceita o provider resolvido; quando é `local`, a checagem de `gh` vira **aviso** e não reprova o ambiente.
- `claude` e `git` continuam bloqueantes em qualquer origem.
- Quando a origem é GitHub (default), `init` reprova por ausência de `gh` exatamente como hoje — mensagens e exit code inalterados.
- Testes cobrem ambos os caminhos.
- Typecheck passa.

---

### US-012 — `generate` multi-destino

**Como** usuário, **quero** escolher onde a Issue gerada é criada, **para que** eu possa trabalhar localmente, no GitHub ou em ambos com um só comando.

**Critérios de aceitação:**
- `issue-flow generate --prompt "..."` sem flags usa `defaultGenerateTarget` (default `github`) — **comportamento atual preservado**.
- `--github`, `--local` e `--both` selecionam o destino; combinações inválidas falham com mensagem clara.
- `runGenerate` passa a: (a) resolver os providers de destino, (b) rodar o headless para produzir apenas o **rascunho** (`IssueDraft`: título, corpo, labels), (c) delegar a criação a cada provider.
- `prompts/generate.md` deixa de instruir `gh issue create` e passa a emitir o rascunho em formato estruturado e parseável; `parseIssueUrl` deixa de ser o mecanismo de captura do resultado.
- `--local` cria `issues/<N>/issue.md` e `issues/<N>/metadata.json` válidos contra `issueMetadataSchema`, **sem tocar no GitHub**.
- `--both` cria a Issue no GitHub e o espelho local com `remote.ref` e `syncedContentHash` preenchidos e `syncedAt` gravado.
- Em `--both`, falha na criação remota não deixa artefato local inconsistente: ou ambos são criados, ou o erro é reportado com o estado exato do que foi persistido.
- Typecheck passa.

---

### US-013 — Skill `generate-local-issue`

**Como** usuário do Claude Code, **quero** uma skill especializada em gerar Issues locais, **para que** o fluxo tenha o mesmo suporte das demais skills.

**Critérios de aceitação:**
- `skills/generate-local-issue/SKILL.md` e `skills/generate-local-issue/README.md` existem, seguindo o frontmatter e a estrutura de `skills/generate-issue/`.
- A skill cobre: criação da estrutura de diretórios, escrita de `issue.md` e `metadata.json`, alocação de identificador e verificação de duplicidade contra `issues/*/metadata.json`.
- A skill está listada na tabela de componentes de `docs/skills-and-agents.md`.

---

### US-014 — Prova executável de extensibilidade

**Como** mantenedor, **quero** um teste que registre um provider fictício e rode o pipeline sobre ele, **para que** a promessa de extensibilidade seja verificada e não apenas afirmada.

**Critérios de aceitação:**
- Existe um `MemoryIssueProvider` em teste, registrado no registry.
- O pipeline opera sobre ele **sem alterar nenhum arquivo em `src/commands/` nem nenhum template em `prompts/`**.
- O teste falha se algum comando ou prompt precisar de modificação para acomodar o novo provider.
- Typecheck passa.

---

### US-015 — Documentação e validação final

**Como** usuário, **quero** documentação de providers, flags e formato de metadados, **para que** eu consiga adotar as novidades sem ler o código.

**Critérios de aceitação:**
- `README.md` documenta: a camada de providers, as flags `--local`/`--github`/`--prefer-local`/`--prefer-github`/`--ask`, os destinos de `generate`, o formato de `metadata.json` e a chave `issues` de `.issue-flow.json`.
- `README.md` atualiza as seções *Commands* e *Pipeline State & File Structure* incluindo `issue.md` e `metadata.json`.
- `README.md` registra explicitamente a **política de versionamento de `issues/`** — versionar é desejável para Issues locais, já que a demanda em si passa a viver no diretório.
- `docs/skills-and-agents.md` e `agents/resolve-issue.md` são atualizados.
- `npm run check` e `npm test` passam em `packages/issue-flow`.
- Smoke test end-to-end nos três modos: **GitHub puro sem nenhuma flag e sem `.issue-flow.json`** (regressão obrigatória), local puro (com `--no-branch`, em repositório sem `gh` autenticado) e ambos com divergência.

## Technical Approach

### Nova estrutura de módulos

```text
packages/issue-flow/src/issues/
  types.ts              # Issue, IssueDraft, IssueSource, ResolvedIssue
  hash.ts               # hashIssueContent — pura, compartilhada entre providers
  provider.ts           # interface IssueProvider
  registry.ts           # IssueSource → IssueProvider
  resolver.ts           # resolveIssue — ponto único de entrada dos comandos
  providers/
    github.ts           # encapsula gh issue view/create/close via execa
    local.ts            # issue.md + metadata.json, escrita atômica
```

### Fluxo depois da mudança

```text
comando → resolveIssue(id, opts) → registry → provider.get(id)
                ↓
        Issue (determinística)
                ↓
        applyPlaceholders(template, { __ISSUE_TITLE__, __ISSUE_BODY__, ... })
                ↓
        runHeadless — o agente recebe a Issue, não a busca
```

### Layout de `issues/<N>/`

```text
issues/123/
  issue.md        # NOVO — título em H1 + corpo (fonte da verdade local)
  metadata.json   # NOVO — metadados validados por issueMetadataSchema
  analysis.md     # inalterado
  prd.md          # inalterado
  tasks.json      # inalterado (schema afrouxado)
  progress.txt    # inalterado
  .last-branch    # inalterado
  archive/        # inalterado
```

O bloco `remote` de `metadata.json` (`{ provider, ref, syncedAt, syncedContentHash }`) é o que prepara a sincronização futura: comparando `contentHash` local, `syncedContentHash` e o hash remoto atual, dá para distinguir "só o local mudou", "só o remoto mudou" e "ambos mudaram" — sem nenhuma mudança de formato.

### Decisão sobre o arquivo de configuração

A issue propõe um novo `issue-flow.config.json`. **Este PRD adota a chave `issues` dentro do `.issue-flow.json` já existente** (`WEB_CONFIG_FILENAME`, `src/config.ts:119`), pelos seguintes motivos: o arquivo já existe e já é lido do project root; a mecânica de precedência e degradação com aviso já está implementada e testada em `loadWebConfig`; e dois arquivos de configuração no mesmo projeto seriam ambíguos. A configuração fica assim:

```json
{
  "web": { "...": "..." },
  "issues": {
    "defaultGenerateTarget": "github",
    "preferredProvider": "github",
    "conflictPolicy": "ask",
    "requireConfirmation": true
  }
}
```

Se o mantenedor preferir o nome proposto na issue, a troca é local a `src/config.ts` e não afeta nenhuma outra história.

### Ordem de implementação

US-001 a US-007 são **aditivas** — criam código novo sem alterar comportamento observável, e cada uma é commitável mantendo a suíte verde. US-008 e US-009 formam a migração e devem ser tratadas como um bloco atômico. US-010 a US-012 ajustam os comandos remanescentes. US-013 a US-015 fecham skill, prova de extensibilidade e documentação.

### Riscos e mitigações

| # | Risco | Mitigação |
|---|---|---|
| 1 | Migração parcial dos prompts → artefatos vazios silenciosos para Issues locais | Migrar os cinco templates no mesmo bloco (US-008) + teste que proíbe `gh issue view` em `prompts/*.md` |
| 2 | Afrouxar `taskPlanSchema` invalidar planos em disco | Somente afrouxar, nunca endurecer; teste de regressão com `tasks.json` no formato atual (US-002) |
| 3 | Colisão de numeração local × GitHub em `issues/<N>/` | Alocar acima do maior número local **e** remoto quando alcançável; recusar em colisão (US-005) |
| 4 | Prompt de conflito travar CI/headless | Prompt só com `process.stdin.isTTY`; caso contrário aplica `preferredProvider` com aviso (US-007) |
| 5 | Resolução repetida por fase no `run` | Resolver uma vez no início e propagar (US-010) |
| 6 | `Closes #N` sem contraparte remota | Omitir a referência e citar `issues/<N>/issue.md` (US-008) |
| 7 | Regressão silenciosa no fluxo GitHub (maioria dos usuários) | Smoke test end-to-end obrigatório em modo GitHub puro, sem flags e sem arquivo de config (US-015) |

## Out of Scope

Explicitamente **não** incluídos nesta entrega — a base de metadados é criada agora justamente para que essas evoluções não exijam mudança de formato depois:

- Sincronização bidirecional entre local e GitHub.
- Export local → GitHub e import GitHub → local como comandos dedicados (o espelhamento existe apenas como `generate --both`).
- Versionamento/histórico de Issues.
- Múltiplos providers ativos simultaneamente (além do par local/GitHub resolvido por política).
- Providers adicionais: GitLab, Jira, Linear, Azure DevOps, markdown externo, banco de dados.
- Comentários de Issue como parte do modelo `Issue` (hoje `analyze.md` e `prd.md` pedem `comments` ao `gh`; a decisão de incluí-los no modelo canônico fica para uma iteração posterior, e enquanto isso o campo não é propagado).
- Refatoração de `gh pr create` na fase `pr` para uma abstração de PR Provider — apenas a referência de fechamento é ajustada.
- Substituição de `gh pr list` no resumo de `run` por abstração — permanece condicionada à origem GitHub.
- `GitHubReviewPublisher` da issue #25: quando implementado, deve nascer sobre esta abstração em vez de chamar `gh` diretamente, mas não faz parte desta entrega.

## Dependencies

**Prerequisitos técnicos** — todos já disponíveis no projeto, nenhuma dependência nova de runtime é adicionada:

- `execa@^9.5.2` — invocação de `gh`, já usada em `src/utils/shell.ts` e `src/commands/pr.ts`.
- `zod@^4.3.6` — `issueMetadataSchema` e `issuesConfigSchema`.
- `node:crypto` — `hashIssueContent`.
- `node:readline` — prompt interativo de conflito.
- `vitest@^3.1.1` — cobertura de testes das novas camadas.
- Node.js >= 22 (já exigido em `package.json`).

**Pré-requisitos externos:**

- `gh` CLI instalado e autenticado — continua necessário **apenas** para o provider GitHub.
- `claude` CLI e `git` — continuam bloqueantes em qualquer origem.

**Relações com outras issues:**

- [#10](https://github.com/fabioassuncao/issue-flow/issues/10) — estabeleceu a estrutura de comandos e prompts que esta issue refatora.
- [#20](https://github.com/fabioassuncao/issue-flow/issues/20) — `--no-branch`: precedente de funcionalidade opt-in que preserva 100% do comportamento default, e caminho natural para rodar Issues locais sem PR.
- [#25](https://github.com/fabioassuncao/issue-flow/issues/25) — a fase `pr-review` prevê um `GitHubReviewPublisher`; se esta abstração for implementada antes, esse publisher deve nascer sobre ela.
