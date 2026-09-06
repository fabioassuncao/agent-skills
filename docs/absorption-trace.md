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
