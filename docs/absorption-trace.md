# Absorption trace — behavioural chain per ported module

Required by [`§46`](research/2026-09-06-webmux-absorption.md) of the absorption
plan. Every module absorbed from WebMux carries the full chain here, written in
the same PR as the port:

```text
WebMux original → existing behaviour → Issue Flow implementation
                → adaptations → parity tests
```

A port PR without its block here is incomplete. The section
**"Behaviour deliberately NOT ported"** may be empty, but it may never be
absent: it is where a silent simplification becomes an explicit, reviewable
decision.

The one-line origin→destination mapping for each unit lives in
[`provenance.md`](provenance.md); this file holds the reasoning that a table row
cannot carry.

---

### Transporte push do monitor (Fase 1)

**WebMux original**
`.references/webmux-main/backend/src/server.ts` @ d8c9d5f — 2.790 linhas, das quais
importa aqui o caminho de saída: `sendWs()` (`:459`) e os três `ws.send` de `:464–:476`.
O upstream não consulta o estado; ele **empurra** cada chunk no instante em que o
callback do PTY dispara. É essa decisão — não o tmux, não o Bun — que responde por
`≈ 0 ms` contra os **3–8 s** medidos no Issue Flow (§5.4 da especificação).

**Comportamento existente**
- O servidor relia o SQLite a cada `DEFAULT_POLL_INTERVAL_MS = 3000`.
- O navegador relia o servidor a cada `refreshSeconds` (default `5`).
- Os dois saltos somavam a maior diferença de experiência medida em todo o estudo.
- Casos especiais que NÃO podiam se perder: o servidor jamais pode afetar a pipeline
  (falha de bind, erro de handler e erro de subscriber são engolidos); `session.json` e
  os JSONL continuam sendo projeções de compatibilidade que o monitor destacado nunca
  percorre; a janela de 90 s de heartbeat e o ETag por conteúdo continuam valendo; o
  backend legado de publisher único (fallback US-006) continua funcionando.

**Implementação no Issue Flow**
- `packages/issue-flow/src/web/session-directory.ts` — estratégia: **ADAPT**
- `packages/issue-flow/src/web/server.ts` (`/api/stream`) — estratégia: **ADAPT**
- `packages/issue-flow/web/public/app.js` (cliente `EventSource`) — estratégia: **ADAPT**

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| WebSocket → **Server-Sent Events** | Este canal carrega JSON reduzido em uma direção só: não precisa de framing, handshake de upgrade nem dependência nova, e reconecta sozinho. O transporte bidirecional do terminal (Fase 8) tem requisitos próprios — backpressure e replay incremental — e juntar os dois obrigaria ambos a carregar a união das restrições |
| Callback do PTY → **`fs.watch` na raiz de storage** | No WebMux o processo que produz o output é o mesmo que serve o WebSocket. No Issue Flow o monitor é um processo destacado: o commit SQLite da pipeline é o único evento que os dois lados já compartilham |
| Watch no **diretório**, não no arquivo | Um checkpoint do WAL apaga e recria `issue-flow.db-wal`; um watch preso a esse inode pararia de disparar exatamente uma vez, em silêncio. `fs.watch` não-recursivo em diretório é também o único modo que todas as plataformas suportadas implementam |
| Debounce de `WATCH_DEBOUNCE_MS = 20` | Um commit lógico produz vários eventos de filesystem (WAL e, no checkpoint, o arquivo principal). Colapsá-los custa 20 ms de um orçamento de 250 ms |
| `subscribe()` compara o snapshot **serializado** | O heartbeat de 10 s muda `updatedAt` sem mudar conteúdo. Tratar isso como mudança acordaria todo viewer conectado dez vezes por minuto à toa |
| Poll de 3 s **preservado como rede de segurança** | O driver de compatibilidade `json` não tem arquivo único para observar, e um watch que morre não pode rebaixar o monitor para sempre |
| Backend legado ganha `subscribe()` por tick de `version()` | `SessionPublisher` expõe contador monotônico e nenhuma notificação; é uma leitura em memória, iniciada no primeiro assinante e encerrada com o último |
| O painel usa o frame como **sinal**, não como segundo caminho de render | Duas rotinas de "aplicar estado na tela" divergiriam. `poll()` continua sendo a única |

**Comportamento deliberadamente NÃO portado**

| O quê | Origem | Por quê |
|---|---|---|
| Prefixo de 1 caractere (`"o"`/`"s"`) no caminho quente | `server.ts:464–467` | Existe para evitar `JSON.stringify` por chunk de TTY. Este canal carrega estado JSON reduzido, algumas vezes por segundo; o prefixo economizaria nada e custaria um protocolo ad-hoc |
| Ausência de autenticação | `Bun.serve` sem `hostname` | ADR-10. As rotas de escrita continuam restritas a loopback e `/api/stream` é somente leitura; a autenticação obrigatória entra com o terminal (Fase 8), que é shell remoto |
| Replay de scrollback e backpressure | `terminal.ts` | Pertencem ao transporte do TTY (Fase 8). Aqui não há stream de bytes para truncar: cada frame é o estado corrente completo, e o mais recente torna o anterior irrelevante |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `src/web/session-directory.test.ts` — bloco *push notifications* | novo (§34, critério da Fase 1) | 5 | ✅ |
| `src/web/server.test.ts` — bloco *push transport* | novo (§34, critério da Fase 1) | 8 | ✅ |
| `src/web/stream-latency.integration.test.ts` | orçamento de §35 | 1 | ✅ |

Nenhum teste upstream foi portado nesta fase: o caminho equivalente do WebMux
(`backend/src/server.ts`) não tem testes no upstream congelado.

**Orçamentos**

| Métrica | Budget | Medido |
|---|---|---|
| Latência output → tela (p95) | ≤ 250 ms (teto duro) | **54 ms** (mediana 51 ms, 10 amostras, `stream-latency.integration.test.ts`) |
| Antes da fase | — | 3–8 s (poll de 3 s no servidor + 5 s no navegador) |

---

### Convenções Git — nomeação automática de branch e postura de política (Fase 4)

**WebMux original**
`.references/webmux-main/backend/src/services/auto-name-service.ts` @ d8c9d5f — 104 linhas,
com `backend/src/domain/policies.ts:8–24` (`sanitizeBranchName`, `isValidBranchName`, 17 linhas)
e `backend/src/lib/branch-name.ts` (`generateFallbackBranchName`, 5 linhas).

Toda a política Git do WebMux cabe em **uma regra de nomeação de branch** mais uma frase de
system prompt válida só no modo oneshot (§8.4). O que ele tem e o Issue Flow não tinha é
exatamente o caminho para trabalho **sem issue**: descrição livre → nome gerado, plano,
kebab-case, ≤ 40 caracteres, **sem prefixo**.

**Comportamento existente**
- `normalizeGeneratedBranchName` aplica onze passos em ordem fixa; cada um defende contra
  saída realmente observada de modelo (cerca de código, `Branch name:`, aspas, maiúsculas,
  caractere ilegal, `/` e `.` que reintroduziriam prefixo, hífens repetidos, bordas, teto de
  comprimento, e o hífen que a própria truncagem deixa).
- `isValidBranchName(x) === (sanitizeBranchName(x) === x)`: um nome é válido exatamente
  quando sanitizá-lo não muda nada. Sem isso, saída ruim vira `git worktree add` falho
  segundos depois.
- Timeout de 15 s com fallback `change-<uuid8>`; `spawn_error` e exit ≠ 0 **lançam**.
- A frase `Do not include quotes, code fences, or prefixes like feature/ or fix/` é a que
  carrega peso: sem ela o modelo produz `feature/foo` de forma reprodutível, colidindo com o
  prefixo do caminho convencional.
- Casos especiais que NÃO podiam se perder: a ordem dos onze passos; a truncagem **antes**
  da remoção do hífen final; a equivalência sanitize/validate; a literalidade dos dois prompts.

**Implementação no Issue Flow**
- `packages/issue-flow/src/conventions/git/auto-name.ts` — estratégia: **ADAPT**
- `packages/issue-flow/src/conventions/git/slug.ts` (`sanitizeBranchName`, `isValidBranchName`) — **PORT**
- `packages/issue-flow/src/conventions/git/branch.ts` (`resolveBranchName`, os três caminhos de §10.4) — novo
- `packages/issue-flow/src/conventions/git/convention.ts` (`resolveGitConvention`, ADR-11) — novo, sem origem upstream
- `packages/issue-flow/src/policy/parsers/git.ts` (`.gitmessage`, commitlint em CI, histórico) — novo, sem origem upstream

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| `AutoNameService` (classe com `spawnImpl`) → função `autoNameBranch` com `BranchNameGenerator` injetado | `src/conventions/AGENTS.md`: "a camada Git não aceita provider, agent nem model". O upstream monta `claude -p …` / `codex exec …` dentro deste módulo; no Issue Flow o argv do provider vive em `agents/`, e `dependency-direction.test.ts` proíbe a importação. O prompt, a normalização e o fallback — tudo que **decide** o nome — continuam aqui |
| `Bun.spawn` + `LlmSpawnTimeoutError` → `AbortController` + `node:timers/promises` | Runtime. O prazo é imposto **pelo chamador**, não confiado ao gerador: um gerador que ignore `timeoutMs`, ou que trave num processo que nunca sai, ainda não pode passar do teto |
| `spawn_error` / exit ≠ 0 **lançam** → **todo** fracasso vira fallback | ADR-03: `headless` é o default e um repositório sem modelo algum alcançável tem de continuar funcionando. G3 fixa as duas metades ("indisponível **ou** timeout → `change-<uuid8>`") |
| `normalizeGeneratedBranchName` lança → retorna `null` | A resposta do chamador para "sem nome" é o fallback determinístico, não uma exceção que sobe pela pipeline |
| `sanitizeBranchName`/`isValidBranchName` movidos para `slug.ts` | Evita ciclo `branch.ts ↔ auto-name.ts`; `slug.ts` já é o módulo de normalização determinística de nome. Re-exportados por `branch.ts` e por `index.ts`, então a superfície pública não muda |

**Comportamento deliberadamente NÃO portado**

| O quê | Origem | Por quê |
|---|---|---|
| `buildLlmArgs` (argv de `claude -p` e `codex exec`, `escapeTomlString`) | `services/llm-spawn.ts:66–90` | A camada de convenções não pode nomear provider, agent ou model (`src/conventions/AGENTS.md`, precedência §1). O argv pertence a `agents/`, e `agents/argv.ts` já é a implementação canônica (ADR-04, §45.1-M) |
| `defaultLlmSpawn` (`Bun.spawn` + corrida de timeout manual) | `services/llm-spawn.ts:22–60` | Bun-only, e o Issue Flow já tem `utils/shell.ts` como chokepoint único com allowlist. Reintroduzir um spawn paralelo seria a regressão de §45.3 |
| `llmProviderLabel` e as mensagens de erro que citam a CLI | `auto-name-service.ts:83–92` | Consequência das duas linhas acima: sem provider no módulo, não há rótulo de provider a imprimir |
| `resolveBranchAvailability` (colisão rejeitada com 4xx) | `lifecycle-service.ts:1398` | O Issue Flow já resolve colisão com sufixo determinístico (`collide()` em `branch.ts`), que é a implementação mais madura: não falha um `run` por um nome já usado |
| `AutoNameConfig.provider`/`model` | `domain/config.ts:90–94` | Mesmo motivo; a escolha de agente por fase já é do `routing`/`select` do Issue Flow (§45.1-L) |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `src/conventions/git/auto-name.test.ts` | `backend/src/__tests__/auto-name-service.test.ts` (17 casos upstream) | 25 (9 portados · 3 adaptados · 13 novos) | ✅ |
| `src/conventions/git/convention.test.ts` | novo (ADR-11) | 8 | ✅ |
| `src/policy/parsers/git.test.ts` — bloco das cinco fontes | novo (§11) | 6 | ✅ |
| `src/conventions/git/characterization.test.ts` — G1, G2, G3, G8, G9, G10, G11 | §34 | 17 | ✅ |
| `src/policy/characterization.test.ts` — G4, G5, G6, G7 | §34 | 7 | ✅ |

Oito dos dezessete casos upstream **não** portam: todos afirmam o argv de `claude -p` /
`codex exec`, que este diretório não monta. Três são adaptados — o upstream lança onde o
Issue Flow degrada, e a asserção passa de `rejects.toThrow` para o fallback determinístico.

**Orçamentos**

| Métrica | Budget | Medido |
|---|---|---|
| Boot do CLI | ≤ 250 ms | **120 ms** (mediana de 5, `node dist/cli.js --version`) |
| Descoberta de convenções Git (local, com as duas novas leituras de histórico) | sem budget em §35 | **40 ms** (mediana de 5, neste repositório) |
| Descoberta de política completa, local-only | sem budget em §35 | **47 ms** (mediana de 5) |

O caminho gerado não tem orçamento em §35 e não entra em `headless`: sem gerador
configurado — o default — `resolveBranchName` nunca o alcança e nenhuma chamada de modelo
acontece para nomear uma branch.

---

### Eventos de ciclo de vida do agente por hook (Fase 2)

**WebMux original**
`.references/webmux-main/backend/src/adapters/agent-runtime.ts` @ d8c9d5f — 530 linhas ·
`.references/webmux-main/backend/src/domain/events.ts` — 4 tipos de evento ·
`.references/webmux-main/backend/src/adapters/control-token.ts` — 24 linhas.
Base canônica segundo `§45.1-D`: **WebMux** (o Issue Flow não tinha equivalente).

**Comportamento existente**
- O estado do agente **nunca** é lido do TTY; vem de hook (ADR-05).
- Merge de hooks que **preserva grupos alheios**, identificados pelo prefixo do comando —
  um grupo que apenas menciona o helper dentro de um wrapper **não** é nosso.
- `resolveGitCommonDir()`: dentro de um worktree o `gitDir` é
  `…/.git/worktrees/<nome>` e o `info/exclude` só existe no diretório comum.
- Matcher `permission_prompt|elicitation_dialog` no `Notification` do Claude — os dois,
  porque são eventos diferentes e só o par cobre "bloqueado num humano".
- `--best-effort` no `PreToolUse` do Codex: o hook dispara no caminho quente de toda
  chamada de ferramenta e uma falha de reporte não pode custar o turno.
- `codex-stop` imprime `{}` no stdout — o Codex lê um objeto JSON de volta dos hooks `Stop`.
- Detecção de `gh pr create` por varredura recursiva de todos os valores string do
  `tool_response`, com regex `https://github\.com/[^\s"]+/pull/\d+`.
- Timeout de 2 s no POST.
- Casos especiais que NÃO podiam se perder: os dois primeiros itens desta lista, mais o
  timeout e o `--best-effort`.

**Implementação no Issue Flow**
- `src/agents/hooks/contract.ts` — **PORT** de `domain/events.ts`
- `src/agents/hooks/agentctl.ts` — **PORT** de `buildAgentCtlScript()`
- `src/agents/hooks/install.ts` — **PORT** do restante de `agent-runtime.ts`
- `src/agents/hooks/control-server.ts` — **ADAPT** de `control-token.ts` + rota do servidor
- `src/agents/hooks/apply.ts` — **ADAPT** da projeção de `project-runtime.ts`
- `src/agents/hooks/runtime.ts` — novo: dono do ciclo de vida por invocação
- `src/core/session/reducer-agent.ts`, `src/core/session/events.ts`,
  `src/core/session/snapshot.ts`, `src/schemas.ts` — projeção aditiva
- `src/storage/db/migrations.ts` (versão 9), `src/storage/db/repository.ts` — persistência

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| Script Python → **Node ESM** (`.mjs`) | O Issue Flow já exige Node ≥ 22.13 (§23); depender de `python3` acrescentaria um pré-requisito que hoje não existe. A extensão `.mjs` elimina a ambiguidade de tipo de módulo de um arquivo sem extensão |
| `Bun.file`/`Bun.write` → `node:fs/promises` + `writeFileAtomic` | Runtime, e §45.3: o WebMux **não** faz escrita atômica; usar `writeFile` direto seria regressão |
| Correlação `worktreeId`+`branch` → `runId`+`phase` | É o que a pipeline conhece (§18). `runId` é o `sessionId` — `runs.id` e `runs.session_id` são o mesmo valor |
| Endpoint no **processo da pipeline**, não no servidor do projeto | ADR-03: `headless` é o default e não pode depender de monitor no ar. É o que faz o critério de conclusão da fase — `awaiting_input` num `execute` headless — ser alcançável sem `--web` |
| Token **efêmero por invocação**, não `~/.issue-flow/control-token` | §18 previa um arquivo persistente, herdado do WebMux, onde servidor e CLI são processos diferentes e precisam de segredo compartilhado. Aqui o servidor de controle **é** o processo que escreve o `control.env`, então pode entregar o token direto. Um segredo de longa duração em disco não compraria nada e ampliaria a superfície. Divergência deliberada, registrada em §8 |
| Merge que preserva grupos alheios aplicado **também** ao `settings.local.json` | O upstream substitui o array inteiro do evento nesse arquivo, o que apaga os hooks do próprio usuário. `§45.2-D` nomeia justamente esse merge como o que não pode se perder |
| Todo caminho do helper sai com **código 0** | O upstream devolve 1 em algumas falhas de POST. Um `UserPromptSubmit` não-zero **bloqueia o prompt** no Claude Code: um soluço do endpoint viraria execução quebrada. É o mesmo contrato que `src/web` já mantém com a pipeline — observabilidade nunca decide se um agente roda |
| `control.env` ausente → sai em silêncio, código 0 | Os hooks sobrevivem a uma invocação. Sem essa saída rápida, um hook deixado para trás custaria 2 s de timeout em toda sessão `claude` posterior do usuário |
| Eventos **persistidos** em `agent_events` | O WebMux só muta memória (§2.5). Um `awaiting_input` que acontece sem ninguém olhando é exatamente o que vale registrar (§18) |
| Hooks **removidos** ao fim da invocação | O upstream instala num worktree descartável; aqui os arquivos ficam na árvore de trabalho do usuário |
| Artefatos em `<gitDir>/issue-flow/` | Invariante 17: artefato de execução nunca é commitado |

**Comportamento deliberadamente NÃO portado**

| O quê | Origem | Por quê |
|---|---|---|
| `webmux-agentctl` como nome/arquivo sem extensão | `agent-runtime.ts` | Um arquivo sem extensão tem tipo de módulo ambíguo em Node, decidido pelo `package.json` mais próximo. `.mjs` é determinístico |
| Sub-comandos `starting` e `stopped` produzindo estado próprio na projeção | `domain/events.ts` | O parser aceita os quatro lifecycles (paridade preservada), mas a projeção trata `starting` como `busy` e ignora `stopped`: o fim da invocação já reporta esse fato, e uma segunda fonte para o mesmo fato é uma segunda coisa a manter consistente |
| Notificação de desktop no `agent_stopped` | `services/notification-service.ts` | Fora do escopo da fase; o evento é persistido e a fase 9 (human-in-the-loop) é quem decide o que fazer com ele |
| `Bun.serve` sem `hostname` (bind em `0.0.0.0`, sem credencial) | `server.ts` | ADR-10 — a única parte do WebMux explicitamente rejeitada |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `src/agents/hooks/contract.test.ts` | `__tests__/runtime-events.test.ts` (2) + 2 novos | 4 | ✅ |
| `src/agents/hooks/install.test.ts` | `__tests__/agent-runtime.test.ts` (2 sem subprocesso) + 8 novos (§23: idempotência, remoção limpa, grupos alheios do Claude, `commondir` em worktree, credenciais, arquivo corrompido) | 10 | ✅ |
| `src/agents/hooks/control-server.test.ts` | novo (§23: token inválido → 401) | 6 | ✅ |
| `src/agents/hooks/apply.test.ts` | novo (projeção de §18) | 7 | ✅ |
| `src/agents/hooks/agentctl.integration.test.ts` | `__tests__/agent-runtime.test.ts` (2 com subprocesso) + 3 novos, incluindo o **critério de conclusão da fase** | 5 | ✅ |

Total portado do upstream: **4 casos** (2 de `runtime-events.test.ts`, 2 de
`agent-runtime.test.ts`); os outros 2 de `agent-runtime.test.ts` foram portados como
testes de subprocesso na suíte de integração. Acrescentados: **28 casos**.

**Orçamentos**
Nenhum orçamento de §35 se aplica a esta fase. O custo acrescentado ao caminho quente é
uma escrita de dois arquivos JSON pequenos e um `listen()` em porta efêmera por invocação,
ambos fora do caminho de latência output→tela medido na Fase 1.

---

### Contrato de runtime — três modos (Fase 3)

**WebMux original**
Nenhum. `§45.1-C` (orquestração de invocação: timeout, watchdog, shutdown, usage) dá a
base canônica ao **Issue Flow**, e o WebMux não tem equivalente. Esta fase não absorve
código: ela cria a costura onde as fases 6 (tmux) e 12 (sandbox) vão encaixar os outros
dois modos sem tocar em `AgentInvocation`/`AgentRunResult`.

**Comportamento existente**
- `invokeSelectedAgent()` chamava `runnerFor(provider).run(invocation, settings)` direto.
- Casos especiais que NÃO podiam se perder: o `spawn` do runner **não** recebia `cwd`
  quando a invocação não declarava `workingDirectory`; o `onEvent` do chamador continua
  sendo chamado; failover, watchdog, telemetria e o reducer de sessão dependem das formas
  de `AgentInvocation`/`AgentRunResult` (ADR-02).

**Implementação no Issue Flow**
`src/runtime/types.ts`, `src/runtime/headless.ts`, `src/runtime/index.ts` — estratégia:
**novo** (contrato nativo, base canônica Issue Flow).

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| `launch(ctx, inv)` de `§26` ganhou um terceiro parâmetro `settings` | O runner exige `ResolvedAgentSettings`; sem ele o contrato não é executável |
| `Runtime.capabilities` acrescentado ao contrato de `§26` | `send`/`interrupt` são no-op em `headless`. Um `Promise<void>` silencioso não permite ao chamador saber disso antes de tentar; a capability segue o padrão que `AgentCapabilities` já usa em `src/agents/` |
| `headless.launch()` **não** fixa `workingDirectory` no `context.workdir` | Fixá-lo colocaria um `cwd` explícito num spawn que nunca teve um — valor equivalente, comportamento diferente. Detectado por `src/core/executor.test.ts`, que é exatamente o gate de "sem mudança de comportamento" |
| `createRuntime()` **lança** para `interactive`/`sandbox` | Um fallback silencioso para `headless` reportaria um isolamento que não foi entregue, e isolamento é a única razão para pedir outro modo |

**Comportamento deliberadamente NÃO portado**
Nenhum — não há unidade upstream nesta fase.

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `src/runtime/headless.test.ts` | novo (critério da Fase 3) | 10 | ✅ |
| Suíte existente inteira | gate "100% verde, sem mudança de comportamento" | 2.476 | ✅ |

**Orçamentos**
Nenhum de §35 se aplica: o caminho quente é idêntico ao anterior — uma chamada de função a
mais e nenhuma sintaxe de processo diferente.

---

### Worktree manager (Fase 5)

**WebMux original**
`.references/webmux-main/backend/src/adapters/git.ts` @ d8c9d5f — 483 linhas ·
`services/lifecycle-service.ts` — 1.523 · `services/worktree-service.ts` — 287 ·
`adapters/fs.ts` (helpers de path e env) — 364 · `services/worktree-creation-service.ts` — 40 ·
`services/auto-remove-service.ts` + `auto-pull-service.ts` — ~200.
Base canônica por `§45.1-E`: **WebMux** para as operações de worktree e para o merge com
rollback (o Issue Flow não tinha nenhuma). `§45.1-F` e `§45.1-G`: **Issue Flow** para o
chokepoint de shell e para a escrita de estado.

**Comportamento existente**
- `git worktree add -b <branch> <path> <base>` para `new`; `git worktree add <path> <branch>`
  para `existing`, com `startPoint` quando a branch só existe no remoto.
- Disponibilidade de branch com erros 4xx distintos: 409 já existe · 409 já tem worktree ·
  404 não encontrada.
- `filterLiveWorktreeEntries()` — git mantém o registro administrativo de um worktree cujo
  diretório foi apagado à mão até alguém dar `prune`.
- `removeGitWorktree()` só apaga o diretório depois de confirmar que o git **não** o lista
  mais; apagar um diretório que o git ainda considera vivo corrompe a visão do repositório.
- `mergeBranch()` restaura o checkout anterior **inclusive quando o merge falha**, e
  concatena os erros de limpeza à causa original em vez de substituí-la. "MERGE_HEAD
  missing" é ignorado porque significa que o merge nem começou.
- `cleanupFailedCreate()` tenta todos os passos mesmo com falhas no meio.
- Fallback de `aheadCount` e de `listUnpushedCommits` quando não há upstream configurado.
- Casos especiais que NÃO podiam se perder: a lista **crua** de worktrees na checagem de
  disponibilidade; a restauração do checkout após merge com conflito; a checagem antes do
  fallback de `rm -rf`; o `fetch` que falha sem derrubar a listagem de branches remotas;
  o filtro do ref simbólico `origin` ao listar remotas.

**Implementação no Issue Flow**
`src/runtime/worktree/{git,lifecycle,meta,paths,progress,gc,index}.ts` ·
migration 11 (`worktrees`) e os repositórios em `src/storage/db/repository.ts`.

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| `Bun.spawnSync` → `run()` de `src/utils/shell.ts`, tudo assíncrono | `§45.1-F`: o chokepoint único do Issue Flow traz allowlist de git destrutivo e retry, que o `lib/shell.ts` do WebMux não tem. O chokepoint é assíncrono, e um segundo caminho síncrono seria responsabilidade duplicada |
| `meta.json` por worktree → tabela `worktrees` (migration 11) | `§45.2-G`: o **modelo** é do WebMux, o **veículo** é do Issue Flow. Um segundo arquivo de estado ao lado do banco é uma segunda coisa que pode discordar dele |
| `runtime.env` continua arquivo, gravado com `writeFileAtomic` | `bash` e os hooks de lifecycle leem esse arquivo e nenhum dos dois consulta banco. `Bun.write` do upstream não é atômico (§45.3) |
| `<gitDir>/webmux/` → `<gitDir>/issue-flow/` | Invariante 17; e é o mesmo diretório onde os hooks da Fase 2 já vivem |
| `LifecycleService` (classe, 1.523 LOC) → `createWorktreeManager()` + `WorktreeLifecycleHooks` | tmux, containers, portas e profiles pertencem às fases 6, 10 e 12. Portá-los aqui pela metade produziria uma segunda implementação mais fraca de cada um |
| `list()` junta git com o banco e marca `orphaned` | ADR-08. O upstream reconstrói a projeção e remove o que não viu; aqui a divergência é **reportada**, nunca reparada |
| Raiz do repositório reconhecida pelo path que o **git** reporta | No macOS os diretórios temporário e home são symlinks: o git responde `/private/var/…` onde o chamador passou `/var/…`, e comparar as strings faz o próprio repositório aparecer como mais um worktree gerenciado |
| `saveWorktree()` faz upsert da linha de `projects` | É chave estrangeira, e um worktree pode ser a primeira coisa que um projeto registra. Mesmo padrão de `saveSessionEvent` |
| Ordem de escrita determinística em `runtime.env` | O arquivo é lido por quem está depurando um worktree; um conjunto de variáveis que se reordena a cada escrita torna o diff inútil |

**Comportamento deliberadamente NÃO portado**

| O quê | Origem | Por quê |
|---|---|---|
| `hardReset()` e `forcePullMainBranch()` | `adapters/git.ts:480`, `auto-pull-service.ts:54` | Fazem `reset --hard`, descartando o estado local. `src/utils/AGENTS.md` é explícito: nada destrutivo roda automaticamente para consertar estado. O monitor periódico do upstream já usa só o `pullMainBranch` fast-forward; o que sai é a variante manual destrutiva, que nada no escopo chamava |
| `allocateServicePorts()` | `domain/policies.ts:88` | Pertence a `src/runtime/services.ts` (Fase 10, §22). Aqui `allocatedPorts` é **entrada** do worktree, não cálculo dele |
| `archiveState`, `setWorktreeArchived`, `setWorktreeLabel`, `tabs`, `forkCounter` | `lifecycle-service.ts`, `domain/model.ts` | São estado de UI do painel do WebMux. Entram, se entrarem, com o port do frontend (§48/§50), não com o gerenciador de worktree |
| `buildCreateWorktreeTargets` / `prefixAgentBranch` (um worktree por agente) | `lifecycle-service.ts:122` | É multi-agente, que é a Fase 17. Portar agora criaria uma segunda convenção de branch (`<agent>-<branch>`) ao lado da de `src/conventions/git/`, que é a única permitida |
| `openWorktree` / `materializeRuntimeSession` / `restoreWorktreeTabs` | `lifecycle-service.ts:257` | Dependem de tmux e de sessão de agente — fases 6 e 7 |
| `resolveRepoRoot` varrendo filhos de um container | `adapters/git.ts` | **Portado** (está em `git.ts`), mas ainda não usado: quem vai consumi-lo é o `serve` multi-projeto |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `src/runtime/worktree/git.test.ts` | `__tests__/git-adapter.test.ts` (partes puras) + novos | 13 | ✅ |
| `src/runtime/worktree/lifecycle.test.ts` | `__tests__/lifecycle-service.test.ts` (decisões, com dublê de gateway) | 22 | ✅ |
| `src/runtime/worktree/meta.test.ts` | `__tests__/worktree-storage.test.ts` | 11 | ✅ |
| `src/runtime/worktree/gc.test.ts` | `auto-remove-service` / `auto-pull-service` | 12 | ✅ |
| `src/runtime/worktree/lifecycle.integration.test.ts` | `__tests__/git-adapter.test.ts` (casos com repositório real) + **C1** e **C12** de §34 | 13 | ✅ |
| `src/storage/db/migrations.test.ts` | migration 11 em banco novo, existente, reaberto | 1 | ✅ |

Total: **71 casos**. Os 105 casos upstream de `§22` cobrem também containers, portas,
profiles, tabs e archive — deliberadamente fora desta fase (ver acima); os casos portados
são os que exercitam o comportamento que esta fase de fato absorve.

**Orçamentos**

| Métrica | Baseline WebMux | Budget | Medido |
|---|---|---|---|
| `git worktree add` | 78 ms | ≤ 150 ms | **45–97 ms** (mediana de 5, `lifecycle.integration.test.ts`) |

---

### PR / CI / GitHub canônico (Fase 14)

**WebMux original**
`.references/webmux-main/backend/src/services/pr-service.ts` @ d8c9d5f — 675 linhas,
mais `backend/src/lib/async.ts` (69), o trecho `apiCiLogs` de `backend/src/server.ts:1769`
e o tipo `LinkedRepoConfig` de `backend/src/domain/config.ts:60`.

**Comportamento existente**

- **Dois loops com políticas distintas.** O *display sync* (10 s) é **gated** por
  `hasRecentDashboardActivity()`: ninguém olhando, nenhuma chamada `gh`. A varredura de
  auto-remove (60 s) roda **sem** gating, porque PRs são mesclados com o painel fechado e a
  limpeza precisa acontecer de qualquer jeito.
- **Cache ETag por path da API.** `gh api … --include` devolve os headers antes do corpo; o
  serviço guarda o `ETag`, manda `If-None-Match` na chamada seguinte e trata `304 Not
  Modified` como acerto de cache. Uma requisição condicional **não consome rate limit**.
- **Cache de `updatedAt` por URL de PR.** Um PR cujo `updatedAt` não mudou nem chega a
  disparar a leitura de comentários inline.
- **Dedupe "latest wins" do `statusCheckRollup`.** Reexecutar um workflow deixa a execução
  anterior no rollup sob o mesmo nome; sem o dedupe, a execução velha mascara a nova.
- **`CANCELLED` não é veredito.** Uma execução cancelada por *concurrency
  cancel-in-progress* é superseded, não falha — sem isso o PR fica "failed" para sempre.
- **O sentinela de `completedAt`.** O GitHub reporta `0001-01-01T00:00:00Z` enquanto a
  execução ainda roda; por isso a recência usa `max(startedAt, completedAt)`, senão uma
  execução viva ordena como antiquíssima e perde para uma concluída mais velha.
- **Consulta falha ≠ lista vazia.** `fetchAllPrs` devolve `Result`; `fetchBranchPrStates`
  devolve `null` se **qualquer** repositório falhar, porque a varredura lê isso ao vivo e
  agir sobre dado parcial removeria um worktree cujo PR só estava inacessível.
- **`refreshStalePrData` reconsulta `isDraft`, não só `state`.** Um PR pode estar ausente da
  lista de abertos e continuar aberto (falha de fetch, truncamento do limite de 50); um
  draft marcado como pronto nessa janela continuaria renderizando como draft.
- **`startSerializedInterval` coalesce ticks.** Um tick que chega com a passada anterior em
  voo marca **um** rerun, nunca enfileira uma segunda execução.
- Casos especiais que NÃO podem se perder: o dedupe latest-wins · `CANCELLED` → `skipped` ·
  o sentinela de `completedAt` · o `Result`/`null` das consultas · o refresh de `isDraft` ·
  a leitura do bloco de headers antes do corpo em `--include` · o coalescing do intervalo.

**Implementação no Issue Flow**
`packages/issue-flow/src/issues/github/{types,client,pr,ci,comments,linked-repos,monitor,index}.ts`
e `packages/issue-flow/src/utils/async.ts` — estratégia: **MERGE** (PR e comentários),
**PORT** (CI, repos vinculados, loops), **ADAPT** (o sync).

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| `Bun.spawn` + corrida com `Bun.sleep` → `run()` de `src/utils/shell.ts` com `timeout` | §45.3 e `src/utils/AGENTS.md`: `run()` é o único caminho de shell, com argv e sem string de shell. O `timeout` do execa mata o filho como a corrida upstream fazia, e o `run()` ainda classifica o estouro como falha `timeout` |
| Toda chamada `gh` carrega a política de resiliência (`ghPolicy()`) | O WebMux não tem retry nenhum (§45.0). Perder a taxonomia de falha + retry do Issue Flow seria o risco inverso de §45.3 |
| `ghPolicy` / `ghProbePolicy` / `gh()` saíram de `issues/providers/github.ts` para `issues/github/client.ts` | Duas cópias da mesma política de retry seriam a duplicata que esta fase existe para remover |
| `syncPrStatus` **devolve** o mapa em vez de gravar em `<gitDir>/webmux/prs.json` | Invariante 22: nenhum segundo arquivo de estado ao lado do SQLite. Quem persiste é o chamador — e a Fase 5 já tem `worktree/meta.ts` para isso |
| `startPrMonitor` + `startAutoRemoveMonitor` → um `startPullRequestMonitor` com `isActive` opcional | As duas funções upstream diferem **só** no gating. Uma função com o gate como parâmetro é uma implementação por responsabilidade; duas quase idênticas seriam a duplicata proibida |
| `refreshStalePrData(gitDir)` → `refreshStalePullRequests(entries)` | A versão upstream lê e grava o arquivo por worktree. A parte que importa — reconsultar `state` **e** `isDraft` de cada entrada aberta — é pura e vai junto; o I/O de armazenamento não |
| `repoTargets()` explicitando "repositório atual primeiro, depois os vinculados" | O upstream espalha `[fetchAllPrs(undefined), ...linked.map(...)]` por três funções. A ordem é significativa (o repositório atual ganha o desempate de branch) e passa a estar escrita uma vez |
| `LinkedRepoConfig` vira a chave `github` de `.issue-flow.json`, com `ISSUE_FLOW_GITHUB_LINKED_REPOS` | O Issue Flow não tinha o conceito; entra pela escada de precedência documentada, como qualquer outro domínio de configuração |
| `log.debug`/`log.error` → callbacks `onError` / `onFailure` | O módulo fica sem dependência de superfície de saída; quem chama decide se aquilo vira log, telemetria ou evento |
| `type PrEntry` → `PullRequestEntry` (e os pares equivalentes) | Nomes por extenso, como o resto do repositório |

**Comportamento deliberadamente NÃO portado**

| O quê | Origem | Por quê |
|---|---|---|
| A varredura de auto-remove em si (`startAutoRemoveMonitor` + `auto-remove-service.ts`) | `pr-service.ts:660` | Pertence a `src/runtime/worktree/gc.ts` (§22, Fase 5), que já existe. O que a Fase 14 devia entregar é a **fonte de dados** dela, `fetchBranchPullRequestStates`, e a política ungated — que aqui é `startPullRequestMonitor` sem `isActive` |
| `readWorktreePrs` / `writeWorktreePrs` | `adapters/fs.ts` | Escrevem `prs.json` por worktree com `Bun.write`, sem escrita atômica (§45.0). O veículo de persistência do Issue Flow é o SQLite; o sync devolve os dados e não escolhe onde eles moram |
| `hasRecentDashboardActivity()` | `server.ts` | É a implementação do gate, não o gate. O painel do Issue Flow ainda não existe na forma que a Fase 8B vai trazer; `isActive` é o ponto de encaixe, e escrever agora uma heurística de atividade sobre o painel antigo seria uma segunda implementação para jogar fora |
| A integração Linear em torno do PR (`linkedLinearIssue` no `WorktreeSnapshot`) | `linear-*.ts` | `DISCARD` explícito (ADR-14) |
| `unref()` no `setInterval` do intervalo serializado | `lib/async.ts` | Seria endurecer durante o porte (ADR-12). O agendador é injetável, então quem precisar de um timer que não segura o processo passa o seu — e nenhum caminho de CLI liga o monitor hoje |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `src/utils/async.test.ts` | `__tests__/pr.test.ts` (`mapWithConcurrency`, `startSerializedInterval`) | 5 portados | ✅ |
| `src/issues/github/comments.test.ts` | `__tests__/pr.test.ts` (`parseReviewComments`) + cache ETag | 4 portados + 12 novos | ✅ |
| `src/issues/github/pr.test.ts` | `__tests__/pr.test.ts` (`parsePrResponse` draft, `parsePrViewStatus`) + I/O | 6 portados + 18 novos | ✅ |
| `src/issues/github/ci.test.ts` | `__tests__/pr.test.ts` (`summarizeChecks`, `dedupeLatestChecks`/`mapChecks`) + `gh run view` | 7 portados + 12 novos | ✅ |
| `src/issues/github/monitor.test.ts` | gating, caches e evicção do `syncPrStatus` | 10 novos | ✅ |
| `src/issues/github/linked-repos.test.ts` | fan-out por repositório | 5 novos | ✅ |
| `src/issues/github/single-implementation.test.ts` | invariante 13 — guarda por varredura da árvore | 6 novos | ✅ |
| `src/config/github.test.ts` | escada de precedência da chave `github` | 9 novos | ✅ |

**Portados: 22 casos**, exatamente os 22 de `__tests__/pr.test.ts` (§22), de `bun:test` para
`vitest`. Total desta fase: **94 casos**.

**Orçamentos**

| Métrica | Budget | Medido |
|---|---|---|
| Boot do CLI | ≤ 250 ms | **100–140 ms** (mediana de 5, `node dist/cli.js --version`) |
| Chamadas `gh` por passada com PR inalterado | — | **1** (só o `pr list`; a leitura de comentários é servida do cache de `updatedAt` — `monitor.test.ts`) |
| Chamadas `gh` por passada com o gate fechado | — | **0** (`monitor.test.ts`) |

---

### Runtime tmux (Fase 6)

**WebMux original**
`.references/webmux-main/backend/src/adapters/tmux.ts` @ d8c9d5f — 314 linhas ·
`adapters/project-env.ts` — ~60 · `services/session-service.ts` — 155.
Base canônica: **WebMux** (o Issue Flow não tinha nada equivalente).

**Comportamento existente**
- 1 sessão por projeto, 1 janela por worktree, 1 pane por papel.
- `destroy-unattached off` — é o que permite o agente continuar trabalhando com o browser
  fechado; sem isso o tmux derruba a sessão quando o último cliente sai.
- **Defesa de locale UTF-8**: sob locale não-UTF-8 o tmux reescreve o byte TAB da saída
  `-F` como `_`; todo o parse de `list-windows` falha em silêncio e **toda janela some**.
- **Defesa de herança de environment**: o primeiro comando que sobe o servidor fixa o
  environment global para toda a vida dele; um `.env` de projeto capturado ali vaza para
  todo pane de todo projeto. `scrubLeakedGlobalEnv()` cura servidores já contaminados, uma
  vez por processo.
- `list-windows -a` numa chamada só (ADR-13).
- 4 erros de `kill-window` tolerados, incluindo o de conexão com socket inexistente.
- `send-keys -l --` seguido de `send-keys C-m`: duas chamadas, porque `-l` digita o texto
  literalmente e a quebra de linha precisa ir separada.
- Casos especiais que NÃO podiam se perder: os dois de defesa acima, a tolerância do
  `kill-window`, e a criação de sessão + `set-option` numa **única** invocação.

**Implementação no Issue Flow**
`src/runtime/tmux/{gateway,names,locale,env,layout,index}.ts` — estratégia: **PORT**,
com `layout.ts` em **ADAPT**.

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| `Bun.spawnSync` → `run()` com **`extendEnv: false`**, tudo assíncrono | `run()` é o único caminho de shell do projeto. A flag é obrigatória: o `execa` mescla `process.env` por default e o upstream depende do env ser **substituído** — sem ela o `stripProjectEnv` não faz nada, em silêncio |
| Socket dedicado `-L issue-flow` (ADR-09) | Melhoria de **uma flag** que resolve estruturalmente a classe inteira de bug que o `scrubLeakedGlobalEnv` cura de forma reativa. O scrubbing fica como rede de segurança, porque socket dedicado não ajuda um servidor que este próprio projeto subiu contaminado |
| Nome de sessão por `projectId`, não por hash do path | O Issue Flow já tem identidade estável por remote (`storage/project-identity.ts`), que sobrevive a mover o diretório e é igual em dois clones. O upstream usa hash de path por não ter outra identidade |
| `ensureSessionLayout` distingue `reattach` / `resume` / `fresh` | §27. O upstream mata a janela incondicionalmente, o que faz reabrir um worktree **matar o agente que estava trabalhando nele**. O sinal é a contagem de panes: o tmux remove um pane assim que o comando dele sai |
| `ensureSession` tenta criar primeiro, em vez de perguntar `has-session` antes | §35 orça 30 ms por sessão adicional e cada invocação extra é um spawn de processo que custa metade disso. Medido: **46 ms → 8 ms**. O tmux já responde `duplicate session`; pagar um spawn para descobrir antes dobrava o custo do caso comum |
| `parseWindowSummaries` e os nomes viram módulo próprio | São funções puras e são o que os testes de caracterização comparam; separá-las permite testá-las sem servidor tmux nenhum |
| `countPanes()` acrescentado ao gateway | É o sinal que a decisão de reattach precisa e que o upstream não expõe (ele nunca precisou perguntar) |
| `isAvailable()` acrescentado | ADR-03: uma máquina sem tmux continua funcionando, e o chamador precisa poder perguntar antes de escolher o modo |
| `listWindows()` devolve `[]` quando não há servidor | "Sem servidor" é uma resposta legítima e é a que a reconciliação precisa, não um erro |

**Comportamento deliberadamente NÃO portado**

| O quê | Origem | Por quê |
|---|---|---|
| `createParkedPane()` / `swapPanes()` | `adapters/tmux.ts:295,310` | Implementam as **abas** por worktree do painel do WebMux (`tabs`, `activeTabId`, `forkCounter` em `WorktreeMeta`). São decisão de produto do frontend dele; entram, se entrarem, com §48/§50 — portá-las agora seria mecanismo sem nenhum consumidor |
| A janela default que `new-session -d` cria | — | **Não é omissão, é consequência**: uma sessão sem janelas é destruída pelo tmux, então a janela default é inevitável. O upstream convive com ela; o teste de integração documenta o fato |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `src/runtime/tmux/names.test.ts` | `__tests__/tmux-adapter.test.ts` (parte pura) + locale + env | 19 | ✅ |
| `src/runtime/tmux/layout.test.ts` | `__tests__/session-service.test.ts` + os casos de reattach/resume/fresh | 16 | ✅ |
| `src/runtime/tmux/gateway.integration.test.ts` | `__tests__/tmux-adapter.test.ts` (parte com servidor real) + **C3** de §34 | 12 | ✅ |

Total: **47 casos** (upstream: 20 + 10).

**Orçamentos**

| Métrica | Baseline WebMux | Budget | Medido |
|---|---|---|---|
| `ensureSessionLayout` (2 panes) | 254 ms | ≤ 400 ms | **77 ms** |
| Custo marginal por sessão adicional | 15 ms | ≤ 30 ms | **8 ms** (era 46 ms antes de unir a criação numa invocação) |
| Reconciliação (`list-windows -a`) | 23 ms, O(1) | ≤ 50 ms e O(1) | **6 ms em N=1, 14 ms em N=21** |

---

### Project Registry unificado (fase 2B)

**WebMux original**
`.references/webmux-main/backend/src/adapters/projects-registry.ts` @ d8c9d5f — 65 linhas ·
`backend/src/domain/projects.ts` — 17 linhas ·
`backend/src/domain/policies.ts` (prefixos: `sanitizeProjectPrefix`, `deriveProjectPrefix`,
`RESERVED_PROJECT_PREFIXES`) — 30 das 118 linhas ·
`backend/src/services/project-manager.ts` — 167 linhas ·
`backend/src/services/project-init-service.ts` — 116 linhas ·
`bin/src/project-commands.ts` — 176 linhas ·
rotas de projeto e `autoAddCwd` em `backend/src/server.ts`.

**Comportamento existente**

- **Leitura tolerante do registry.** Arquivo ausente → `[]`; JSON malformado → `[]` com log;
  entradas inválidas filtradas por `isProjectEntry`. Nunca uma exceção: o registry é lido em
  caminhos de boot onde lançar derrubaria algo mais importante que a lista de projetos.
- **Escrita atômica** (`tmp` + `renameSync`), com fs síncrono deliberado para funcionar em
  caminhos de shutdown. Corrige a premissa de §45.0: *estes* registries do WebMux fazem escrita
  atômica; a ausência dela vale para `adapters/fs.ts`.
- **Prefixo derivado, nunca persistido.** Basename sanitizado, sufixo `-2`, `-3`… em colisão,
  e uma lista de reservados para não sombrear as rotas do hub. O laço é limitado a 1000 e cai
  para um sufixo de timestamp — mil colisões não são motivo para travar nem para devolver
  duplicata.
- **`loadPersisted()` nunca é fatal**: a entrada que falha é logada, pulada, e **não é
  re-persistida** — um checkout temporariamente desmontado continua na curadoria.
- **`addEphemeral()`** serve o projeto só neste processo. O motivo está no comentário original e
  não é óbvio: com um registry compartilhado, persistir o cwd faria **outros servidores** passarem
  a servir aquele repositório no próximo restart.
- **Idempotência por raiz resolvida**: adicionar o mesmo repositório duas vezes devolve o projeto
  que já está sendo servido, sem segundo runtime e sem segunda linha.
- **Dois níveis de loop**: *light* para todos os projetos conhecidos, *heavy* só para o ativo,
  alternado por `setActive(prefix, bool)`.
- **Quatro caminhos no `add`**, nesta ordem, cada um existindo por um caso que os outros erram:
  já servido → devolve; setup em voo → manda pollar; já configurado → registra direto; sem
  configuração → `runProjectInit()` assíncrono com fases observáveis.
- **Tracker de fases com TTL**: entradas terminais sobrevivem 60 s para um poller atrasado ainda
  ver o desfecho, e são despejadas depois; entradas em voo nunca expiram.
- **`DELETE` fecha os sockets do projeto ANTES do `manager.remove()`** — depois do `apps.delete`
  o handler global não acha mais o cleanup.
- Casos especiais que NÃO podiam se perder: a leitura tolerante; o motivo do `addEphemeral`; o
  `loadPersisted` não fatal e não re-persistente; a lista de reservados; a ordem dos quatro
  caminhos do `add`; o TTL do tracker; a análise best-effort que nunca deixa o usuário sem
  projeto.

**Implementação no Issue Flow**

`packages/issue-flow/src/storage/projects/prefix.ts` — **PORT** ·
`packages/issue-flow/src/storage/projects/registry.ts` + `src/storage/db/projects.ts` —
**REPLACE** (tabela `projects`, migration 10) ·
`packages/issue-flow/src/runtime/project-manager.ts` — **PORT + ADAPT** ·
`packages/issue-flow/src/runtime/project-runtime.ts` — **ADAPT** ·
`packages/issue-flow/src/runtime/project-init.ts` — **MERGE** com `src/scaffold/` ·
`packages/issue-flow/src/web/projects-api.ts` e `src/web/router.ts` — **ADAPT** ·
`packages/issue-flow/src/commands/project.ts` — **PORT + ADAPT** ·
`packages/issue-flow/src/commands/serve.ts` — **ADAPT**.

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| A chave é `projectId` (`projectIdFromRemote`), não o path | O Issue Flow já tem identidade estável por remote, que sobrevive a mover o diretório e é igual em dois clones. O upstream chaveia por path por não ter outra identidade. `root` vira localizador |
| `projects.json` → tabela `projects` (migration 10: `name`, `added_at`, `last_seen_at`, `source`) | Um segundo arquivo de estado ao lado do SQLite duplicaria os mesmos fatos com uma história de consistência própria. A tabela já existia como âncora de FK |
| A escrita atômica do original vira transação SQLite | Mesmo objetivo — nunca um estado meio escrito — com o mecanismo que a autoridade de estado do projeto já usa |
| Leitura tolerante inclui **não criar** o banco | Abrir o banco o cria. "Quais projetos existem?" não pode ser o que traz o armazenamento à existência: o driver `json` tem um teste que exige que nenhum arquivo de banco apareça |
| A classe inteira virou assíncrona | Resolver raiz e identidade é perguntar ao git. O upstream podia ser síncrono porque lia um JSON e chaveava por path |
| `remove()` rebaixa para `discovered` em vez de apagar a linha | Execuções, artefatos e telemetria estão presos ao `projectId`. Curadoria é uma coluna; apagar de verdade é outro comando, com contrato de segurança próprio |
| `server.reload()` → resolução de prefixo **por request** (`router.ts`) | `Bun.serve().reload()` não existe em `node:http`. A tradução elimina a classe de bug de reload e é o mesmo despacho que o WS faria por `ws.data.prefix` |
| Reservados ampliados para `api`, `ws`, `assets`, **`health`** | Este servidor também responde `/api/health` e serve os assets a partir de `/` |
| Prefixos derivados na ordem **`added_at` crescente** | O primeiro projeto de um dado basename mantém o prefixo sem sufixo quando um homônimo aparece depois. A ordem por recência é para leitura humana, não para roteamento |
| `analyzerAvailable()` passa a significar "a análise pode rodar", e o default é `true` | Upstream perguntava se a CLI do agente estava no PATH para preencher o YAML gerado. Aqui a etapa é uma passagem de descoberta local (`loadRepositoryPolicy`, `cache: false`), sempre disponível; a costura fica para o enriquecimento por agente da fase 3 |
| `scaffold` é o plan-then-apply existente | Ele é não destrutivo e idempotente, o que "escrever o YAML inicial" do upstream não é. Rodar num repositório já configurado é no-op, não reescrita |
| O CLI opera direto no SQLite; o servidor é avisado depois, em best effort | Adaptação **obrigatória** de §47.5: o CLI do Issue Flow não pode exigir servidor. O registry é a autoridade e já foi escrito quando a notificação sai; um monitor fora do ar não é erro (P12) |
| `project use` é recência (`last_seen_at`), não um modo | Evita um segundo arquivo de estado "projeto ativo" que envelheceria sozinho, e é a mesma coluna que ordena a lista em todo lugar |
| `ISSUE_FLOW_PROJECT_DIR` aceita vários caminhos separados por `:`/`;` | Uma unidade `systemd` começa em `/` e não tem cwd útil; uma variável por projeto não sobrevive a um arquivo de unidade |
| Escritas de projeto exigem bind em loopback | ADR-10, a mesma regra que as escritas de configuração já seguem: adicionar um projeto toca o filesystem |
| `web serve` vira alias de `serve`, com um único corpo | `web/AGENTS.md` proíbe uma terceira forma de fazer bind. O lock, o contrato de spawn destacado e o silêncio no caminho feliz não mudam |

**Comportamento deliberadamente NÃO portado**

| O quê | Origem | Por quê |
|---|---|---|
| `adapters/instance-registry.ts` | `backend/src/adapters/instance-registry.ts` | O `web.lock` do Issue Flow é mais forte (exige pid vivo **e** `/api/health` **e** `instanceId`) e o próprio upstream marca o dele como sensor transitório de migração |
| `bin/src/migrate.ts` / `webmux project migrate` | `bin/src/migrate.ts` | Funde servidores antigos de projeto único num só. Nunca existiu um servidor Issue Flow por projeto — não há de onde migrar |
| `closeProjectSockets()` antes do `manager.remove()` | `backend/src/server.ts` | Não há socket por projeto ainda: o transporte de terminal chega na fase 8. A ordem correta está registrada em comentário no `removeProject`, para quando houver |
| Worktree, tmux e sandbox no `ProjectRuntime` | `backend/src/runtime.ts` | São das fases 5, 6 e 12. Escrevê-los aqui criaria uma segunda implementação mais fraca da mesma responsabilidade (invariante 13) |
| Loops *light*/*heavy* com trabalho real | `backend/src/services/*-service.ts` | O contrato dos dois níveis foi portado (`ProjectLoopController`, `setActive`), mas reconciliação, GC de worktree e poll de PR/CI pertencem às fases 5, 11 e 14. O default é no-op |
| `EmptyProjects.svelte` / onboarding do painel | `frontend/src/lib/EmptyProjects.svelte` | O painel atual é vanilla e só sai com §50.7 (ADR-18). O seletor e a visão "Trabalho ativo" foram acrescentados sobre ele, sem trocar de stack |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `src/storage/projects/prefix.test.ts` | `__tests__/domain-policies.test.ts` (parte de prefixo) | 10 (8 portados + 2 novos) | ✅ |
| `src/storage/projects/registry.test.ts` | `__tests__/projects-registry.test.ts` | 10 (7 portados, adaptados + 3 novos) | ✅ |
| `src/runtime/project-manager.test.ts` | `__tests__/project-manager.test.ts` | 13 (11 portados + 2 novos) | ✅ |
| `src/runtime/project-init.test.ts` | `__tests__/project-init-service.test.ts` | 7 (6 portados + 1 novo) | ✅ |
| `src/storage/db/projects.test.ts` | — (migration 10: banco novo, banco em v9, reabertura, leitura retro) | 4 | ✅ |
| `src/web/router.test.ts` | `backend/src/server.ts` (despacho por prefixo) | 8 | ✅ |
| `src/web/projects-api.test.ts` | `backend/src/server.ts` (rotas de projeto) | 13 | ✅ |
| `src/commands/project.test.ts` | `bin/src/project-commands.ts` | 15 | ✅ |
| `src/commands/serve.test.ts` | `backend/src/server.ts` (ordem de boot, `autoAddCwd`) | 9 | ✅ |
| `src/execution/registry.test.ts` (P10 + rótulo) | — | +2 | ✅ |
| characterization P1–P12 | §47.7 | — | ✅ |

Total: **91 casos**, dos quais **32 portados do upstream** (8 + 7 + 11 + 6).

Cobertura de P1–P12, por arquivo:

| # | Onde |
|---|---|
| P1 | `runtime/project-init.test.ts`, `web/projects-api.test.ts`, `commands/project.test.ts` |
| P2 | `storage/projects/registry.test.ts`, `runtime/project-manager.test.ts`, `web/projects-api.test.ts`, `commands/project.test.ts` |
| P3 | `storage/projects/prefix.test.ts`, `runtime/project-manager.test.ts`, `web/router.test.ts` |
| P4 | `storage/projects/prefix.test.ts`, `web/router.test.ts` |
| P5 | `runtime/project-manager.test.ts`, `commands/serve.test.ts` |
| P6 | `runtime/project-manager.test.ts`, `commands/serve.test.ts` |
| P7 | `commands/project.test.ts` |
| P8 | `storage/projects/registry.test.ts`, `commands/project.test.ts` |
| P9 | `storage/projects/registry.test.ts`, `runtime/project-manager.test.ts`, `web/projects-api.test.ts`, `commands/project.test.ts` |
| P10 | `execution/registry.test.ts` |
| P11 | `runtime/project-manager.test.ts`, `commands/serve.test.ts` |
| P12 | `commands/project.test.ts` |

**Orçamentos**

| Métrica | Budget | Medido |
|---|---|---|
| Boot do CLI | ≤ 250 ms | **120 ms** (mediana de 5, `node dist/cli.js --version`) |
| Latência output → tela | ≤ 250 ms p95 | inalterada — o transporte push de `/api/stream` não foi tocado |

---

### Agent wrappers TTY e sessões (Fase 7)

**WebMux original**
`.references/webmux-main/backend/src/services/agent-service.ts` @ d8c9d5f — 252 linhas ·
`adapters/terminal.ts` (`sendPrompt`, `interruptPrompt`, `sendKeys`) — ~110 das 457 ·
`domain/model.ts` (`WorktreeConversationMeta`) · `adapters/session-discovery.ts` — ~105.
Base canônica por `§45.1-L`: **Issue Flow** para a camada de agentes inteira; do WebMux
absorve-se **apenas** o conceito de agente custom, o modo TTY e o `--resume`.

**Comportamento existente**
- O prompt vai **depois de `--`** — e o comentário do upstream explica: assim a TUI recebe
  o prompt como primeiro turno, antes do loop de input subir, o que evita a corrida
  paste/Enter contra uma TUI que ainda não está pronta.
- `codex` sempre com `--enable hooks`.
- `claude --resume <id>` / `--continue`; `codex resume <id>` / `resume --last`.
- Fork: `claude --resume <pai> --fork-session [--session-id <filho>]`; `codex fork <pai>`.
- `set -a; . runtime.env; set +a` antes da invocação.
- Agente custom: template `startCommand`/`resumeCommand` com `${PROMPT}` etc. substituídos
  por **referências a variáveis exportadas**, nunca pelos valores.
- `sendPrompt`: `load-buffer` (texto por stdin, `\0` removido) + `paste-buffer -rp -d` +
  `Enter` — porque `send-keys -l` entrega caractere a caractere e a TUI reage no meio.
- Casos especiais que NÃO podiam se perder: os quatro flags do `paste-buffer`, a remoção
  do `\0`, o `--` antes do prompt, o `--enable hooks`, e o fato de os valores do agente
  custom viajarem por variável e não por substituição.

**Implementação no Issue Flow**
`src/agents/tty.ts` (**ADAPT**) · `src/agents/custom.ts` (**PORT**) ·
`src/runtime/terminal/input.ts` (**PORT**) · `src/agents/session/{types,reuse,store}.ts`
(**ADAPT**) · migration 12 (`agent_sessions`) · `src/runtime/tmux/gateway.ts` ganhou
`loadBuffer`/`pasteBuffer`/`sendLiteral`/`sendKeys`/`sendHexKeys`.

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| String de shell + `quoteShell` → **argv**, serializado uma única vez na fronteira do tmux | ADR-04 e `§45.1-L`. O `send-keys` só aceita string, mas isso é *serialização* de um argv, não montagem por concatenação: há uma função de quoting, aplicada a todo elemento sem exceção. `tty.integration.test.ts` prova o round-trip por um `/bin/sh` real com nove formas de prompt hostil |
| `yolo: boolean` → permissão semântica de 3 níveis | `§45.3` lista `yolo: boolean` como forma degradada. `autonomous` → skip; `read-only` → `--permission-mode plan`; `workspace` → nada |
| `WEBMUX_AGENT_*` → `ISSUE_FLOW_AGENT_*` | Nomeação do projeto |
| `WorktreeConversationMeta` (dentro do `meta.json`) → tabela `agent_sessions` | §27 separa os sete conceitos; a sessão é a única das quatro entidades que este projeto persiste, e o veículo é SQLite (`§45.2-G`) |
| `run_id`/`phase`/`story_id` **nuláveis** | ADR-16 — é o que permite sessão livre sem um segundo modelo de execução. A Fase 9B usa; o schema já aceita |
| Guarda de reuso de sessão (`assertSessionReuseAllowed`) acrescentada | ADR-07. O WebMux não tem o conceito de fase de revisão, então não tem o que proteger; aqui a independência é o mecanismo por trás da palavra "verified", e uma configuração que peça reuso é **erro**, não preferência |
| Sessão livre nunca é adotada pela pipeline | Não está no upstream: é consequência de ADR-16 + ADR-07. Uma pessoa abriu aquela sessão e provavelmente ainda está nela |
| Linha de storage é **narrowed**, não *cast* | O banco pode conter um `phase`/`provider` escrito por uma release mais nova; um cast levaria isso a um `switch` exaustivo |
| `submitDelayMs` e `submit: false` explícitos | O upstream tem o delay; o `submit: false` é acrescentado para deixar texto no input sem enviar, que é o que a Fase 9 (human-in-the-loop) precisa |

**Comportamento deliberadamente NÃO portado**

| O quê | Origem | Por quê |
|---|---|---|
| `adapters/claude-cli.ts` (767 LOC) e `codex-app-server.ts` (862 LOC) | §22 | São o **canal estruturado** — leitura de conversa e streaming — e portá-los junto com o wrapper TTY misturaria duas responsabilidades numa fase de alto risco. **Não é mais pendência:** foram portados na Fase 7B, com `conversation-export-service.ts` (§45.1 linha 20). Ficha em [Canal estruturado de conversa](#canal-estruturado-de-conversa--agentssessionclaude-streamclaudecodexcodex-conversationexportts-fase-7b), que também registra como a sobreposição com `core/stream.ts` foi convergida num só parser (invariante 13) |
| `session-discovery.ts` (varredura de `~/.claude/**` e `~/.codex/**`) | `adapters/session-discovery.ts` | Descobrir conversas no disco do provider é útil para *reconciliação* (Fase 11), não para iniciar uma. O id de conversa aqui vem do próprio provider via hook/resultado |
| `DOCKER_PATH_FALLBACK` embutido no bootstrap | `agent-service.ts:4` | O parâmetro `extraPathEntries` existe e é genérico; a lista concreta do container pertence à Fase 12, que é quem sabe o que a imagem tem |
| `agentTerminalStale` e a lógica de `resolveCodexResumeConversationId` | `lifecycle-service.ts:105` | Depende de `tabs`/`forkCounter`, que são estado de UI do painel do WebMux (§48/§50) |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `src/agents/tty.test.ts` | `__tests__/agent-service.test.ts` — **C4** | 20 | ✅ |
| `src/agents/custom.test.ts` | `__tests__/agent-service.test.ts` (custom) | 11 | ✅ |
| `src/runtime/terminal/input.test.ts` | `__tests__/terminal-adapter.test.ts` — **C5** | 11 | ✅ |
| `src/agents/session/reuse.test.ts` | novo — ADR-07 e ADR-16 | 15 | ✅ |
| `src/agents/session/store.test.ts` | novo — fronteira de storage | 8 | ✅ |
| `src/agents/tty.integration.test.ts` | **C4** contra `/bin/sh` real e **C5** contra tmux real | 13 | ✅ |
| `src/storage/db/migrations.test.ts` | migration 12 em banco novo, existente e reaberto | (no caso existente) | ✅ |

Total: **78 casos** (upstream: 19 de `agent-service.test.ts` + 10 de `terminal-adapter.test.ts`).

**Orçamentos**

| Métrica | Baseline WebMux | Budget | Medido |
|---|---|---|---|
| Entrega de prompt subsequente (20 KB) | 35 ms | ≤ 80 ms | coberto pelo caso de 64 KB de `tty.integration.test.ts`, que entrega o bloco inteiro; a medição em milissegundos entra com o transporte do terminal (Fase 8), onde há um caminho de ponta a ponta para cronometrar |

### Sandbox Docker — paridade (Fase 12)

**WebMux original**
`.references/webmux-main/backend/src/adapters/docker.ts` @ d8c9d5f — 384 linhas
`.references/webmux-main/sandbox-image/` @ d8c9d5f — 2 arquivos, ~80 linhas

**Comportamento existente**

- `buildDockerRunArgs()` monta a linha de comando inteira do `docker run` a partir de um
  perfil docker, dos serviços com porta alocada e do `runtimeEnv`. É a função que o teste
  de caracterização **C7** compara literalmente.
- `launchContainer()` resolve o que existe no host (credenciais, socket SSH), gera o nome
  do container, roda `docker run -d` com teto de tempo e limpa o container parado quando
  o comando falha.
- `findContainer()` / `removeContainer()` selecionam por prefixo de branch, exigindo que o
  que vem depois do prefixo seja **apenas** o timestamp.
- A imagem é `debian:bookworm-slim` + Node 22 + `gh` + Rust + `asciinema` + Bun +
  Playwright/Chromium + AWS CLI + Claude Code + Codex + Mermaid CLI. `entrypoint.sh` roda
  `bun install` quando há `bun.lock` e faz `exec "$@"` — ele **não** é o entrypoint da
  imagem, é chamado explicitamente.
- Casos especiais que NÃO podem se perder:
  - `--mount type=bind` para o socket SSH — com `-v` o Docker tenta `mkdir` no caminho do
    socket e a subida falha;
  - o socket só é encaminhado quando é world-accessible, porque o daemon é outro processo;
  - `--user <hostUid>:<hostGid>`, senão os arquivos criados no worktree montado ficam do
    root e o usuário não consegue limpá-los;
  - portas publicadas **apenas** em `127.0.0.1`;
  - `reservedKeys` que nem o `envPassthrough` nem o `runtimeEnv` conseguem sobrescrever —
    `SSH_AUTH_SOCK` está no conjunto porque a variável só faz sentido junto do mount;
  - `GIT_CONFIG_COUNT=2` com `safe.directory` para os **dois** diretórios: o worktree e o
    repositório principal, cujo `.git` o worktree aponta;
  - `isValidEnvKey()` / `isValidPort()` descartam entrada malformada em vez de citá-la;
  - montagens explícitas do perfil **vencem** as montagens de credencial do mesmo
    `guestPath`;
  - idempotência por branch em `launchContainer` — dois containers no mesmo worktree são
    dois agentes escrevendo os mesmos arquivos;
  - o socket do Docker **não** é montado, e isso é deliberado.

**Implementação no Issue Flow**
`packages/issue-flow/src/runtime/sandbox/docker.ts` — estratégia: PORT
`packages/issue-flow/sandbox/` — estratégia: PORT

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| `Bun.spawn` → `run()` (`src/utils/shell.ts`), tudo assíncrono | `run()` é o único caminho de shell do projeto; é o que faz a allowlist destrutiva e a política de retry valerem também aqui (§45.3). Nunca `execa` direto, nunca string de shell |
| A corrida manual contra `Bun.sleep(60s)` vira `AbortController` + `cancelSignal` do execa | Mesmo teto de 60 s e mesma limpeza (`docker rm -f` + erro), sem um segundo caminho de processo. A **flag** — não o tempo decorrido — é o que distingue timeout de falha comum, que são reportados de forma diferente |
| `Bun.env[key]` sai de dentro de `buildDockerRunArgs` e entra como `hostEnv` no contexto | O próprio comentário do upstream diz que a função é pura e que "todo I/O é resolvido pelo chamador"; `Bun.env` era o único vazamento. Fechá-lo é o que torna **C7** uma comparação literal sem estado de processo, e é o motivo de a paridade desta fase ser verificável numa máquina sem docker |
| Os 7 parâmetros posicionais viram `(opts, context: DockerRunArgsContext)` | Ordem de parâmetros é decisão reversível (§9). O corpo da função continua idêntico linha a linha; o que muda é que `home`, `name` e `sshAuthSock` — três strings adjacentes — deixam de poder ser trocados por engano |
| `log.warn` → callback `onWarn` (e `onInfo`/`onError` no gateway) | Não há logger global neste nível e a função é pura. Segue o padrão de `worktree/gc.ts` |
| `diagnostics: false` nas sondas (`docker version`, `docker ps`, `docker rm`) e `true` no `docker run` | Numa máquina sem daemon o `docker version` e o `docker ps` respondem não-zero como resultado legítimo, e um diagnóstico por sonda enterraria a única falha que importa. O `docker run` é falha de verdade, com stderr de verdade — perdê-la seria exatamente a regressão que §45.3 descreve |
| Prefixo de container `wm-` → `if-` | Três caracteres, como o original, então o orçamento de 46 caracteres do segmento de branch continua exato. **Não** é cosmético: `findContainer` e `removeContainer` selecionam por prefixo e removem à força o que acham — compartilhar o prefixo do upstream faria este projeto apagar containers de uma instalação real do WebMux na mesma máquina |
| `sanitiseBranchForName` → `sanitizeBranchForName` | Consistência com `sanitizeBranchName` e `sanitizeTmuxNameSegment`, que já existem no repositório |
| `DockerProfileConfig` / `ServiceConfig` de `adapters/config.ts` viram `SandboxProfileConfig` / `SandboxServiceConfig`, o subconjunto estrutural que este módulo usa | A configuração de profiles é da Fase 10 (§16, §19). Declarar a forma aqui mantém a Fase 12 autocontida; o tipo mais rico da Fase 10 só precisa continuar atribuível a este |
| `findContainer` e `isAvailable` entram no `DockerGateway` | `findContainer` já era exportada solta no upstream e a reconciliação (Fase 11) precisa dela pela interface; `isAvailable` é ADR-03 — uma máquina sem docker precisa poder ser perguntada antes de escolher o modo |
| A URL do AWS CLI passa a derivar a arquitetura de `dpkg --print-architecture` | O literal `x86_64` do upstream quebra o build inteiro num host arm64, que é a máquina de desenvolvimento mais comum aqui. Menor mudança que torna o porte efetivamente construível (§3.1, exceção "tornar o port executável") |

**Comportamento deliberadamente NÃO portado**

| O quê | Origem | Por quê |
|---|---|---|
| `BunDockerGateway` (a classe) | `adapters/docker.ts:63` | Era só um wrapper de duas linhas sobre as funções livres. `createDockerGateway()` é a forma que o resto de `src/runtime/` usa (`createTmuxGateway`, `createGitWorktreeGateway`) |
| Endurecimento: `--cap-drop=ALL`, `--security-opt no-new-privileges`, `--pids-limit`, `--memory`, política de rede, `SSH_AUTH_SOCK` opt-in por profile, imagem mínima como default | §14 etapa 2 | **Fase 13.** ADR-12 proíbe portar e endurecer na mesma mudança: com as duas coisas juntas, uma regressão fica indistinguível de um bug. Um teste afirma que nenhuma dessas flags está presente, para que acrescentar uma aqui falhe alto |
| `yolo?: boolean` do `ProfileConfig` | `domain/config.ts:46` | §45.3: permissão semântica por fase é garantia do Issue Flow, e um booleano no perfil é exatamente a forma degradada que a tabela lista. O módulo não precisa dele para montar os argumentos, então ele não entra em `SandboxProfileConfig` |
| `entrypoint.sh` reconhecer `package-lock.json` / `pnpm-lock.yaml` | `sandbox-image/entrypoint.sh` | Melhoria óbvia para os repositórios-alvo deste projeto e registrada como tal, mas é mudança de comportamento: paridade primeiro (ADR-12) |
| A imagem continuar do tamanho que é (Rust + Playwright + AWS CLI) | `sandbox-image/Dockerfile.sandbox` | Reduzir superfície é a etapa 2 de §14. Aqui a imagem é a do upstream, com uma linha corrigida para poder ser construída |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `src/runtime/sandbox/docker.test.ts` | `__tests__/docker.test.ts` (23 casos, `bun:test` → `vitest`) + C7 + os casos que o upstream não podia escrever | 45 | ✅ |
| `src/runtime/sandbox/docker.integration.test.ts` | novo — daemon real, `it.runIf` com a sonda síncrona no topo do módulo | 8 | ✅ |
| characterization **C7** | §34 | — | ✅ |

**C7 conferido contra o upstream, não contra a transcrição.** A função original foi
executada sob `bun` a partir de `.references/webmux-main/` (somente leitura) e a lista de
argumentos comparada com `toEqual` à do porte, para um lançamento completo (portas,
passthrough, socket SSH, montagens extras, colisão de credencial) e para o mínimo. As duas
listas são idênticas. O prefixo do nome não entra na comparação porque `name` é parâmetro.

**Orçamentos**

| Métrica | Budget | Medido |
|---|---|---|
| `buildDockerRunArgs` | — (função pura) | **0,0016 ms** (mediana de 5 × 1000) |
| `launchContainer` com imagem quente | — (§35 não orça o sandbox; T0→T4 ≤ 600 ms é o teto vizinho) | **158 ms** (mediana de 3) |

---

### Terminal web — backend (Fase 8)

**WebMux original**
`.references/webmux-main/backend/src/adapters/terminal.ts` @ d8c9d5f — 457 linhas ·
`backend/src/server.ts` (handlers de WS, `sendWs`, linhas 412–424, 459–472, 2200–2320) — ~180.
Base canônica: **WebMux** (o Issue Flow não tinha terminal).

**Comportamento existente**
- **Sessão agrupada por espectador** (`new-session -t <dona>`): cada viewer tem cliente,
  janela ativa e tamanho próprios, compartilhando as janelas da sessão do projeto. É o que
  permite N espectadores sem um redimensionar o outro.
- `window-size latest` na sessão **dona** — sem isso a janela encolhe para o menor cliente.
- **Unzoom defensivo**: o estado de zoom é compartilhado entre sessões agrupadas.
- `stty` antes do attach, para o primeiro frame já vir no tamanho certo.
- Attach **preguiçoso**: o primeiro `resize` é o sinal de attach.
- Protocolo 4 in / 4 out, com **prefixo de 1 caractere** no caminho quente para evitar
  `JSON.stringify` por chunk.
- Ring de scrollback de 1 MB.
- Wrapper de PTY: `python3` no macOS, `script` no Linux com `python3` atrás.
- Casos especiais que NÃO podiam se perder: os quatro primeiros itens desta lista.

**Implementação no Issue Flow**
`src/runtime/terminal/{attach,pty,scrollback}.ts` · `src/web/terminal-ws.ts` ·
`src/web/server.ts` (rota `GET /api/terminal/token` e o wiring).

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| `Bun.serve` WS → **`ws`** sobre o `node:http` já existente | `node:http` não tem servidor WebSocket; §15 especifica `ws`. Dependência nova, justificada e adicionada ao manifest e ao lockfile |
| **Autenticação obrigatória** (ADR-10) | É a única parte do WebMux explicitamente rejeitada. Superfície só existe em loopback, exige token no handshake e valida `Origin`. Sem o `Origin` check, qualquer site que o usuário visite abriria um shell na máquina dele assim que adivinhasse a porta |
| **Backpressure** acrescentado | §15. O upstream nunca consulta `bufferedAmount`; um agente que despeja megabytes enche o buffer de envio até travar o event loop. Acima do teto, o output intermediário é descartado e o cliente é informado de quantos bytes. O offset **continua avançando**, então descartar não dessincroniza a numeração |
| **Replay incremental** acrescentado | §15. O upstream reenvia 1 MB inteiro a cada reconexão, e o browser reconecta em `visibilitychange`, `focus` e `online`. Frame `o<offset>\n<dados>`: um `indexOf` no cliente, nenhum JSON dos dois lados |
| Eviction do ring por **chunk inteiro** | Cortar um chunk arrisca partir um caractere multibyte ou uma sequência de escape ao meio, e um terminal que recebe meia sequência de escape renderiza lixo dali em diante |
| `node-pty` probado com **spawn real**, não com `require` | O modo de falha que o fallback existe para cobrir é um módulo que importa bem e falha em `pty.fork`. Foi exatamente o que aconteceu na máquina do porte (`posix_spawnp failed`) |
| Socket do viewer nomeado `if-view-<pid>-<rnd>` | Escopo por pid: dois servidores no mesmo socket não matam as sessões um do outro |
| `resize` via `tmux resize-window` | O pty roda um *cliente* tmux; quem muda de tamanho é a janela que o tmux desenha |

**Comportamento deliberadamente NÃO portado**

| O quê | Origem | Por quê |
|---|---|---|
| Ausência de autenticação | `Bun.serve` sem `hostname` | ADR-10 — rejeição explícita |
| `sendKeys` e `selectPane` executados | protocolo C→S | Aceitos pelo parser (paridade de protocolo) mas respondidos com erro: ambos operam na sessão **dona**, não no pty do viewer, e pertencem à camada de runtime que possui esses alvos. Reportado, nunca ignorado em silêncio |
| Gravação opcional em `asciicast v2` | §15 (mencionado como opcional) | Não é paridade; é melhoria. Fica registrada |
| `cleanupStaleSessions` global do upstream | `terminal.ts:190` | Portado como `cleanupStaleViewerSessions`, mas restrito às sessões de **outros pids**: matar as do próprio processo derrubaria viewers vivos |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `src/runtime/terminal/scrollback.test.ts` | ring do upstream + os offsets de §15 | 14 | ✅ |
| `src/runtime/terminal/attach.test.ts` | `__tests__/terminal-adapter.test.ts` (partes puras), comparação **literal** do comando de attach | 8 | ✅ |
| `src/web/terminal-ws.test.ts` | protocolo, framing e admissão | 12 | ✅ |
| `src/web/terminal-ws.integration.test.ts` | **C6**, **C9**, autenticação (ADR-10), replay incremental, budget de reconexão | 12 | ✅ |
| `src/web/server.test.ts` (bloco do terminal) | a superfície só existe em loopback | 3 | ✅ |

Total: **49 casos** (upstream: 10 de `terminal-adapter.test.ts`).

**Orçamentos**

| Métrica | Baseline WebMux | Budget | Medido |
|---|---|---|---|
| Reconexão de terminal | 28 ms + replay | ≤ 100 ms | **26 ms** (mediana de 5) |

**Dependências novas**
`ws` (runtime, `^8.21.3`) e `@types/ws` (dev) — `node:http` não tem servidor WebSocket.
`node-pty` em **`optionalDependencies`**, com o fallback `script`/`python3` como caminho
garantido; nesta máquina o `node-pty` instala e falha em `pty.fork`, que é precisamente o
cenário que o fallback cobre.

---

### Reconciliação de estado (Fase 11)

**WebMux original**
`.references/webmux-main/backend/src/services/reconciliation-service.ts` @ d8c9d5f — 263
linhas · `.references/webmux-main/backend/src/services/session-restore-service.ts` @ d8c9d5f
— 117 linhas.

**Comportamento existente**
- `ReconciliationService.reconcile()` reconstrói o `ProjectRuntime` **sob demanda**, com
  janela de frescor de 500 ms e uma promise `inFlight`: uma chamada que chega durante um
  passo entra nesse passo em vez de abrir um segundo.
- Uma única leitura agregada de `tmux list-windows -a` por passo; a janela de cada worktree
  é encontrada por busca em memória sobre essa lista (ADR-13).
- `mapWithConcurrency(…, 4)` limita o único trabalho que é genuinamente por worktree
  (`readWorktreeStatus`), para que uma árvore com dezenas de worktrees não abra dezenas de
  processos de git de uma vez.
- **Remove da projeção tudo que não foi visto** — a projeção nunca acumula lixo.
- `saveOpenSessionsSnapshot()` nunca sobrescreve o snapshot com um conjunto vazio: depois
  de um reboot o servidor sobe antes de qualquer sessão ser reaberta, e escrever a lista
  vazia apagaria exatamente o dado de que o `restore` precisa.
- `computeOpenBranches()` ignora janelas de **outras** sessões tmux: o servidor divide o
  socket com as sessões do próprio usuário, e uma janela homônima em outra sessão não é
  nossa.
- Casos especiais que NÃO podiam se perder: o `try/catch` em volta de `listWindows()` (sem
  tmux = nenhuma janela, não uma falha do passo); a recusa de chamar git contra um caminho
  que o próprio git já não lista (o crash `ENOENT` que o teste upstream
  *"ignores stale worktree registrations whose directory no longer exists"* documenta); a
  janela de frescor **e** a promise `inFlight` como mecanismos distintos — a primeira evita
  repetição, a segunda evita concorrência.

**Implementação no Issue Flow**
`packages/issue-flow/src/runtime/reconcile.ts` — estratégia: **ADAPT**.

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| `ProjectRuntime` (projeção com `meta.json` como fonte) → projeção em memória alimentada por `createWorktreeManager().list()` | O vínculo durável já vive em SQLite (§45.2-G). O join git ⋈ banco — incluindo o estado `orphaned` — já está resolvido no worktree manager; refazê-lo aqui seria a segunda implementação que o invariante 13 proíbe |
| `readWorktreeMeta(gitDir)` por worktree → `StoredWorktree` lido em **uma** consulta | Um `readFile` por entidade é o mesmo erro de forma que o ADR-13 combate no tmux |
| `PortProbe` e `buildServiceStates` | Ficaram fora: `src/runtime/services.ts` é da Fase 10 e é quem responde por saúde de serviço. A reconciliação reporta as **portas alocadas** direto do vínculo, porque §30 dá a autoridade sobre alocação ao SQLite; sondar um socket diz que algo escuta, não a qual alocação pertence |
| `DockerGateway.findContainer(branch)` → porta `ContainerSource.listRunningContainerNames()` | `findContainer` é um `docker ps` por branch. A reconciliação pede a lista inteira uma vez e filtra em memória, reusando `containerNamePrefix`/`selectBranchContainers` do módulo de sandbox (ADR-13) |
| Docker indisponível → `container: null` em vez de "nenhum container" | Um daemon que não responde não é prova de que os containers morreram. `null` diz *desconhecido*; a alternativa reportaria tudo morto a cada restart do Docker |
| `readOpenSessionsState`/`writeOpenSessionsState` (`Bun.write` direto) → `writeFileAtomic` | §45.3: escrita atômica é garantia do Issue Flow. Um crash no meio da escrita não pode deixar um arquivo truncado onde o restore espera uma lista |
| `open-sessions.json` em `<gitdir>/webmux/` → `<gitdir>/issue-flow/open-sessions.json` | Mesmo lugar dos demais artefatos de runtime, o que torna impossível commitar estado de execução (invariante 17) |
| `buildProjectSessionName(repoRoot)` (hash do path) → `buildProjectSessionName(projectId)` | Decisão já tomada em `src/runtime/tmux/names.ts` (§13, mudança 3): a identidade sobrevive a mover o diretório |
| Sessão de agente ganha `status` e ação de recuperação | O upstream não tem `AgentSession` persistida. Aqui a divergência entre a linha viva e a janela morta é o que produz `orphaned` (ADR-08), com registro em `audit_log` |
| `reconcile()` retorna `ReconcileResult` em vez de `void` | O upstream muta um objeto compartilhado; aqui o passo é uma função sobre a projeção, e quem chama precisa saber se o passo rodou, o que foi orfanado e o que saiu da projeção |
| `appendAuditEntry`/`listAuditEntries` acrescentados a `src/storage/db/repository.ts` | §30 exige que a sessão órfã seja "encerrada e registrada em `audit_log`". A tabela já existia (usada pelo histórico de branch); faltava o append genérico. Aditivo — nenhuma função existente mudou |

**Comportamento deliberadamente NÃO portado**

| O quê | Por quê |
|---|---|
| `buildServiceStates()` + `PortProbe` | Responsabilidade de `src/runtime/services.ts` (Fase 10). Portar aqui produziria uma segunda sonda de porta (invariante 13) |
| `readWorktreePrs()` / `prs` na projeção | A camada de PR já existe em `src/issues/github/` com cache ETag (Fase 14). A reconciliação não é o lugar de uma terceira leitura de `gh` |
| `tabs`, `activeTabId`, `oneshot`, `label`, `agentTerminalStale` do `WorktreeMeta` | São campos da UI do upstream. Os que sobrevivem já vivem em `StoredWorktree`; a projeção expõe o vínculo inteiro em vez de recopiar campo a campo |
| `makeUnmanagedWorktreeId(path)` (`unmanaged:<path>`) | Um id sintético chaveado por path é exatamente o que §47.2 rejeita. Um worktree que o banco nunca vinculou aparece com `worktreeId: null` e `state: 'unmanaged'` — a ausência do vínculo é a informação, e inventar um id a esconderia |
| `startSessionSnapshotMonitor()` (o loop de 30 s) | `startSerializedInterval` já é a primitiva única de loop periódico (`src/utils/async.ts`, §45.2-J) e `saveOpenSessionsSnapshot` é a função que o loop chamaria. Quem liga o monitor é a fase que possui o servidor; um segundo loop aqui não teria dono |
| `resolveBranch()` com fallback para `basename(entry.path)` | O manager de worktree já filtra entradas sem branch antes de listar; o fallback do upstream existe porque lá a lista bruta chega até a reconciliação |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `src/runtime/reconcile.test.ts` | `__tests__/reconciliation-service.test.ts` (4 casos) + `__tests__/session-restore-service.test.ts` (6 casos), `bun:test` → `vitest`, mais a matriz de §30 | 40 | ✅ |
| `src/runtime/reconcile.integration.test.ts` | novo — servidor tmux real, `it.runIf` com a sonda síncrona no topo do módulo | 2 | ✅ |

Os quatro casos de `reconciliation-service.test.ts` reaparecem como
*"takes the set of worktrees from git…"* + *"takes window liveness and pane count from tmux"*
(o caso de reconciliação completa, dividido por autoridade), *"never probes git against a
path git no longer lists"* (o `ENOENT`), *"takes the set of worktrees from git, including
the ones nothing bound"* (o id sintético, agora `worktreeId: null`) e os três casos de
*"freshness window and coalescing"* (que o upstream escreve como um só). Os seis de
`session-restore-service.test.ts` reaparecem inteiros em *"open sessions snapshot"* — menos
o caso *"excludes the project root worktree and bare entries"*, cuja exclusão já é feita
por `createWorktreeManager().list()` e é testada lá.

**Orçamentos**

| Métrica | Budget | Medido |
|---|---|---|
| `reconcile()` com N=21 worktrees/janelas | ≤ 50 ms **e O(1) em N** (§35) | **13 ms** (melhor de 9, máquina ociosa; 23 ms mediana) · N=1: **5 ms**. Sob a suíte de integração inteira em paralelo: 12 ms → 14 ms |
| Chamadas a `tmux list-windows -a` por passo | 1, independentemente de N (ADR-13) | **1** com N=1 e **1** com N=40 |
| Chamadas a `docker ps` por passo | 1, independentemente de N (ADR-13) | **1** com N=25 |

---

### Profiles e panes (Fase 10)

**WebMux original**
`.references/webmux-main/backend/src/adapters/config.ts` @ d8c9d5f — 682 linhas, das quais
a fatia de profiles/panes: `DEFAULT_PANES` (`:41`), `parsePane`/`parsePanes` (`:127–:170`),
`parseMounts` (`:172`), `parseProfile`/`parseProfiles` (`:187–:222`), a família
`clonePanes`/`cloneMounts`/`cloneProfile`/`cloneProfiles` (`:84–:110`),
`getDefaultProfileName` (`:334`), `isDockerProfile` (`:330`) e `expandTemplate` (`:680`).
Os tipos vêm de `domain/config.ts` (`ProfileConfig`, `PaneTemplate`, `MountSpec`).

**Comportamento existente**
- Um profile responde a três perguntas: qual runtime (`host`/`docker`), como é a janela
  (`panes`) e o que o agente pode fazer (`yolo`). Nada mais.
- **Nenhum parser lança.** Pane inutilizável é descartado, profile inutilizável cai no
  default, seção que não é objeto é lida como ausente. Um erro de digitação custa um aviso,
  nunca a execução.
- **Toda leitura devolve cópia nova.** O upstream tem um teste exatamente para isso: dar
  `push` no `envPassthrough` devolvido por uma carga não pode aparecer na carga seguinte.
  Entregar o objeto default compartilhado transforma a mutação de um chamador na
  configuração de todos.
- **Um profile chamado `sandbox` assume `runtime: docker`** mesmo sem declarar. É o único
  nome com tratamento especial no upstream.
- `planSessionLayout()` é pura e recebe os templates; `ensureSessionLayout()` é a única
  parte com I/O. A separação é do upstream e foi preservada na Fase 6.
- Casos especiais que NÃO podem se perder: o pane `kind: command` sem `command` é
  **descartado** (um pane que abriria um shell onde se esperava um serviço é pior que um
  pane visivelmente ausente); `yolo: false` não deixa rastro nenhum no profile; a lista de
  panes vazia volta para o default em vez de produzir uma janela sem panes.

**Implementação no Issue Flow**
`packages/issue-flow/src/runtime/profiles.ts` (domínio e parsers) e
`packages/issue-flow/src/config/runtime.ts` (a escada de precedência) — estratégia: ADAPT

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| `yolo: boolean` → `permission?: AgentPermission`, traduzido na leitura | §16 é explícita: o `yolo` do WebMux mapeia para `autonomous` e **não** se introduz um segundo eixo de permissão. §45.3 lista o booleano como a forma degradada que este porte não pode reintroduzir. `permission` explícito vence; `yolo: true` é aceito como sinônimo; `yolo: false` não sobrescreve nada, e um profile sem permissão **preserva a da fase** — um profile descreve uma janela, não amplia o que o agente pode fazer pelas costas da fase |
| `.webmux.yaml` + overlay `.webmux.local.yaml` → seção `runtime` de `.issue-flow.json` | O repositório já tem uma escada de configuração documentada (`docs/configuration.md`) e um único arquivo de projeto. O que foi portado é o *parsing*; a escada é a do Issue Flow. A semântica de overlay do upstream (profile substituído **inteiro** por nome, nunca campo a campo) sobrevive em `mergeProfileLayers` |
| `readFileSync` + `yaml.parse` → `readProjectConfigFile()` | Chokepoint único de leitura de configuração do projeto, com o mesmo tratamento de JSON inválido e raiz não-objeto que todas as outras seções |
| `Bun.spawnSync(["git","rev-parse", …])` de `gitRoot`/`projectRoot` não é portado | `findProjectRootFromCwd()` já resolve a raiz sem spawn, e `src/config/AGENTS.md` proíbe um segundo caminho. Também é a diferença que evita que ler configuração custe um processo |
| `PaneTemplate`/`PaneKind` continuam em `runtime/tmux/layout.ts` e são reexportados daqui | O tipo já existia (Fase 6) e é o consumidor que o define. Criar um segundo tipo seria a duplicação que o invariante 13 proíbe; mover teria custado uma edição em `layout.ts` sem ganho |
| `profiles.ts` importa `layout.ts` **apenas como tipo** — nenhum wrapper `planProfileLayout` | O carregador de configuração importa este módulo, e um import de valor arrastaria o gateway tmux e o `execa` para todo boot de CLI. A costura profile → tmux é uma linha no chamador: `planSessionLayout({ templates: profile.panes, … })` |
| `startupEnvs: Record<string, string \| boolean>` → `startupEnv: Record<string, string>`, convertido na leitura | O upstream guarda o booleano e converte no ponto de uso (`stringifyStartupEnvValue`). O arquivo é um env map consumido por `bash`: tudo vira string de qualquer forma, e carregar as duas representações só cria um segundo lugar onde a conversão pode divergir |
| Aviso explícito quando o profile pedido não existe | Uma execução que usou `default` em silêncio porque alguém escreveu `sandox` é uma execução cujo isolamento ninguém teve |

**Comportamento deliberadamente NÃO portado**

| O quê | Por quê |
|---|---|
| `agents` (agentes custom por template), `integrations.linear`, `integrations.github`, `workspace.*`, `lifecycleHooks`, `autoName`, `oneshot` de `ProjectConfig` | Não são profiles. `linear` é `DISCARD` explícito (§22); `github` já tem sua seção (`src/config/github.ts`); `lifecycleHooks`, `autoName` e `oneshot` pertencem às Fases 5, 4 e 15; o agente custom por template é §45.2-L e entra por `src/agents/custom.ts`. Portar aqui criaria a segunda implementação que o invariante 13 proíbe |
| `persistLocalLinearConfig`, `persistLocalGitHubConfig`, `persistLocalCustomAgent`, `removeLocalCustomAgent` | Escrita de configuração pelo servidor, com `Bun.write` (não atômico) num arquivo YAML que este projeto não tem. Nenhuma das quatro pertence a profiles; se a escrita de configuração voltar, volta por `writeFileAtomic` e na fase que a precisar |
| Rung de configuração global (`~/.issue-flow/config.json`) para `runtime` | Um profile nomeia comandos de pane e imagens de container que só significam algo dentro de um repositório. Mesma decisão já tomada para `web` e `github` |
| Variável de ambiente para `profiles` e `services` | São estruturas demais para uma variável (o precedente do repositório é `ISSUE_FLOW_RESILIENCE_RETRY`, que é JSON, e é a exceção). Só `ISSUE_FLOW_RUNTIME_PROFILE` existe |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `src/runtime/profiles.test.ts` | `__tests__/setup.test.ts` (fatia de profiles/panes + os 4 casos de `expandTemplate`, `bun:test` → `vitest`) mais os ramos que o upstream não cobria | 39 | ✅ |
| `src/config/runtime.test.ts` | `__tests__/setup.test.ts` (fatia de `loadConfig`) | 14 | ✅ |
| characterization **C8** | §34 | — | ✅ |

**Orçamentos**

| Métrica | Budget | Medido |
|---|---|---|
| `loadRuntimeConfig` (2 profiles, 1 serviço) | — | **0,86 ms** (mediana de 5) |
| Boot do CLI (`node dist/cli.js --version`) | ≤ 250 ms | **100 ms** (mediana de 5) — o carregador entra na fachada sem import de valor do tmux |

---

### Troca de profile — C8 (Fase 10)

**WebMux original**
`.references/webmux-main/backend/src/server.ts` @ d8c9d5f — `PUT /api/worktrees/:name/profile`,
apoiado em `services/session-service.ts` (`ensureSessionLayout`) e no `meta.json` do worktree.

**Comportamento existente**
- Gravar o novo profile no `meta.json`, **destruir a janela**, recriá-la com o novo layout e
  relançar o agente com `launchMode: "resume"` + o `conversationId` do meta.
- A conversa sobrevive à troca de layout. É a afirmação inteira: o que morre é a janela, não
  o histórico.
- Casos especiais que NÃO podem se perder: o nome da janela não muda (é derivado do branch),
  então todo target construído a partir dele — o attach do terminal inclusive — sobrevive à
  troca; e o `--resume` usa **o mesmo id**, não "o mais recente".

**Implementação no Issue Flow**
`packages/issue-flow/src/runtime/profiles.characterization.test.ts` e
`packages/issue-flow/src/runtime/profiles.integration.test.ts`, sobre o
`ensureSessionLayout(..., { force: true })` que a Fase 6 já deixou pronto e o
`buildTtyAgentArgv({ launchMode: 'resume', resumeConversationId })` da Fase 7 —
estratégia: PORT (do comportamento; o código que o realiza já existia)

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| A destruição incondicional da janela vira a opção `force` | §27: o upstream mata a janela em **todo** reattach, o que faz reabrir um worktree matar o agente que trabalhava nele. A Fase 6 separou os três casos (`reattach`/`resume`/`fresh`); a troca de profile é exatamente o caso em que reattachar mostraria o layout antigo, e por isso é o único que pede `force` |
| `meta.json` → `WorktreeMeta` em SQLite (`profile`, `conversationId`) | §45.2-G: o modelo é do WebMux, o veículo é do Issue Flow. Os dois campos já existiam desde a Fase 5, reservados para esta fase |
| Comando do agente montado como argv e serializado uma vez na fronteira do tmux | ADR-04. O `--resume '<id>'` aparece com cada elemento citado individualmente, e é isso que o teste afirma |

**Comportamento deliberadamente NÃO portado**

| O quê | Por quê |
|---|---|
| O endpoint HTTP `PUT /api/worktrees/:name/profile` | A superfície web é das Fases 8B/8C. O que esta fase entrega é o comportamento por baixo dele, verificável sem servidor |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `src/runtime/profiles.characterization.test.ts` | §34 **C8** | 6 | ✅ |
| `src/runtime/profiles.integration.test.ts` | §34 **C8** contra tmux real + budget de §35 | 3 | ✅ |

Duas afirmações do par merecem destaque, porque são as que impedem a regressão silenciosa:
**(a)** um caso prova que a troca *sem* `force` reattacha e mostra o layout anterior — a
flag não pode ser removida como redundante; **(b)** um caso prova que reabrir o mesmo
profile devolve **o mesmo `pane_id`**, isto é, o agente lá dentro nunca soube que alguém
reconectou.

**Orçamentos**

| Métrica | Budget | Medido |
|---|---|---|
| Troca de profile (`ensureSessionLayout` com `force`, 2 → 3 panes, tmux real) | ≤ 400 ms (§35, upstream 254 ms) | **82 ms** (mediana de 5) |

---

### Serviços e health (Fase 10)

**WebMux original**
`.references/webmux-main/backend/src/adapters/port-probe.ts` @ d8c9d5f — 57 linhas
(`BunPortProbe`), e `backend/src/domain/policies.ts:96` — `allocateServicePorts`, função
pura. O consumo está em `services/reconciliation-service.ts` (`buildServiceStates`, `:20`) e
a leitura da configuração em `adapters/config.ts` (`parseServices`, `:253`).

**Comportamento existente**
- `allocateServicePorts` usa **o primeiro serviço com `portStart` como referência**, deduz os
  slots ocupados a partir dos `meta.allocatedPorts` existentes, acha o menor slot livre e
  aplica `portStart + slot*portStep` a **todos** os serviços — é o que mantém as portas de um
  worktree alinhadas entre serviços.
- Uma porta que não cai na grade da referência (`diff % step !== 0`) é **ignorada**: foi
  alocada sob outra configuração e não diz nada sobre qual slot desta está livre.
- O slot começa em **1**, nunca 0: o slot 0 é do próprio repositório.
- `BunPortProbe.isListening` tenta `127.0.0.1` **e** `::1` **em paralelo**, com timeout de
  300 ms, e resolve `true` no primeiro sucesso; o `false` exige que as duas famílias tenham
  respondido.
- `urlTemplate` é expandido com `expandTemplate()` sobre o env de runtime.
- Casos especiais que NÃO podem se perder: as **duas** famílias de loopback (um servidor
  ligado só a `::1` é invisível para uma sonda que só tenta IPv4, e o falso negativo daí é
  indistinguível de um serviço parado); o teto de 300 ms; e o slot 1 como primeiro.

**Implementação no Issue Flow**
`packages/issue-flow/src/runtime/services.ts` — estratégia: PORT

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| `Bun.connect` → `net.connect` | Runtime. A estrutura do `settle`/`pending`/`timer` é a mesma, linha a linha |
| Todo socket é destruído antes de resolver, inclusive no caminho do timeout | O upstream deixa os sockets para o Bun. Em Node uma tentativa de conexão aberta mantém um handle referenciado, e uma sonda que respondesse `false` deixando dois para trás seguraria o processo — uma sonda que responde mas impede a CLI de sair não é uma resposta. Um caso de integração conta os handles antes e depois de 4 sondas |
| `classe BunPortProbe` → `createPortProbe()` | É a forma que o resto de `src/runtime/` usa (`createTmuxGateway`, `createDockerGateway`, `createGitWorktreeGateway`) |
| `{ running: boolean }` → `status: 'ready' \| 'stopped'` de `ServiceRuntimeState` | O contrato de runtime deste projeto (`src/runtime/types.ts`, ADR-02) já publica quatro estados. O mapeamento é deliberadamente estreito: uma sonda só distingue `ready` de `stopped`. `starting` e `failed` são fatos de ciclo de vida — inventá-los a partir de uma conexão recusada faria o painel afirmar algo que ninguém observou |
| `ServiceHealth` estende `ServiceRuntimeState` com `url` | O `url` do upstream é o que torna a porta clicável no painel; `ServiceRuntimeState` não podia ser alterado (ADR-02), então a extensão é aditiva |
| Lista de hostnames vazia responde `false` imediatamente | No upstream esperaria os 300 ms para dizer o mesmo. Entrada degenerada, mesmo resultado, sem o atraso |

**Comportamento deliberadamente NÃO portado**

| O quê | Por quê |
|---|---|
| Nenhum |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `src/runtime/services.test.ts` | `__tests__/domain-policies.test.ts` (o caso de `allocateServicePorts`, `bun:test` → `vitest`) mais os ramos que o upstream tem e não cobria: a grade, a referência ausente, o serviço sem faixa | 21 | ✅ |
| `src/runtime/services.integration.test.ts` | novo — sockets reais; o caso `::1` é o que uma sonda com socket falso não pode mostrar | 5 | ✅ |

**Orçamentos**

| Métrica | Budget | Medido |
|---|---|---|
| `allocateServicePorts` com 100 worktrees existentes | — (função pura) | **0,0039 ms** (mediana de 5 × 1000) |
| Sonda numa porta fechada (as duas famílias) | ≤ 300 ms (teto do upstream) | **1,22 ms** (mediana de 5) |

---

### Human-in-the-loop (Fase 9)

**WebMux original**
`.references/webmux-main/backend/src/server.ts` @ d8c9d5f — `disarmOneshotIfArmed`
(`:2231`, `:2243`), mais o campo `meta.oneshot` como "armado". §32 chama o mecanismo de
elegante e minúsculo, e é: **não há máquina de estados — o humano tocar no teclado é o
sinal.**

**Comportamento existente**
- Presença de `meta.oneshot` = modo autônomo armado.
- Qualquer input vindo do WS do terminal desarma.
- Nenhuma confirmação, nenhum modo a alternar.

**Comportamento existente do Issue Flow que não podia se perder**
- O watchdog mata um agente silencioso depois de `inactivityTimeoutMs` — e é isso que
  precisa ser **pausado**, senão ele mata a sessão exatamente enquanto a pessoa pensa.
- Os cinco runners (`claude`, `codex`, `cursor`, `antigravity`, `opencode`) criam watchdog
  cada um; nenhum deles podia ser reescrito para isso.

**Implementação no Issue Flow**
`src/core/human-hold.ts` (**ADAPT**) · `src/core/hold-gate.ts` (novo) ·
`src/core/watchdog.ts` (uma opção nova) · `src/core/session/{events,snapshot,reducer-agent}.ts`
· `src/web/terminal-ws.ts` (`onHumanInput`) · `src/commands/resume.ts` · migration 15.

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| `meta.oneshot` (arquivo) → colunas `human_hold_at`/`human_hold_reason` em `runs` | Um hold é **intenção**, e intenção é o que o SQLite arbitra (ADR-08). E ele precisa **cruzar processos**: a pessoa digita no monitor, o watchdog roda na pipeline |
| Gate de processo (`core/hold-gate.ts`) em vez de parâmetro nos cinco runners | O watchdog é consultado num timer de até 250 ms e `core/watchdog.ts` é deliberadamente sem dependências; um módulo sem imports mantém a leitura de banco fora do timer. Nenhum dos cinco runners precisou mudar |
| O hold **reseta o relógio** do watchdog, não apenas suspende a checagem | Soltar o hold precisa devolver o orçamento de silêncio **inteiro**, senão o agente morre pelos minutos que a pessoa passou lendo |
| `holdForHuman` é **idempotente** | Uma pessoa digitando gera um evento por rajada; mover o `since` apagaria há quanto tempo ela está no controle, que é exatamente o número que a escalada de §32 lê |
| Liberação **só explícita**, via `issue-flow resume` | Nada infere que a pessoa terminou. Um run que se auto-retomasse porque o terminal ficou quieto seria o bug que o hold existe para evitar |
| `issue-flow resume` reaproveitado, sem comando novo | Invariante 13. A checagem do hold vem **antes** da aquisição do run lock: um run mantido está vivo e segurando o lock de propósito, e a ordem inversa responderia "outro run é dono deste projeto", que é precisamente a resposta errada |
| A transição é publicada pelo **watch da pipeline**, não por quem virou a flag | O takeover acontece no monitor e a liberação na CLI; nenhum dos dois é dono do snapshot daquele run |
| Falha de storage lê como **não-mantido** | Congelar um run por um erro de leitura seria pior do que a ausência da funcionalidade |

**Comportamento deliberadamente NÃO portado**

| O quê | Origem | Por quê |
|---|---|---|
| Auto-close da sessão ao desarmar | `oneshot-watcher-service.ts` | É da convergência do oneshot (Fase 15), que é quem decide o que acontece com a sessão depois |
| Escalada por `awaiting_input` sem resposta por N minutos | §32, última linha da tabela | O dado existe (`heldForMs` e `agent.awaitingInputCount` da Fase 2) e está exposto; **a política de notificação** ainda não tem consumidor — entra com a interface (§50) ou com a Fase 15. Registrado como pendência explícita |
| `postToLinearOnDone` | `meta.oneshot` | ADR-14 — Linear não é absorvido |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `src/core/human-hold.test.ts` | novo — **C10** de §34 e a regra de §32 | 11 | ✅ |

Inclui os dois lados do gate: o watchdog **não** mata sob hold nem depois de dez vezes o
orçamento de silêncio, e **continua** matando um agente genuinamente travado quando
ninguém está segurando o run.

**Orçamentos**
Nenhum de §35 se aplica. O custo acrescentado ao caminho quente é uma leitura de booleano
em memória por tick do watchdog, com o refresh de banco atrás de um intervalo de 1 s.

---

### Paralelismo (Fase 16) e multi-agente com handoffs (Fase 17)

**WebMux original**
Nenhuma unidade portada. §31.1 é uma **constatação sobre o upstream**, não código a
traduzir: o WebMux roda N tarefas bem porque **não tem lock global** — todo o estado é por
worktree (diretório, `runtime.env`, portas, janela tmux, container), então não há estado
mutável compartilhado de onde excluir alguém. As duas únicas primitivas de exclusão que
existem lá já foram absorvidas nas fases anteriores: o `inFlight` da reconciliação (Fase 11)
e o `WorktreeCreationTracker` (Fase 5).

§28 e §29 especificam funcionalidade **nova**, que o WebMux não tem: ele não tem fases, não
tem revisor independente e não tem contrato de handoff.

**Comportamento existente do Issue Flow que não podia se perder**
- `run.lock` por projeto, fila serial. **É o default e continua sendo** — nada vira paralelo
  por atualizar de versão.
- A independência de `review`/`verify`/`pr-review` (ADR-07), que a Fase 7 já defende em
  `agents/session/reuse.ts`.

**Implementação no Issue Flow**
`src/runtime/concurrency.ts` · `src/storage/paths.ts` (`getUnitRunLockPath`) ·
`src/config/runtime.ts` (`maxConcurrent`) · `src/agents/handoff/{types,store}.ts` ·
migration 19 (`handoffs`).

**Decisões de projeto**

| O quê | Por quê |
|---|---|
| `maxConcurrent` default **1** | §31.3. 1 é literalmente a fila serial de hoje, com o `run.lock` de projeto; acima de 1 o lock desce para a **unidade** de execução |
| Lock por unidade é **exato**; o teto é **throttle** | Contar locks vivos e então reivindicar não é atômico. Dois processos começando no mesmo instante podem ver espaço e passar o teto por um, transitoriamente. Tornar isso exato exigiria um lock sobre a contagem, que serializaria exatamente o que a fase existe para paralelizar; ficar um acima por alguns segundos custa uma máquina mais ocupada, não um run corrompido. **A exclusão que importa — um run por unidade — é exata** |
| Contagem numa passada só pelo diretório de locks | ADR-13. Sondar por entidade é o que transforma custo constante em linear |
| Lock com dono morto ou sem heartbeat **não conta** | Senão um crash faria o projeto recusar trabalho em nome de um processo que não existe |
| `handoffs` é tabela, não mensagem por terminal | §29 é explícito: `tmux send-keys` não é barramento. Uma linha persistida torna a troca auditável depois |
| `HANDOFF_DATA_NOTICE` + cerca `<handoff>` | Regra de segurança de §29. O conteúdo é texto **escrito por um agente** entregue a outro que roda com permissão ampla; tratá-lo como instrução seria injeção de prompt com o atacante já dentro da pipeline. A cerca importa tanto quanto o aviso: um agente que não sabe onde o dado começa é um agente para quem o aviso não faz nada |
| `digest` por artefato | A fase seguinte consegue distinguir "o plano que me entregaram" de "o que estiver naquele caminho agora" |
| Consumo **separado** da leitura | Uma fase que morreu entre as duas vê o handoff de novo, em vez de começar sem o contexto que recebeu |
| Escrever handoff **nunca** derruba a fase | É registro; falhar o trabalho por causa dele trocaria trabalho pronto por uma anotação perdida |
| `PHASE_SESSION_GROUP` é conveniência, **não** a garantia | ADR-07 mora em `agents/session/reuse.ts` e é afirmado lá; uma tabela que ninguém é obrigado a consultar não é invariante |

**Comportamento deliberadamente NÃO portado**
Nenhum — não há unidade upstream nestas fases.

**Testes**

| Teste | Casos | Estado |
|---|---|---|
| `src/runtime/concurrency.test.ts` | 15 | ✅ |
| `src/agents/handoff/handoff.test.ts` | 13 | ✅ |

**Orçamentos**

| Métrica | Baseline WebMux | Budget | Medido |
|---|---|---|---|
| Custo marginal por sessão adicional | 15 ms | ≤ 30 ms | **8 ms** (tmux, Fase 6) e **< 1 ms** (slot de execução, 5 simultâneos) |

**Ligação final** (feita depois que a Fase 15 liberou `src/commands/run.ts`)
`claimRunOwnership` (`src/commands/run/session.ts`) passou a chamar
`acquireExecutionSlot()` em vez de `acquireRunLock()` direto. É o único ponto em que um run
pede a exclusão, e `runtime.maxConcurrent` é a única coisa que decide se o slot é o
`run.lock` de projeto de sempre ou um lock por unidade. Três detalhes:

- **`unitId` é a issue da invocação.** Uma fila é *um* run, não um por issue (§31.3), então
  a primeira issue nomeia o slot que a invocação inteira segura.
- **`detached` atravessa o slot.** Ele é o que distingue um dono em background de um
  interativo, e é o que decide se retomar um lock parado é recuperação ou colisão;
  `acquireExecutionSlot` o descartava, e passou a repassá-lo nos dois ramos.
- **A recusa virou uma frase só** (`describeSlotRefusal`), porque agora há dois motivos
  — dono vivo e teto atingido — e cada chamador imprimir o seu produziria duas redações.

`src/commands/run/ownership.test.ts` fixa as duas metades: no teto padrão o arquivo é o
mesmo de sempre e **nenhum** lock por unidade é criado; acima dele duas issues correm
simultaneamente e a terceira é recusada nomeando `runtime.maxConcurrent`. Sem esse teste,
uma ligação que continuasse usando o lock de projeto passaria em todo
`runtime/concurrency.test.ts` e ainda assim faria o teto não ter efeito nenhum.

---

### Orçamentos de §35 — quadro consolidado

Medidos ao final da absorção, no mesmo estilo da coleta original (mediana de ≥ 3 execuções,
wall clock em milissegundos), na máquina do porte (macOS 25.5, Node v22.22.1, tmux 3.6a).

| Métrica | Baseline WebMux | Budget | Medido | Onde |
|---|---|---|---|---|
| Latência output → tela (p95) | ≈ 0 ms (push) | **≤ 250 ms — teto duro** | **54 ms** (mediana 51) | `src/web/stream-latency.integration.test.ts` |
| `git worktree add` | 78 ms | ≤ 150 ms | **45–97 ms** | `src/runtime/worktree/lifecycle.integration.test.ts` |
| `ensureSessionLayout` (2 panes) | 254 ms | ≤ 400 ms | **77 ms** | `src/runtime/tmux/gateway.integration.test.ts` |
| Custo marginal por sessão adicional | 15 ms | ≤ 30 ms | **8 ms** (tmux) · **< 1 ms** (slot de execução) | `gateway.integration.test.ts`, `concurrency.test.ts` |
| Reconciliação (`list-windows -a`) | 23 ms, O(1) | ≤ 50 ms **e O(1)** | **6 ms em N=1, 14 ms em N=21** | `gateway.integration.test.ts` |
| Reconexão de terminal | 28 ms + replay | ≤ 100 ms | **26 ms** | `src/web/terminal-ws.integration.test.ts` |
| Boot do CLI | n/a | ≤ 250 ms | **100 ms** (antes da absorção: 135–192) | `node dist/cli.js --version`, mediana de 5 |
| T0→T4 (worktree pronta + agente iniciado) | n/a | ≤ 600 ms | **181–279 ms** | `src/agents/session/open.integration.test.ts` |

Sem medição própria nesta entrega: **entrega de prompt subsequente de 20 KB**, que exige um
agente real já rodando num pane; está coberta funcionalmente pelo caso de 64 KB de
`src/agents/tty.integration.test.ts`, que prova que o bloco inteiro chega. **Contexto re-ingerido por story após a 1ª invocação** continua sendo
invariante de arquitetura (a conversa é reaproveitada via `--resume`, exceto onde ADR-07
proíbe) e não uma métrica de tempo.

---

### Sandbox Docker — hardening (Fase 13)

**WebMux original**
`.references/webmux-main/backend/src/adapters/docker.ts` @ d8c9d5f — 384 linhas
`.references/webmux-main/sandbox-image/` @ d8c9d5f — 2 arquivos, ~80 linhas

Esta fase **não porta nada**. Ela endurece o que a Fase 12 portou, contra o threat model
de §14 etapa 2. O upstream não tem contrapartida para nenhum item abaixo — é exatamente
por isso que a lista existe.

**Comportamento existente** (o que a Fase 12 deixou, e que esta fase preserva)

- `buildDockerRunArgs()` continua **função pura**: todo estado de host chega pelo
  `DockerRunArgsContext`. A Fase 13 acrescenta um campo (`hostTotalMemoryBytes`) e não
  abre nenhuma leitura de `process`, relógio ou filesystem de dentro da função.
- Portas publicadas **apenas** em `127.0.0.1`; `--user <hostUid>:<hostGid>`;
  `reservedKeys` inviolável; `GIT_CONFIG_COUNT=2` para os dois diretórios; `--mount
  type=bind` para o socket SSH; montagens explícitas do perfil vencem as de credencial;
  idempotência por branch; `run()` como único caminho de shell. Nada disso foi tocado.
- Casos especiais que NÃO podiam se perder e não se perderam: todos os da ficha da
  Fase 12, mais dois que o endurecimento poderia ter quebrado sem que ninguém notasse —
  a escrita no worktree montado (que depende de `--user`, não de capabilities) e a
  publicação de portas de serviço (que `--network none` tornaria uma falha de subida).

**Implementação no Issue Flow**
`packages/issue-flow/src/runtime/sandbox/docker.ts` — estratégia: **NEW** (sem origem upstream)
`packages/issue-flow/sandbox/Dockerfile.sandbox` — estratégia: **ADAPT** (imagem mínima)
`packages/issue-flow/sandbox/Dockerfile.sandbox.full` — a imagem da Fase 12, renomeada
`docs/sandbox-security.md` — o modelo de segurança, escrito nesta fase

**O threat model de §14, item a item**

| Ameaça (§14) | Endurecimento | Onde | Teste |
|---|---|---|---|
| Container roda como usuário do host, com o worktree montado | **Mantido, e documentado como não sendo isolamento contra código malicioso** | `docs/sandbox-security.md` ("What the sandbox is not"), cabeçalho de `docker.ts`, `AGENTS.md` do módulo | `hardening — capabilities > still runs as the host user, so the mounted worktree stays writable` |
| `SSH_AUTH_SOCK` montado | **Opt-in explícito por profile** (`security.sshAgent`), default `false`. O upstream encaminha sempre que o socket existe | `docker.ts`, gate na função pura **e** em `launchContainer` (que nem chega a `stat` o socket sem opt-in) | `SSH agent forwarding > is not forwarded by default…`, `> is not forwarded when the profile opts out explicitly`, `> signing still works for the profile that asks`; integração: `SSH_AUTH_SOCK is not in the container unless the profile asked for it` |
| `envPassthrough` com credenciais | **Validação contra padrões de segredo + log do que foi passado**, por nome. Reporta, nunca recusa — a allowlist é decisão humana e recusar quebraria o lançamento que ela existe para permitir | `isSecretLikeEnvKey()` + dois `onWarn` em `buildDockerRunArgs` | `hardening — envPassthrough is reported, never silently forwarded` (6 casos, incluindo `never puts a value in a warning` e `reports rather than refuses`) |
| Sem `--read-only`, sem `--cap-drop`, sem limites | **`--cap-drop=ALL` + `--security-opt no-new-privileges:true` + `--pids-limit 2048` + `--memory` (75% da RAM do host)**. `--read-only` **não** adotado — ver "NÃO portado" | bloco emitido logo após `--user` | `hardening — capabilities`, `hardening — no-new-privileges`, `hardening — resource limits` (9 casos puros); integração: `the hardened argument list is one docker accepts`, `no-new-privileges is set in the kernel` (`NoNewPrivs: 1` em `/proc/self/status`), `the agent can still write to its worktree under cap-drop=ALL`, `the agent can still spawn the processes a build needs`, `the pids limit actually stops a runaway` |
| Sem restrição de rede | **`security.network: none \| bridge`, default `bridge`, escrito explicitamente** para não depender de como o daemon do host está configurado | `resolveNetworkMode()` | `hardening — network policy` (5 casos); integração: `network=none leaves the container with nothing but loopback`, `network=none with declared services still launches, without published ports`, `the default network still publishes a service port, on loopback only` |
| Socket do Docker | **Proibição explícita**: uma montagem de perfil apontando para `docker.sock` / `containerd.sock` / `podman.sock` é recusada com warning, sob qualquer `guestPath` | `isDockerSocketPath()` | `hardening — the docker socket stays forbidden, explicitly` (3 casos, incluindo `an ordinary application socket is still mountable`) |
| Imagem com Rust+Playwright+AWS | **Imagem mínima como default** (`Dockerfile.sandbox`), a atual como **`full`** (`Dockerfile.sandbox.full`) | `packages/issue-flow/sandbox/` | `image.test.ts` — 31 casos: o default instala o que o pipeline usa e não instala os toolchains pesados; o `full` continua com tudo |

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| `hostTotalMemoryBytes` entra no `DockerRunArgsContext` em vez de `os.totalmem()` dentro da função | Mesma razão de `hostEnv` na Fase 12: no instante em que a função lê estado de processo, C7 deixa de ser comparação literal e o baseline endurecido deixa de ser reproduzível |
| `--memory` default é **fração da RAM do host**, não um número fixo | Um valor fixo está errado em toda máquina menos uma: `4g` mata um run de Chromium numa workstation de 64 GB e superaloca um laptop de 8 GB. A ameaça real é "o container derruba a máquina", não "o container usa muita memória". Uma fração nunca fica abaixo do que um build que cabe na máquina precisa |
| `--pids-limit` default 2048 | Um `npm ci` com módulos nativos ou um run de Chromium tem pico na casa das centenas. 2048 é folgado para o legítimo e é parede para uma fork bomb |
| `--network none` **descarta as portas publicadas**, com warning | Docker recusa `--network none` junto de `-p` ("conflicting options: port publishing and the container type network mode"). Sem isso, um profile isolado que declarasse um serviço simplesmente não subiria — o endurecimento viraria uma falha |
| Segredo em `envPassthrough` é **reportado**, não bloqueado | A allowlist é decisão humana; recusar uma entrada quebra o lançamento que ela existe para permitir. §14 pede "validar contra padrões de segredo e logar o que foi passado" — as duas coisas são relato |
| Warnings carregam **nomes, nunca valores** | §45.3: "telemetria com redaction" é garantia do Issue Flow; um valor num log seria a forma degradada |
| A imagem mínima não instala `sudo` | `no-new-privileges` torna todo binário setuid inerte. Uma entrada de sudoers que não pode funcionar transforma uma falha clara em uma confusa. A imagem `full` mantém a do upstream, e lá também é inerte |
| `build-essential` fica nas duas imagens | Tirar quebraria `npm ci` em qualquer repositório com dependência nativa. Compilador não é privilégio — seria endurecimento que na verdade é regressão |
| C7 passa a comparar contra o baseline **deste projeto** | Ver abaixo |

**C7: divergência deliberada em relação ao upstream**

Até a Fase 12, C7 comparava a lista de argumentos literalmente contra
`.references/webmux-main/backend/src/adapters/docker.ts`. A Fase 13 é, por definição, uma
lista de coisas que o upstream não faz. O teste **não foi removido nem enfraquecido** —
continua um `toEqual` da lista inteira, agora com dois baselines completos (lançamento
cheio e mínimo) — e ganhou um caso irmão,
`docker run args differ from the upstream in exactly the §14 hardenings`, que enumera cada
diferença. O que não está nessa enumeração continua sendo literalmente o do upstream, e
uma divergência nova que não apareça lá é bug.

Diff conceitual dos args de `docker run` (upstream → Issue Flow):

```diff
  docker run -d --name <nome> -w <worktreeDir>
    --add-host host.docker.internal:host-gateway
    --user <hostUid>:<hostGid>
+   --cap-drop ALL
+   [--cap-add <CAP> ...]                  ← só se o profile nomear
+   --security-opt no-new-privileges:true  ← salvo opt-out explícito
+   --pids-limit 2048                      ← configurável; 0 omite
+   --memory <75% da RAM do host>          ← configurável; "0" omite
+   --network bridge|none                  ← default bridge, sempre escrito
-   -p 127.0.0.1:<porta>:<porta>           ← descartada quando network=none
+   -p 127.0.0.1:<porta>:<porta>           ← inalterada quando network=bridge
    -e HOME=/root -e TERM=… -e IS_SANDBOX=1
    -e GIT_CONFIG_COUNT=2 -e GIT_CONFIG_{KEY,VALUE}_{0,1}=…
    -e <passthrough...>                    ← inalterado; agora reportado por nome
    -e <runtimeEnv...>                     ← inalterado
    -v <worktree>, <mainRepo>/.git, <mainRepo>:ro
-   -v ~/.claude, ~/.claude.json, ~/.codex, ~/.gitconfig:ro, ~/.ssh:ro, ~/.config/gh:ro
+   (idem, mas reportados a cada lançamento e desligáveis por security.implicitMounts)
-   --mount type=bind,source=$SSH_AUTH_SOCK,…   ← sempre que o socket existia
+   --mount type=bind,source=$SSH_AUTH_SOCK,…   ← só com security.sshAgent: true
    --mount/-v <mounts do profile>
+   (uma montagem de docker.sock/containerd.sock/podman.sock é recusada)
    <image> sleep infinity
```

**Comportamento deliberadamente NÃO portado**

| O quê | Origem | Por quê |
|---|---|---|
| `--read-only` | §14, coluna "Estado no WebMux" | §14 o nomeia na coluna do problema e **o deixa de fora** da coluna do endurecimento proposto, corretamente. O agente escreve em `/tmp`, em caches de gerenciador de pacotes e na própria configuração; um rootfs read-only exigiria um `tmpfs` para cada um, e o primeiro esquecido vira uma falha que parece agente quebrado, não política |
| `--memory-swap` | — | Sem ele, o docker permite swap até 2× o `--memory`, o que enfraquece o teto. Igualá-lo a `--memory` desliga o swap e faz um build pesado legítimo morrer de OOM onde hoje ele apenas fica lento. Fica registrado como melhoria a medir, não como endurecimento a aplicar às cegas |
| `--cpus` | — | Não está em §14. Um teto de CPU não impede nada que os outros limites já não impeçam, e o custo (build mais lento sem aviso) é imediato |
| `--userns=remap` / rootless | — | Mudaria a propriedade dos arquivos criados no worktree, que é exatamente o que `--user <hostUid>` existe para preservar. É uma decisão de arquitetura do modo sandbox, não um flag de endurecimento |
| Bloquear (em vez de reportar) `envPassthrough` com cara de segredo | §14 | §14 pede "validar e logar", não recusar. Recusar quebraria o lançamento que a allowlist existe para permitir, e um falso positivo custaria a chave da API do agente |
| Remover as montagens implícitas de credencial | §39, `DEPRECATE: mounts implícitos` | `DEPRECATE`, não `DELETE`. Sem elas, todo agente dentro do sandbox deixa de autenticar. O que foi deprecado é a *implicitude*: cada lançamento nomeia os diretórios do usuário em que tocou, e `security.implicitMounts: false` desliga |
| ~~Fazer o parser de profiles ler `security`~~ | §16/§19, Fase 10 | **Resolvido depois desta ficha.** Ficou fora por instrução explícita (o arquivo era da Fase 10), e o efeito era pior que uma ausência: `docs/configuration.md` documentava `security.*` como configurável enquanto `src/runtime/profiles.ts` descartava a chave. `parseProfileSecurity` fecha a costura, e `src/runtime/profiles.security.test.ts` percorre o caminho inteiro — do valor cru no `.issue-flow.json` até o argumento que o `docker run` recebe — porque uma ligação quebrada aqui é invisível: os defaults endurecidos continuariam valendo e a escotilha simplesmente não existiria |
| `entrypoint.sh` reconhecer `package-lock.json` / `pnpm-lock.yaml` | `sandbox-image/entrypoint.sh` | Continua fora: não é item do threat model de §14 |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `src/runtime/sandbox/docker.test.ts` | os 45 da Fase 12 + 36 da Fase 13 | 81 | ✅ |
| `src/runtime/sandbox/image.test.ts` | novo — o split de imagem de §14 | 31 | ✅ |
| `src/runtime/sandbox/docker.integration.test.ts` | os 8 da Fase 12 + 9 da Fase 13, daemon real (Docker 29.4.0) | 17 | ✅ |
| characterization **C7** | §34 — agora contra o baseline endurecido | — | ✅ |

Cada endurecimento tem **dois** testes: o argumento novo está na lista, e a operação
legítima que ele poderia quebrar continua funcionando. Os pares, na ordem do threat model:
`cap-drop` ↔ escrita no worktree; `no-new-privileges` ↔ o resto do bloco continua de pé;
`pids-limit` ↔ 50 processos concorrentes; `memory` ↔ a fração cresce com a máquina;
`network` ↔ portas ainda publicadas em `bridge`; socket proibido ↔ socket comum de
aplicação ainda montável; imagem mínima ↔ git, `gh`, Node, toolchain C e as CLIs de agente
ainda instalados.

**Orçamentos**

| Métrica | Budget | Medido |
|---|---|---|
| `buildDockerRunArgs` | — (função pura) | **0,00287 ms** (mediana de 5 × 1000: 0,00261 / 0,00270 / 0,00287 / 0,00329 / 0,00392) — 5 flags a mais que a Fase 12, mesma ordem de grandeza |
| `launchContainer` com imagem quente (`alpine:latest`), hardening completo | — (§35 não orça o sandbox; T0→T4 ≤ 600 ms é o teto vizinho) | **204 ms** (mediana de 3: 145 / 204 / 282), Docker 29.4.0 |

### Convergência do oneshot (Fase 15)

**WebMux original**
`.references/webmux-main/bin/src/oneshot.ts` @ d8c9d5f — 1.077 linhas ·
`.references/webmux-main/backend/src/services/oneshot-watcher-service.ts` @ d8c9d5f — 159 linhas
(1.236 no total, conforme §22)

**Comportamento existente**

- `webmux oneshot [branch] --prompt <txt>` cria um worktree, arma o watcher via
  `meta.oneshot` e transmite a conversa. **Uma** fase: o agente faz tudo.
- O "armado" **é** a presença de `meta.oneshot`. Não há máquina de estados.
- Qualquer input no WS do terminal chama `disarmOneshotIfArmed(branch,
  "terminal-ws-input")` (`server.ts:2231`) — o humano tocar no teclado é o sinal.
- O watcher do servidor decide o fim: `stopped`/`error` disparam na hora;
  `idle` e `closed` esperam a janela de graça de 15 s.
- `closed` é tratado como `idle` **de propósito**: é também o ciclo de vida de
  um worktree recém-criado, antes do primeiro evento do hook. Sem essa guarda o
  watcher fecharia uma sessão que ainda não tinha começado (*cold-start guard*).
- Antes de fechar, relê a meta: o post ao Linear demora segundos e uma interação
  humana nessa janela precisa abortar o fechamento.
- Desarma **mesmo quando o fechamento falha**, senão o próximo ciclo tentaria o
  mesmo fechamento quebrado para sempre.
- Guarda `inFlight` por branch: um fechamento lento não pode ser iniciado duas
  vezes.
- `closeWorktree` fecha a **janela tmux**, nunca o worktree — o trabalho fica.
- Casos especiais que NÃO podem se perder: a janela de graça; a guarda de
  cold-start; a releitura antes do fechamento; o desarme apesar da falha; a
  guarda `inFlight`; e o fato de que fechar a sessão não apaga nada.

**Implementação no Issue Flow**
`src/core/run-completion.ts` (**PORT**) · `src/commands/run/auto-close.ts`
(**ADAPT**) · `src/commands/run/demand.ts` (**MERGE**) ·
`src/issues/providers/inline.ts` + `src/storage/db/inline-issues.ts` (**ADAPT**) ·
`src/config/run.ts` (**ADAPT**) · `src/issues/provider.ts` + `src/issues/resolver.ts`
(`claims`, aditivo) · `src/commands/run.ts`, `src/commands/run/session.ts`,
`src/commands/run/types.ts`, `src/cli.ts`, `src/issues/bootstrap.ts` (integração) ·
migration **18**.

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| `meta.oneshot` (arquivo) → **ausência de `human_hold`** como estado "armado" | Invariante 13. O desarme por takeover já existe desde a Fase 9 e é exatamente o mecanismo de §32; um segundo flag armado/desarmado seria uma segunda implementação da mesma pergunta. "Armado" passa a ser **derivado**, nunca armazenado duas vezes |
| `agentLifecycle: "closed"` → `lifecycle: null` | O Issue Flow não tem esse ciclo de vida; "nenhum hook reportou ainda" é a mesma condição e preserva a guarda de cold-start intacta |
| Novo sinal terminal: o **veredito da própria pipeline** | É a metade Issue Flow da convergência (§17). Ele é imediato e soberano; `agent_stopped`/`pr_opened` entram como evidência **adicional** e nunca encurtam fases (§45.3) |
| `closeWorktree(branch)` → marcar `stopped` as `AgentSession` vivas do run | O equivalente estrutural: o upstream fecha a *sessão*, não o worktree. Nada é deletado, nenhum branch ou worktree é tocado, e um run headless (que não abre sessão) fecha nada — ADR-03 |
| Janela da releitura: post ao Linear → **finalização do próprio run** | O gatilho original não existe (ADR-14), mas a corrida sim: a pessoa pode assumir enquanto o run fecha a issue e imprime o resumo |
| Prompt livre → **Issue de origem `inline`**, não um caminho paralelo | §17 é explícito: "manter a entrada do Issue Flow, aceitar prompt livre como `source: inline`". Depois de `resolveRequestedIssues()` nada a jusante distingue uma demanda inline de uma do GitHub, e é isso que mantém contrato de aceitação e revisor independente idênticos |
| Identificador **endereçado por conteúdo** (`inline-<hash12>`) | O prompt é a única identidade que a demanda tem. Torna a segunda invocação do mesmo prompt um **resume**, não uma história paralela — e é o que faz `--background` funcionar, já que o filho re-executa o mesmo argv |
| Demanda inline em **SQLite** (`inline_issues`), não em arquivo | Uma demanda de uma linha não pode deixar um diretório no repositório; e guardá-la sob `issues/` faria o provider `local` responder pelo mesmo identificador, criando divergência entre origens onde não há nenhuma |
| `autoCloseOnDone` default `true` → `run.autoClose` default **`false`** | No upstream o oneshot **é** a sessão que fecharia. Aqui a opção foi acrescentada a um comando existente, e uma opção nova não pode mudar o que o comando já fazia |
| Watcher periódico (`startOneshotWatcher`) → **passe único** chamado pelo run | Ver "NÃO portado" abaixo |
| `IssueProvider.claims(id)` acrescentado ao contrato (opcional) | Sem isso, um `resume inline-…` perguntaria ao GitHub por um identificador que ele nunca poderia ter, gastando um round-trip e avisando sobre uma falha que não era falha. É aditivo e exclusivo: só uma origem cujo namespace nenhuma outra poderia produzir o declara, senão a detecção de divergência seria silenciada |

**Comportamento deliberadamente NÃO portado**

| O quê | Por quê |
|---|---|
| `startOneshotWatcher` — o `setInterval` de 3 s | No upstream o servidor é um processo separado da CLI e precisa descobrir o fim por polling. Aqui a pipeline é dona do próprio fim e o conhece de forma síncrona; um poller seria uma **segunda autoridade sobre o mesmo fato** (ADR-08). O corpo do ciclo (`runOneshotWatch` → `runCompletionPass`) foi portado inteiro e é chamado pelo run, então nenhuma decisão se perdeu — só o relógio |
| `postToLinearOnDone` e todo o `--linear` | ADR-14 — Linear é `DISCARD` explícito |
| `--resume <branch>` do oneshot | `issue-flow resume` já é essa responsabilidade (invariante 13). Um segundo caminho de retomada dentro de `run` seria a duplicação que a fase existe para evitar |
| `--agent`, `--base`, `--profile`, `--env` do oneshot | São opções de **criação de worktree**, não de demanda; pertencem a `runtime`/`profiles` (Fases 5, 6 e 10), que já as têm |
| `--branch <name>` | O branch de um `run` vem do plano e da convenção (`conventions/git/branch.ts`), nunca de um flag — seria uma segunda convenção de branch |
| Streaming da conversa para stdout (WS `agents/:name/conversation`, `summarizeToolInput`, `formatConversationLine`) | O Issue Flow já transmite a execução por dois canais mais maduros: o renderer de fases no terminal e o monitor push (Fase 1). Um terceiro formatador seria a duplicação de §25 |
| `config.oneshot.systemPrompt` (as 5 frases default) | As fases do Issue Flow têm seus próprios prompts, versionados e sobrescrevíveis por repositório. Um system prompt global do oneshot não tem onde encaixar sem competir com eles |
| Códigos de saída próprios do oneshot (0 no takeover, 1 no idle sem PR, 130 no Ctrl-C) | Os códigos de `run` já são contratuais e testados; o takeover não é sucesso nem falha do trabalho, e o Ctrl-C já grava checkpoint e retorna pelo caminho de shutdown existente |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `src/core/run-completion.test.ts` | `backend/src/__tests__/oneshot-watcher-service.test.ts` (12) | 18 (10 portados + 8 acrescentados) | ✅ |
| `src/commands/run/demand.test.ts` | `bin/src/oneshot.test.ts` (17) | 8 (3 portados + 5 acrescentados) | ✅ |
| `src/issues/providers/inline.test.ts` | novo — a origem `inline` de §17 | 10 | ✅ |
| `src/commands/run/auto-close.test.ts` | novo — o encontro das duas metades, contra banco real | 8 | ✅ |
| `src/config/run.test.ts` | novo — precedência de `run.autoClose` | 6 | ✅ |
| `src/issues/resolver.test.ts` (`claims`) | novo — exclusividade de namespace e degradação segura | 3 | ✅ |
| `src/storage/db/migrations.test.ts` (migration 18) | novo — banco novo, banco migrado e reabertura | 1 | ✅ |
| `src/commands/run.test.ts` (`§17`) | novo — `--prompt` de ponta a ponta pela pipeline real | 4 | ✅ |
| `scripts/smoke-issue-providers.sh` cenário **[D]** | novo — `run --prompt` pela CLI empacotada | 9 asserções | ✅ |

Dos 12 casos do watcher upstream, **10** portam. Os 2 restantes
(`posts to Linear before closing`, `still closes + disarms when postToLinear
fails`) são exclusivamente do Linear. Dos 17 de `parseOneshotArgs`, **3** portam;
os outros 14 são `--linear`/`--branch` (8), `--resume` (4), opções de worktree (1)
e `--help` (1) — todos listados acima como não portados.

**Orçamentos**
Nenhum de §35 se aplica. O custo acrescentado ao fim de um run é uma leitura de
`agent_events` e uma de `runs.human_hold_at`, ambas fora de qualquer caminho
quente. `--prompt` acrescenta uma escrita em `inline_issues` por invocação, antes
da primeira fase. Boot da CLI inalterado: `demand.ts` é puro e
`issues/providers/inline.ts` só é carregado quando a origem é consultada.

### Sessões livres — `agents/session/open.ts`, `commands/session.ts`, `web/sessions-api.ts` (Fase 9B)

**WebMux original**
`.references/webmux-main/backend/src/services/lifecycle-service.ts` @ d8c9d5f —
1.523 linhas, das quais `createWorktree` (11), `openWorktree` (75),
`resolveBranch` (17) e `materializeRuntimeSession` são o caminho de "abrir um
agente numa branch com um clique".
`.references/webmux-main/backend/src/lib/branch-name.ts` @ d8c9d5f — 5 linhas.
`.references/webmux-main/backend/src/services/agent-service.ts:198` @ d8c9d5f —
`buildManagedShellCommand`, 6 linhas.
`.references/webmux-main/bin/src/worktree-commands.ts` @ d8c9d5f — 1.218 linhas,
subcomandos `add` / `open` / `list` / `send` / `close`.

**Comportamento existente**
- **Abrir um agente nunca exige uma issue.** No upstream a unidade é a
  *worktree*; a issue (Linear) é opcional e sai por ADR-14. É essa postura que a
  fase preserva, traduzida para o modelo do Issue Flow: a unidade aqui é a
  `AgentSession`, e `run_id`/`phase`/`story_id` vazios são o modo livre (ADR-16).
- **O branch é gerado quando ninguém o nomeia** (`resolveBranch` →
  `generateFallbackBranchName`). Exigir um nome seria exigir exatamente a
  cerimônia que a sessão livre existe para pular.
- **Reabrir retoma em vez de recomeçar**: `launchMode` sai da conversa gravada, e
  `--resume <id>` é o que devolve o contexto sem repagá-lo.
- **O pane de shell carrega o mesmo `runtime.env` do agente**
  (`buildManagedShellCommand`), com `exec … -i`: sem isso o shell ao lado do
  agente não enxerga nenhuma das portas que o agente está usando, e fechar o
  shell deixaria o usuário dentro do wrapper.
- Casos especiais que NÃO podem se perder: o prompt viajando no argv em vez de
  ser digitado (a corrida de paste/Enter de §2.4); o `-i` do shell gerenciado; o
  branch gerado sempre com sufixo aleatório, mesmo com rótulo.

**Implementação no Issue Flow**
`packages/issue-flow/src/agents/session/open.ts` — estratégia: ADAPT
`packages/issue-flow/src/agents/session/context.ts` — estratégia: ADAPT
`packages/issue-flow/src/agents/session/store.ts` (`recordPaneTarget`, `linkSessionToRun`) — NEW
`packages/issue-flow/src/agents/tty.ts` (`buildManagedShellCommand`) — PORT
`packages/issue-flow/src/commands/session.ts` — ADAPT
`packages/issue-flow/src/web/sessions-api.ts` — ADAPT
`packages/issue-flow/src/storage/db/migrations.ts` (migration 17) — NEW

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| `Bun.spawnSync` do tmux/git → `run()` via os gateways já portados | Runtime, e o chokepoint único de §45.3 |
| A unidade persistida é a `AgentSession`, não a worktree | ADR-16: um modelo, dois modos. A worktree continua sendo do `runtime/worktree/`, e este módulo a consome |
| `meta.json` na git dir → linha em `agent_sessions` | O vínculo é *intenção*, e o SQLite é a autoridade sobre intenção (ADR-08). A worktree continua sendo do git |
| `yolo: boolean` → `permission` semântica de três níveis, default `workspace` | §45.2-L; um `--yolo` implícito numa sessão aberta por uma pessoa seria a forma degradada de §45.3 |
| Comando do agente como string de shell → **argv**, serializado uma única vez na fronteira do tmux | ADR-04 |
| `ensureSessionLayout` distingue `reattach` de `resume` | §27 — o upstream mata a janela incondicionalmente e com ela o agente que estava trabalhando |
| CLI fala com o SQLite, não com um servidor HTTP | §47.5: `webmux worktree list` imprime erro de conexão sem servidor; `issue-flow session ls` funciona offline |
| A listagem HTTP é `GET /api/agent-sessions`, não `GET /api/sessions` | `GET /api/sessions` já responde a lista de **execuções** desde o painel multi-sessão e está documentada em `src/web/AGENTS.md`; ADR-20 separa "execução" de "sessão". Os demais verbos de §49.3 (`POST /api/sessions`, `DELETE /api/sessions/:id`, `/input`, `/interrupt`) não colidem e atendem nas duas grafias |
| `POST /api/sessions` com `issueRef` de issue sem run é **recusado** (409) | Criar o run aqui seria a sessão acionando a pipeline por conta própria, o que §49.2 proíbe literalmente |
| Abrir uma sessão que não pode adotar a que já está viva na janela é **recusado** (409) | Um `reattach` não re-executa o argv: sentar um `review` naquela janela lhe entregaria a conversa que ADR-07 proíbe, pelo pane em vez de pelo `--resume` |
| `label` acrescentado a `agent_sessions` (migration 17) | Uma sessão sem issue não tem nada que a nomeie além do uuid e de um branch gerado |

**Comportamento deliberadamente NÃO portado**

| O quê | Por quê |
|---|---|
| `autoName` — gerar o nome do branch com um modelo | Nomear um branch de rascunho não pode custar um round-trip a um LLM. O slug do rótulo mais o sufixo aleatório do próprio upstream (`generateFallbackBranchName`) resolve o mesmo problema de forma determinística e offline |
| `worktree archive` / `unarchive` / `restore` / `prune` / `label` / `profile` / `tab` | São operações sobre **worktrees**, não sobre sessões: pertencem a `runtime/worktree/` (Fase 5) e a `runtime/profiles.ts` (Fase 10). Trazê-las para `session` seria a segunda implementação que §25 proíbe |
| `buildSeedFromLinear` / `--linear` em `worktree add` | ADR-14 — Linear é `DISCARD` explícito |
| `createWorktreeTab` e os panes estacionados (`*-parked`) | Multi-aba por worktree é um modelo de layout próprio; ele depende de `runtime/profiles.ts`, que é da Fase 10, e nada em §49 o exige |
| `refreshAgentTerminal` (matar e recriar o pane do agente) | O `reattach`/`resume` de §27 já cobre reabrir sem destruir; um segundo caminho que destrói seria exatamente a regressão que §27 corrige |
| `switchToTmuxWindow` escrevendo `control.env` | Depende do `control.env` do upstream, que o Issue Flow não tem: `session attach` entrega o terminal ao tmux diretamente, no socket `-L issue-flow` (ADR-09) |
| `resolveBaseUrl` / `withServerConnection` — a CLI como cliente HTTP | §47.5: o registro é a autoridade e o servidor é consumidor dele. A CLI precisa funcionar sem nada escutando |
| `session link` no upstream | Não existe lá: promover a sessão a um run é o conceito de §49.2, que só faz sentido num sistema que tem workflow |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `src/agents/session/free-session.characterization.test.ts` | §49.5 (S1–S7) | 16 | ✅ |
| `src/agents/session/open.integration.test.ts` | §49.5 (S1–S3) contra git e tmux reais | 7 (1 condicional a "sem tmux") | ✅ |
| `src/commands/session.test.ts` | `bin/src/__tests__/worktree-commands.test.ts` (superfície de argumentos) | 14 | ✅ |
| `src/web/sessions-api.test.ts` | rotas de worktree de `backend/src/server.ts` | 16 | ✅ |
| `src/storage/db/migrations.test.ts` (migration 17) | novo — banco novo, banco migrado e reabertura | 2 | ✅ |
| `src/agents/session/reuse.test.ts` | preexistente, **não alterado** — a regra ADR-07 continua defendida onde mora | 15 | ✅ |

**Orçamentos**

| Métrica | Budget | Medido |
|---|---|---|
| T0→T4 (worktree pronta + agente iniciado) | ≤ 600 ms | **181 ms** (mediana de 3, `open.integration.test.ts`) |
| `git worktree add` | ≤ 150 ms | coberto pelo T0→T4 acima; nenhuma chamada nova foi acrescentada ao caminho |
| Boot da CLI | ≤ 250 ms | inalterado — `commands/session.ts` entra por `await import()` no `cli.ts`, como todo comando |

---

### Contrato HTTP tipado — `packages/issue-flow-contract` (Fase 8B)

**WebMux original**
`.references/webmux-main/packages/api-contract/` @ d8c9d5f — 1.487 linhas
(`schemas.ts` 776, `contract.ts` 527, `client.ts` 107, `client.test.ts` 74).
`@ts-rest/core` + `zod`: um roteador declarativo do qual o cliente do frontend é
derivado, com `strictStatusCodes` ligado.

**Comportamento existente**
- O contrato é a **única** fonte de tipos do frontend: `types.ts` só reexporta.
- `createApi()` embrulha o cliente do ts-rest e **desembrulha** a resposta:
  2xx devolve o corpo, o resto vira `Error` com a mensagem do servidor.
- Casos especiais que **não** podem se perder:
  - **`withEncodedPathParams`.** O ts-rest interpola parâmetros de rota
    literalmente. Uma branch chamada `feature/search` produziria um segmento a
    mais na URL e cairia noutra rota. A codificação acontece **uma vez**, na
    fronteira, e não em cada chamada.
  - **`errorMessageFromResponse` recursivo sobre corpo `string`.** Um servidor
    (ou um proxy) que responde `text/plain` com JSON dentro é caso real; sem a
    recursão o usuário vê o JSON cru em vez da mensagem que está dentro dele.
  - **`throwOnUnknownStatus: true`.** Um status fora do contrato é erro, não um
    corpo silenciosamente aceito.

**Implementação no Issue Flow**
`packages/issue-flow-contract/src/{schemas,contract,client,capabilities}.ts` —
estratégia: PORT (o `capabilities.ts` é NEW).

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| Pacote irmão com `package-lock.json` próprio | O `@ts-rest/core@3` tem peer em `zod@^3`; a CLI roda em `zod@4`. Manter as duas instalações separadas é o que impede uma de arrastar o major da outra. O bundle do painel resolve o contrato por alias do Vite, então nada disso chega ao runtime da CLI |
| Todo schema `Linear*` removido | ADR-14. Removidos, não mantidos como tipo morto |
| `InstanceSummary` / `MigrateProjects*` removidos | Eram o sensor do `MigrationBanner`, que é migração interna do WebMux (§48.1) |
| `BuiltInAgentIdSchema` com 5 providers | O upstream tem 2; a camada de agentes do Issue Flow é a base canônica (§45.2-L) |
| `ProjectSummary` com `id`/`root`/`served`, `prefix` nulável | §47.2: a chave é o `projectId` derivado do remote, nunca o path; e um projeto registrado sem execução nenhuma — o caso que §47 criou — não tem prefixo |
| `ProjectWorktreeSnapshot` ganha `executionId` e `issueRef` | §48.3: a mesma linha da sidebar é sessão livre (ambos nulos, ADR-16) ou workspace de uma execução |
| `streamTerminal` = `/ws/terminal` com token | ADR-10. O `WS /<prefix>/ws/:branch` sem autenticação do upstream não é portável como está |
| `SessionSnapshotSchema` = `z.record(z.unknown())` | A autoridade do snapshot é `sessionSnapshotSchema` em `src/schemas.ts`, versionado pela pipeline. Um painel que recusasse renderizar um snapshot que não conseguiu validar inteiro seria pior que um que renderiza o que reconhece |
| `SERVED_TODAY` + `capabilities.ts` | Metade do contrato foi portada **antes** do backend dela (fases 5–7, 10, 14). Sem esse gate a interface chamaria rotas que dão 404 e o usuário veria uma falha em vez de "não disponível neste monitor" |

**Comportamento deliberadamente NÃO portado**

| O quê | Por quê |
|---|---|
| Rotas `*/linear/*` e schemas associados | ADR-14 — se voltar, volta como Issue Provider |
| `/api/instances`, `/api/projects/migrate` | Sensor e ação de uma migração que é do WebMux, não do Issue Flow (§48.1, §50.8) |
| `POST /api/worktrees/:name/upload` | Não existe rota equivalente no Issue Flow e este porte não inventa backend. `uploadFiles()` recusa com mensagem honesta |
| `OneshotConfig.postToLinearOnDone` | Parte Linear do oneshot (ADR-14); `autoCloseOnDone` foi mantido |
| `linearCreateTicketOption`, `linearAutoCreateWorktrees` em `AppConfig` | Idem |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `packages/issue-flow-contract/src/client.test.ts` | `packages/api-contract/src/client.test.ts` | 4 | ✅ |

---

### Frontend Svelte — `packages/issue-flow/web/` (Fase 8B)

**WebMux original**
`.references/webmux-main/frontend/` @ d8c9d5f — 39 componentes `.svelte`
(9.075 linhas), 9 módulos `.ts` de produção e 19 arquivos de teste com
**148 casos** (4.624 linhas). Svelte 5 com runes, Tailwind 4, Vite 6, xterm.js,
`diff2html`; sem biblioteca de estado e sem router.

**Comportamento existente**
- **Estado global em runes dentro do `App.svelte`.** Não há store nem router: a
  "rota" é o **primeiro segmento do path**, que é o prefixo do projeto, e trocar
  de projeto é uma navegação de página inteira para `/<prefix>/`. Dois clientes:
  `api` (prefixado) e `hubApi` (global).
- **Superfície mobile de primeira classe:** `matchMedia("(max-width: 768px)")`,
  sidebar como overlay, `PaneBar`, scroll manual de toque no terminal e
  `safe-area-inset`.
- Casos especiais que **não** podem se perder:
  - **`Terminal.svelte`:** reconexão em `visibilitychange`/`focus`/`online`;
    `canRetryVisibleClose` (uma única retentativa automática, ou uma conexão que
    o servidor recusa vira laço infinito); OSC 52 → clipboard; auto-copy na
    seleção; Shift+Enter como CSI u via `sendKeys` (xterm manda `\r` para os
    dois, e é preciso bloquear os três tipos de evento ou o `keypress` ainda
    emite `\r`); scroll manual de toque só quando o tmux está capturando o mouse.
  - **`worktree-conversation.ts`:** a mensagem otimista do usuário é casada por
    `turnId`, não por id — o servidor devolve id diferente e casar por id
    duplicaria a mensagem na tela. É a mesma classe de problema que a identidade
    de bloco `${messageId}:${blockIndex}` do parser canônico resolve (§45.2-A).
  - **`MobileChatSurface.svelte`:** **um** stream por conversa, fechado só quando
    a conversa muda — reabrir por turno faz o servidor resemear a ordenação e os
    turnos se intercalam na tela; `lastStreamRevision` descarta evento fora de
    ordem; o polling de fallback assina o progresso e assenta, em vez de rodar
    para sempre; um turno iniciado no terminal não é run do backend, então é
    polido (não streamado) enquanto o agente está ocupado.
  - **`BranchSelector.svelte`:** `preventDefault` no `mousedown` de cada opção —
    sem isso o foco sai do campo de busca, o `focusout` fecha o dropdown e o
    clique nunca chega na opção.
  - **`WorktreeList.svelte`:** as barras de overflow medem a própria altura para
    calcular o `rootMargin` do `IntersectionObserver`; sem isso uma linha
    escondida atrás da barra é contada como visível.
  - **`BaseDialog.svelte`:** o clique só fecha quando o *pressionar* começou no
    backdrop — senão selecionar texto e soltar fora descarta o que o usuário
    estava fazendo.
  - **`CommentReviewDialog.svelte`:** a lista é ordenada por data para exibir,
    mas a seleção guarda o `originalIndex`; ordenar a seleção junto mandaria os
    comentários errados na primeira atualização.

**Implementação no Issue Flow**
`packages/issue-flow/web/{index.html,vite.config.ts,vitest.config.ts,svelte.config.js,tsconfig.json}`
e `packages/issue-flow/web/src/**` — estratégia: PORT integral (ADR-15), com
ADAPT em rotas, contrato, idioma e paleta.

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| Interface inteira em pt-BR | §50.4, opção A: o glossário fechado do painel atual é decisão de produto já tomada e documentada |
| `@theme inline` alimentado pelos tokens de papel do Issue Flow; nenhuma cor literal em classe utilitária | ADR-19. `inline` é obrigatório: sem ele o Tailwind copia a *declaração* para o próprio `:root`, congela os valores claros e o tema escuro vira no-op — falha silenciosa |
| `tokens.css` é cópia literal da camada de paleta de `web/public/app.css`, com teste de deriva | Enquanto os dois painéis convivem (ADR-18), nada mais impede a deriva, e uma deriva é invisível: os 18 pares medidos simplesmente deixam de descrever a tela |
| `themes.ts`: as 5 paletas viram os 3 modos do painel (`system`/`light`/`dark`) | 5 paletas alternativas seriam 5 tabelas de contraste que ninguém mediu. O tema do terminal passa a ser **derivado** dos tokens resolvidos na página (`getComputedStyle`), não duplicado ao lado deles |
| `Terminal.svelte`: URL autenticada, chaveada por sessão, quadros `o<offset>\n` / `s<offset>\n`, `lastOffset` na reconexão, aviso de `truncated` | ADR-10 e as duas adições de §15. O upstream repete 1 MB inteiro a cada `visibilitychange` — trocar de aba duas vezes custava dois megabytes |
| Polling do `App.svelte` (5 s / 1 s) → assinatura de `/api/stream` | §35: teto duro de 250 ms p95 em output→tela. O intervalo sobrevive só como rede de segurança de 15 s, pausada em aba oculta |
| Todo acesso a `localStorage` em `try`/`catch`, com chaves `issue-flow:` | O painel atual já aprendeu que armazenamento bloqueado **lança**; o upstream chama direto. Armazenamento bloqueado significa "a preferência não sobrevive ao reload", nunca "o painel não carrega" |
| `text-white` → `text-accent-text` em todo preenchimento sólido | Branco sobre os preenchimentos claros do tema escuro dá 2,98:1 |
| Toda superfície de worktree/sessão/agente atrás de capability | Este monitor pode ser o que uma execução da pipeline subiu inline, que serve execuções e nada mais. Uma lista vazia leria como defeito |
| `publicDir: false` no Vite | `web/public/` aqui é o **painel antigo**, não os estáticos deste app; o default copiaria os dois para dentro de `dist/` |
| `files` do `package.json` restrito a `web/public` + `web/dist`, com `.npmignore` em `web/` | Com `files: ["web"]` o tarball levava `web/src/**` e o cache do Vite, e **não** levava `web/dist` (o `.gitignore` de `web/` o excluía) — ou seja, o pacote publicado não teria o painel novo |
| `src/web/server.ts` passa a carregar dois diretórios e sobrepor o do painel novo | ADR-18: o painel novo é a superfície padrão e o antigo fica em `/legacy/` até §50.7 fechar. O upstream serve um frontend só, então não há o que portar aqui |
| `/legacy` sem barra responde 301 | O `index.html` do painel antigo referencia `app.css`/`app.js`/`status.json` por caminho **relativo**. É isso que permite servir os mesmos bytes nos dois pontos de montagem sem reescrever nada — e é isso que quebra sem a barra final |
| `'legacy'` acrescentado a `RESERVED_PROJECT_PREFIXES` | Senão um projeto chamado `legacy` sombreia a rota do painel antigo |
| Fallback: sem build, `/` continua sendo o painel antigo | Um checkout que nunca rodou `npm run build:web` fica com um monitor funcional em vez de um 404 |

**Comportamento deliberadamente NÃO portado**

| O quê | Por quê |
|---|---|
| `MigrationBanner.svelte` (46 linhas) | Avisa sobre instâncias antigas do **WebMux**; a migração é dele (§48.1, §50.8) |
| `LinearPanel` · `LinearBadge` · `LinearDetailDialog` · `LinearPostDialog` (314 linhas) | ADR-14. Junto saem o painel na sidebar, o badge no header e na linha, e as duas rotas de "postar conversa" |
| As 5 paletas de `themes.ts` | Ver adaptações: são 5 tabelas de contraste não medidas contra a decisão de produto de §50.0 |
| `Notification` do navegador (permissão + notificação nativa) | Depende do canal de notificações do WebMux, que não existe aqui. Os toasts permanecem; a notificação de SO volta com o canal que a alimentaria |
| Upload de imagem por drag/paste (a *chamada*) | A UI foi portada inteira; só a rota não existe. `uploadFiles()` recusa com mensagem honesta e o terminal escreve `[Erro no envio: …]` |
| ~~`sendKeys` / `selectPane` como operação de servidor~~ | **Resolvido depois desta ficha.** O cliente já os mandava; o backend respondia `not available yet`. `src/web/terminal-ws.ts` passou a encaminhá-los ao gateway tmux (`sendHexKeys` / `selectPane`), que já os tinha — nenhum dos dois pode passar pelo pty do espectador, que é *leitor* do pane. Ver o commit `feat(web): let the terminal send a key sequence and pick a pane` |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `web/src/App.test.ts` | `frontend/src/App.test.ts` | 26 portados + 3 | ✅ |
| `web/src/lib/worktree-conversation.test.ts` | idem upstream | 15 | ✅ |
| `web/src/lib/WorktreeConversationPanel.test.ts` | idem upstream | 14 | ✅ |
| `web/src/lib/worktree-list.test.ts` | idem upstream | 12 portados + 1 | ✅ |
| `web/src/lib/MobileChatSurface.test.ts` | idem upstream | 11 | ✅ |
| `web/src/lib/utils.test.ts` | idem upstream | 8 portados + 2 | ✅ |
| `web/src/lib/ask-user-question.test.ts` | idem upstream | 8 | ✅ |
| `web/src/lib/WorktreeList.test.ts` | idem upstream | 7 portados + 1 | ✅ |
| `web/src/lib/TopBar.test.ts` | idem upstream | 6 | ✅ |
| `web/src/lib/api.test.ts` | idem upstream | 6 portados + 3 | ✅ |
| `web/src/lib/Terminal.test.ts` | idem upstream | 5 portados + 4 | ✅ |
| `web/src/lib/WorktreeLabelDialog.test.ts` | idem upstream | 5 | ✅ |
| `web/src/lib/AskUserQuestionCard.test.ts` | idem upstream | 5 | ✅ |
| `web/src/lib/ToastStack.test.ts` | idem upstream | 4 | ✅ |
| `web/src/lib/SettingsDialog.test.ts` | idem upstream | 4 portados + 1 | ✅ |
| `web/src/lib/BranchSelector.test.ts` | idem upstream | 4 | ✅ |
| `web/src/lib/PrStatusGroup.test.ts` | idem upstream | 3 | ✅ |
| `web/src/lib/AgentStatusIcon.test.ts` | idem upstream | 3 portados + 1 | ✅ |
| `web/src/lib/DiffDialog.test.ts` | idem upstream | 2 portados + 1 | ✅ |
| `web/src/tokens.test.ts` | novo — guarda de deriva da paleta (ADR-19) | 3 | ✅ |
| `src/web/server.test.ts` (mount duplo) | novo — `/` = painel novo, `/legacy/` = antigo, 301 sem barra, fallback sem build, `Content-Type` por extensão | 1 novo + 3 atualizados | ✅ |
| `src/storage/projects/prefix.test.ts` | atualizado — `legacy` no conjunto reservado | 1 atualizado | ✅ |

**Total: 148 casos portados dos 148 do upstream, mais 20 acrescentados.**
Seis casos do `App.test.ts` eram de Linear (ADR-14); em vez de sumirem da
contagem foram **substituídos** por seis que cobrem o que ocupou o lugar deles —
o gate de capability, o vínculo opcional com a issue (ADR-16/ADR-17), o socket
autenticado por sessão (ADR-10) e o canal de push que substituiu o polling
(§35). O `TopBar.test.ts` faz o mesmo com o caso do badge do Linear.

**Orçamentos**

| Métrica | Budget | Medido |
|---|---|---|
| Bundle do painel (gzip, sem xterm) | — | 88,5 KB (`index`) + 7,7 KB de CSS |
| xterm, em chunk separado | — | 73,9 KB gzip, carregado com o terminal |
| `DiffDialog` + `diff2html`, sob demanda | — | 14,7 KB gzip, importado só ao abrir o diff |
| Build do painel (`vite build`) | — | 1,35 s |
| Suíte do painel (20 arquivos, 168 casos) | — | 2,7 s |
| Latência output → tela | ≤ 250 ms p95 | não medido aqui — o transporte é o de `src/web/` (Fase 1/8), e este porte só troca polling por assinatura de `/api/stream` |

### Canal estruturado de conversa — `agents/session/{claude-stream,claude,codex,codex-conversation,export}.ts` (Fase 7B)

**WebMux original**
`.references/webmux-main/backend/src/adapters/claude-cli.ts` @ d8c9d5f — 767 linhas ·
`.references/webmux-main/backend/src/adapters/codex-app-server.ts` @ d8c9d5f — 862 linhas ·
`.references/webmux-main/backend/src/services/conversation-export-service.ts` @ d8c9d5f — 380 linhas ·
`.references/webmux-main/backend/src/services/claude-conversation-service.ts` @ d8c9d5f — 237 linhas
(apenas `normalizeSessionMessages`) ·
`.references/webmux-main/backend/src/services/worktree-conversation-service.ts:110-545` @ d8c9d5f
(apenas a metade pura: os construtores de mensagem por item e os predicados de turno ativo).

Base canônica por `§45.1-A` e `§45.1-B`: **WebMux** para o parsing de conversa do Claude e
para o cliente do `codex app-server`. `§45.1-C` mantém a orquestração de invocação no Issue
Flow, e é por isso que nada aqui lança agente.

Esta ficha fecha a pendência registrada na ficha da **Fase 7**, que deixou os dois adapters
de fora por misturarem duas responsabilidades numa fase de alto risco.

**Comportamento existente**
- `parseClaudeStreamLine` é **pura**: uma linha de `claude -p --output-format stream-json
  --include-partial-messages` vira `{ sessionId, messageStart, blockStart, assistantDelta,
  blocks, completeSessionId, error }`. Linha malformada vira `null`, nunca exceção — a CLI
  intercala diagnósticos próprios com o stream.
- **Identidade de bloco `${anthropicMessageId}:${contentBlockIndex}`** (`§45.2-A`).
  `content_block.index` é escopado à *mensagem de API corrente* e **reinicia em 0 a cada
  `message_start`**; um turno de usuário costuma conter várias mensagens de API (uma antes
  da tool call, outra depois do resultado). O índice sozinho colide e dois parágrafos
  distintos colapsam numa bolha só. A mesma identidade é reproduzida ao ler a transcrição
  persistida — inclusive contando os blocos que ela **não** renderiza — e é isso que impede
  mensagem duplicada quando o mesmo bloco chega pelo stream e pelo arquivo.
- `tool_result` aceita `string` **ou** array de blocos de conteúdo; ambos são reais.
  Truncamento em 2.000 chars com sufixo contando o resto, aplicado igualmente nas duas
  rotas — duas regras de truncamento fariam as duas cópias do mesmo bloco diferirem pela
  cauda, e o bloco se reescreveria na tela ao ler a transcrição.
- `tool_result` é chaveado por `tool_result:${toolCallId}`, não por posição: é o que o
  correlaciona com a tool call que o produziu.
- Transcrição: `~/.claude/projects/<cwd codificado>/<sessionId>.jsonl`. A codificação
  (`[^A-Za-z0-9]` → `-`) é **lossy** e já mudou entre releases, então uma falha no
  diretório codificado cai numa varredura ampla que lê o `cwd` gravado em cada arquivo.
- `codex app-server`: `pending: Map<number, PendingRequest>` com `nextId` monotônico;
  `initialized` enviado **depois** do handshake (sem ele o servidor recusa todo request
  posterior); toda resposta validada por schema zod antes de ser entregue; erro JSON-RPC
  vira `CodexAppServerRequestError` tipado; stdout e stderr lidos por leitores
  independentes (um stderr não drenado enche o pipe e trava o protocolo).
- **`rejectPending(error)` quando o processo morre** (`§45.2-B`). Sem isso toda requisição
  em voo espera para sempre uma resposta de um processo que já não existe. O watchdog não
  pega: não há filho da invocação para observar; o chamador simplesmente fica bloqueado num
  `await` que nunca resolve.
- O decodificador de stdout é reusado com `{ stream: true }` entre chunks: uma fronteira de
  chunk cai no meio de um caractere multi-byte com frequência suficiente para importar, e
  linha corrompida é resposta improcessável.
- A união de itens de thread termina num membro genérico `{type, id}` e o status do turno é
  `z.string()`, não enum: é o que faz uma versão nova do Codex não quebrar o painel.
- Export: payload versionado com `conversation`, e o parser **preenche `order` e `kind`**
  quando faltam, para que um export escrito por uma release anterior continue legível.
  `escapeFence` neutraliza ``` dentro do texto de uma mensagem — sem isso a mensagem fecha
  o bloco em que está sendo renderizada e o resto da conversa escapa para o documento.
- Casos especiais que NÃO podiam se perder: a identidade `${messageId}:${blockIndex}` e o
  fato de a transcrição contar **todos** os blocos; o `rejectPending` no `exited`; o
  `initialized` pós-handshake; o decoder com `stream: true`; o membro genérico da união; a
  varredura ampla dos diretórios de projeto do Claude; o `escapeFence`; a tolerância de
  `order`/`kind` ausentes.

**Implementação no Issue Flow**
`packages/issue-flow/src/agents/session/claude-stream.ts` — estratégia: **ADAPT**
`packages/issue-flow/src/agents/session/claude.ts` — estratégia: **ADAPT**
`packages/issue-flow/src/agents/session/codex.ts` — estratégia: **PORT**
`packages/issue-flow/src/agents/session/codex-conversation.ts` — estratégia: **PORT**
`packages/issue-flow/src/agents/session/export.ts` — estratégia: **ADAPT**
`packages/issue-flow/src/agents/session/conversation.ts` — **NEW** (forma compartilhada)
`packages/issue-flow/src/core/stream.ts` — **MERGE** (passa a delegar a gramática)

**A sobreposição com `src/core/stream.ts` — invariante 13**

`§22` marca `claude-cli.ts` como **ADAPT** e não PORT justamente porque este projeto já lia
o stream do Claude. A convergência foi feita, e a divisão é esta:

| Responsabilidade | Onde mora agora |
|---|---|
| **Gramática** de uma linha `stream-json` — que tipos de evento existem e o que cada um carrega | `agents/session/claude-stream.ts`, um só módulo |
| Desfecho headless: texto do `result`, `is_error`, `usage`, transcrição crua, heartbeat do watchdog | `core/stream.ts` (inalterado em forma) |
| Conversa **gravada**: ler, listar e retomar por id; correlação de `tool_result`; identidade de bloco; deltas parciais | `agents/session/claude.ts` |

`core/stream.ts` mantém `StreamOutcome` byte a byte e continua fazendo **um** `JSON.parse`
por linha; o que mudou é que a leitura do `result` passou a ser
`parseClaudeStreamRecord(record)` em vez de `record.type === 'result'` escrito à mão.
`ParsedClaudeStreamLine` ganhou um campo **aditivo** `result: { text, isError } | null`
para isso — o upstream não precisava dele porque não tinha modo headless. `usage` continua
em `core/metrics.ts`: não é gramática de stream, é métrica deste projeto.

O que `session/claude.ts` **acrescenta**: ler uma conversa gravada, listar conversas por
`cwd`, retomar por id, correlacionar `tool_result`, manter o cursor `messageId`/`blockIndex`
entre linhas e emitir mensagens com identidade estável. O que ele **delega**: a gramática,
inteira.

**Adaptações realizadas**

| O quê | Por quê |
|---|---|
| `Bun.file`/`Bun.write` → `node:fs/promises`; `Bun.env.HOME` → `os.homedir()` injetável | Runtime. A injeção do `home` é o que permite testar o gateway sem tocar no `~` real |
| `Bun.spawn(["codex","app-server"])` → `execa('codex', ['app-server'])`, argv | Runtime + ADR-04. **Não** passa pelo `run()` de `utils/shell.ts`: `run()` aguarda um comando terminar e devolve a saída, que é o oposto de um daemon com stdin aberto. É a mesma fronteira que `agents/claude.ts` já cruza com execa para o stream. O filho é registrado em `core/shutdown.ts`, o que o upstream não fazia — um Ctrl-C não deixa daemon para trás |
| `Bun.Subprocess` → interface `CodexAppServerProcess` injetável | O upstream não conseguia testar o cliente sem `codex` instalado. Com a interface, o handshake, o mapa de pendências e o caminho de saída são exercitados contra um fake — e o `codex.integration.test.ts` cobre o protocolo real |
| Interface TS + schema zod anotado (duas declarações) → **schema como fonte única**, tipos por `z.infer` | zod 4 deriva a opcionalidade da chave a partir do tipo de *input*: campos `unknown` (`error`, `gitInfo`, `arguments`) inferem como opcionais e deixam de satisfazer uma interface que os declara obrigatórios. Manter as duas declarações custaria um cast em cada fronteira de parse, que é exatamente o que a validação existe para evitar |
| `.transform()` redundante em `TurnSchema`/`ThreadSchema` removido | O transform reconstruía o objeto campo a campo; `z.object` em modo strip já produz exatamente essas chaves. Nada observável muda |
| `log.warn(...line.slice(0,120))` numa linha de transcrição corrompida → aviso **sem conteúdo**, com contagem, e injetável | `§45.3` lista "telemetria com redaction" como garantia do Issue Flow e "log cru" como a forma degradada. Uma linha de transcrição é texto de usuário e de modelo. O sinal (uma linha se perdeu, e quantas) é preservado; o payload não vaza |
| stderr do `app-server` só é entregue se o chamador pedir (`onStderr`) | Mesmo motivo. O pipe continua sendo drenado sempre — não drenar travaria o protocolo |
| `ClaudeCliClient.sendMessage` (spawn de `claude -p`) → **não portado**; no lugar, `createClaudeStreamReader()` sobre linhas | `§25`: um só agent launcher. Ver "NÃO portado" |
| `AgentsUiConversationMessage` do `packages/api-contract` → `ConversationMessage` local em `conversation.ts` | `packages/issue-flow/src` não depende de `@issue-flow/contract` (só `web/` depende), e o contrato está preso a zod 3 enquanto este pacote está em zod 4. A forma é **estruturalmente idêntica** — mesmos campos, mesma ordem, mesma opcionalidade — para ser atribuível sem cast no dia em que a dependência existir. Ver "Pendência" |
| Export para o Linear → export para **arquivo**, via `writeFileAtomic` | ADR-14 descarta Linear. `§45.3` proíbe `writeFile` direto; um export é artefato e é gravado como todo artefato deste projeto |
| `buildPriorConversationSection` → `buildConversationSeedPrompt`, com `CONVERSATION_DATA_NOTICE` e cerca `<prior-conversation>` | Conversa é texto **escrito por um modelo**. Reinjetá-la sem dizer isso é injeção de prompt com o atacante já dentro. É a mesma situação de `agents/handoff/types.ts`, e é respondida do mesmo jeito, com a redação deliberadamente parecida para que um agente que já respeita a cerca de handoff reconheça esta |
| `webmux: 1` → `issueFlowConversation: 1` | Nomeação do projeto. Não há dado upstream para ler, então não há compatibilidade a manter — a tolerância a `order`/`kind` ausentes, essa sim, foi portada |
| `buildCodexItemConversationMessages` trazido de `worktree-conversation-service.ts` | `§22` só endereça `codex-app-server.ts`, mas sem a tradução o porte entrega um cliente tipado que nada renderiza — meia entrega. Só a **metade pura** veio; o serviço com estado ficou onde estava |

**Comportamento deliberadamente NÃO portado**

| O quê | Origem | Por quê |
|---|---|---|
| `ClaudeCliClient.sendMessage` — lançar `claude -p` e ler o stream | `adapters/claude-cli.ts:~560` | Seria um **segundo agent launcher**, que é literalmente o que `§25` proíbe ("Agent launcher: `src/agents/` — dois modos, um só launcher") e o que `§45.1-C` decide manter no Issue Flow: timeout absoluto, watchdog de inatividade, registro para shutdown, classificação de falha, `usage`, `harnessVersion`, failover. Nada disso existe no upstream. O que a Fase 8B precisa é *ler* o stream, e `createClaudeStreamReader()` faz isso sobre linhas de qualquer origem — inclusive as que `agents/claude.ts` já entrega por `onLine` |
| `ClaudeCliRunHandle` (`completion`/`interrupt`/`sessionId` como Promise) | `adapters/claude-cli.ts` | Consequência do item acima: é a alça de um processo que este módulo não inicia. `interrupt` no modo interativo já é `agents/tty.ts`; no headless é o watchdog |
| `services/claude-conversation-stream-service.ts`, `agents-ui-stream-service.ts`, `worktree-conversation-service.ts` (a metade com estado) | serviços do painel | `§22` não os endereça a esta fase. Eles carregam `revision`, assinaturas, persistência de meta em `meta.json` e bookkeeping de abas — estado de UI e de worktree que este projeto guarda em SQLite e em `runtime/`. Portá-los aqui seria trazer o modelo de estado do upstream junto com o parser |
| `exportConversationToLinear`, `buildSeedFromLinear`, `downloadWebmuxAttachmentDefault`, `defaultSeedFromLinearDeps` | `conversation-export-service.ts` | ADR-14 — Linear é `DISCARD` explícito. É metade do arquivo |
| `buildIssueHeader` (cabeçalho `Fixes ENG-1`, `branchName` do Linear) | `conversation-export-service.ts` | Mesmo motivo. O que ele resolvia — dar contexto ao agente antes da conversa — virou o parâmetro `header` de `buildConversationSeedPrompt`, **fora** da cerca, porque essa metade é instrução do operador e não texto de modelo |
| `adapters/session-discovery.ts` | `§22` | Continua fora, e pelo mesmo motivo da Fase 7: descobrir conversas no disco é insumo de *reconciliação* (Fase 11). O que esta fase acrescenta é `listSessions(cwd)` no gateway do Claude, que é a consulta, não a varredura periódica |
| Reset de `blockIndex` em `message_start` | — | Foi escrito e **removido**. Toda mensagem que emite bloco vem precedida do seu `content_block_start`, que define o índice; resetar pareceria mais limpo e mudaria a identidade de um bloco que chegasse sem ele. Invariante 3: não redesenhar durante o porte |

**Testes de paridade**

| Teste | Origem | Casos | Estado |
|---|---|---|---|
| `src/agents/session/claude-stream.test.ts` | `__tests__/claude-cli.test.ts` (metade do parser) + novos | 23 (5 portados) | ✅ |
| `src/agents/session/claude.test.ts` | `__tests__/claude-cli.test.ts` (transcrição) + `claude-stream-block-identity.test.ts` + novos | 23 (5 portados) | ✅ |
| `src/agents/session/codex.test.ts` | `__tests__/codex-app-server.test.ts` + novos (protocolo contra fake) | 22 (5 portados) | ✅ |
| `src/agents/session/codex-conversation.test.ts` | novos — a tradução não tinha suíte própria no upstream | 23 | ✅ |
| `src/agents/session/export.test.ts` | `__tests__/conversation-export-service.test.ts` + novos | 21 (8 portados) | ✅ |
| `src/agents/session/conversation.integration.test.ts` | novo — handshake e `thread/list` contra o `codex app-server` real; `rejectPending` contra o daemon real; turno real do `claude` sob `ISSUE_FLOW_E2E_CLAUDE=1` | 3 | ✅ (2 executados, 1 condicional) |
| `src/agents/claude.test.ts`, `src/core/headless.test.ts` | preexistentes, **não alterados** — defendem que a delegação não mudou o desfecho headless | 36 | ✅ |

**Contagem upstream.** Os quatro arquivos citados têm **31** casos reais (`it`): 7 em
`claude-cli.test.ts`, 3 em `claude-stream-block-identity.test.ts`, 5 em
`codex-app-server.test.ts` e 16 em `conversation-export-service.test.ts`.
Os números de `§22`/`§45.1` (14 + 9 + 7 + 9) não correspondem a nenhuma contagem
verificável na baseline congelada — nem a de casos (31), nem a de asserções (70:
9 + 5 + 9 + 47). São estimativas do plano que não se confirmaram, e a coluna acima mede
contra a contagem real.

**Portados: 23 de 31.** Os 8 restantes são todos de `conversation-export-service.test.ts` e
todos de Linear: os 4 de `exportConversationToLinear` (attachment, criação de issue por
team key, comentário que falha sem derrubar o export, upload que falha) e os 4 de
`buildSeedFromLinear` (preferir attachment do webmux, cair para a integração GitHub,
`source: none`, cabeçalho do Linear). Cada um asserta contra um stub da API do Linear e
não sobrevive a ADR-14. O que ocupou o lugar deles é o transporte por arquivo
(`writeConversationExport`, round-trip e ausência de `.tmp`) e a regra do dado
(`CONVERSATION_DATA_NOTICE` antes de qualquer citação, cerca fechada, `escapeFence` numa
mensagem hostil) — nenhum dos dois existia no upstream.

**Acrescentados: 92 casos** que o upstream não cobria. Os que mais importam: linha
malformada e JSON que não é objeto → `null`; tipo de evento desconhecido → forma vazia (uma
CLI mais nova não é falha de parse); truncamento com sufixo de contagem; identidade de bloco
**igual** entre stream ao vivo e transcrição relida; bloco pulado ainda avança o contador;
`rejectPending` com o daemon real e com o fake; handshake que falha não deixa cliente
meio-aberto; stderr drenado sem chegar ao protocolo; e a cerca de dado do reseed.

**Risco inverso (`§45.3`) — conferido**

| Garantia do Issue Flow | Preservada? |
|---|---|
| `writeFileAtomic` | ✅ — `export.ts` é o único que escreve, e escreve por ele |
| Chokepoint `run()` + allowlist de git destrutivo | ✅ — nenhum comando git aqui. O único spawn é `execa('codex', ['app-server'])`, argv, registrado para shutdown, com a justificativa acima |
| argv | ✅ — nenhuma string de shell em nenhum caminho |
| Taxonomia de falha + retry + failover | ✅ — intacta; nada aqui entra no caminho de invocação |
| Watchdog de inatividade | ✅ — `core/stream.ts` mantém `onLine` e o heartbeat |
| Permissão semântica por fase | ✅ — nenhum `yolo`; este módulo não decide permissão |
| Autoridade de estado explícita | ✅ — a conversa continua sendo do provider (§27); nada aqui grava `agent_sessions` |
| Auth em superfície web | ✅ — não há superfície web nova |
| Isolamento de `review`/`verify` | ✅ — `reuse.ts` intocado; nada aqui seleciona sessão |
| Telemetria com redaction | ✅ — **reforçada**: o aviso de linha corrompida perdeu o trecho da linha que o upstream logava |

**Orçamentos**

| Métrica | Budget | Medido |
|---|---|---|
| Handshake + `thread/list` contra o `codex app-server` real | — | **154 ms** (`conversation.integration.test.ts`) |
| `rejectPending` com o daemon real morto | — | **174 ms** até a rejeição, incluindo o handshake |
| Latência output → tela | ≤ 250 ms p95 | não medido aqui — o transporte é o de `src/web/` (Fase 1/8); este módulo é push por construção (o reader emite por linha lida, sem polling) |
| Boot da CLI | ≤ 250 ms | inalterado — nada em `session/` entra no caminho de boot; `core/stream.ts` ganhou um import de um módulo sem dependências |
| Contexto re-ingerido por story | 0 | inalterado |

**Pendência registrada**

`ConversationMessage`/`ConversationState` em `agents/session/conversation.ts` são um espelho
local de `AgentsUiConversationMessage`/`AgentsUiConversationState` do
`packages/issue-flow-contract`. A duplicação existe porque `packages/issue-flow/src` não
depende daquele pacote hoje (só `web/` depende) e porque os dois estão em versões diferentes
do zod. **Quando a dependência existir, o tipo deve vir do contrato e este arquivo deve
sumir.** Até lá, qualquer campo acrescentado a um dos dois precisa ser acrescentado ao outro
na mesma mudança.
