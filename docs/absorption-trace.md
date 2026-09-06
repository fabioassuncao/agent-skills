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
| `adapters/claude-cli.ts` (767 LOC) e `codex-app-server.ts` (862 LOC) | §22 | São o **canal estruturado** — leitura de conversa e streaming — e o Issue Flow já tem o dele em `core/stream.ts` para o modo headless. §22 os endereça a `src/agents/session/{claude,codex}.ts` como trabalho próprio; portá-los junto com o wrapper TTY misturaria duas responsabilidades numa fase de alto risco. Registrado como pendência explícita |
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
