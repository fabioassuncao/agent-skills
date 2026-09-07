# src/agents/session

The durable link between a model conversation and what it is being used for.

§27 of the absorption plan separates seven concepts that are easy to conflate.
Only one of them is persisted here:

| Concept | Owner | Where it lives |
|---|---|---|
| `AgentConversation` — the model's history | **the provider** | `~/.claude/**`, `~/.codex/**` |
| `RuntimeSession` — worktree, ports, services | `src/runtime/` | `worktrees` + disk |
| tmux session — the multiplexer | tmux | ephemeral |
| **`AgentSession`** — the link, plus liveness | **here** | `agent_sessions` |

## Invariants

- **The conversation is never copied and never parsed.** The provider owns it;
  this table holds its id so `--resume` can point at it. Reconstructing state by
  reading a provider's JSONL would be the TTY-parsing mistake wearing a
  different hat (ADR-05).
- **`runId`, `phase` and `storyId` are nullable** (ADR-16). A session opened by
  a person, with no issue and no workflow, is the same entity with those fields
  empty. That is what makes a free session possible without a second execution
  model — and it is why nothing here may assume they are present.
- **`review` and `pr-review` never reuse a session** (ADR-07), and no
  configuration changes it. `assertSessionReuseAllowed` throws rather than
  warning: a reviewer continuing the conversation that wrote the code has
  already agreed with itself, and the independence *is* the mechanism behind the
  word "verified".
- **The pipeline never adopts a free session.** A person opened it and is
  presumably still in it; a workflow taking it over would interleave two
  conversations in one history — and would route a verification through a
  conversation nobody audited.
- **A row is narrowed, never cast, on the way out of storage.** The database can
  hold a `phase` or `provider` written by a newer release. An unknown phase
  becomes `null`; an unknown provider makes the row unusable and it is dropped.
- **Status is reported, not inferred.** `orphaned` is set by reconciliation when
  the outside world contradicts the row (ADR-08). Nothing here deletes a row
  because a pane is gone.

## Never

- Never read a provider's conversation file to decide anything.
- Never let a phase that must stay independent continue an existing session,
  however the caller asks.
- Never assume `runId`/`phase`/`storyId` are set.

## Two modes, one model — opening a session (`open.ts`, `context.ts`)

`openAgentSession` is the only way an agent is put in a pane, and it serves
both modes. A caller that passes `runId`/`phase`/`storyId` gets a workflow
session; a caller that passes none gets a free one (§49). There is no second
launcher, and adding one would be the duplication §25 forbids.

- **`context.ts` is the wiring, not a second model.** The CLI and the HTTP
  surface both call `resolveAgentSessionDeps` so they cannot disagree about
  which profile a session used or which tmux socket its window is on.
- **The branch is generated when nobody names one.** Explicit creation through
  the configured HTTP flow uses the canonical auto-namer ported in
  `config/auto-name.ts`; `session new` keeps the offline
  `session/<slug>-<8 hex>` fallback so the direct CLI never requires a model or
  network call. Requiring a branch would reinstate the ceremony a free session
  exists to skip.
- **`decideAdoption` answers two different questions.** *Resumable* is
  `selectReusableSession`, where ADR-07 lives and is never restated. *Adoptable*
  is wider: a live session with no conversation id yet still owns the window,
  and a `reattach` does not re-run the agent argv — so a second row created for
  that pane would send prompts to an agent it never started.
- **A caller that may not adopt the live session is refused, not seated beside
  it.** Reattaching into somebody else's pane would hand a `review` the
  conversation ADR-07 forbids, through the window rather than through
  `--resume`. It is the same violation in different clothing, and it answers
  409.
- **A free session never adopts the pipeline's conversation either.** The
  mirror image of the rule above, and the one that is easy to lose: the
  pipeline is forbidden from taking a person's session, so a person must not
  silently inherit a run's.
- **Nothing here writes a `runs` row.** A free session that could bring an
  execution into being would be a free session starting the pipeline.
  Promotion is `linkSessionToRun`, it is explicit, and it refuses when the run
  does not already exist.
- **`label` is a caption, never an identity.** Nothing is looked up by it; it
  exists because a session with no issue has only a uuid and a generated branch
  to show a person (migration 17).

## Never

- Never open a session by assembling a worktree, a tmux plan and a row by hand;
  call `openAgentSession`.
- Never mint a `runs` row to make a link succeed.
- Never let a phase that must stay independent land in a window somebody else's
  agent is already running in.

## Tabs — several AgentSessions, one worktree (`tabs.ts`)

- **A tab is another `AgentSession` row in the same worktree.** `tabId` on the
  wire is exactly `AgentSession.id`; `conversationId` remains the provider's
  separate identity. There is no tabs table and no copied transcript.
- **The worktree id, not the branch, is the incarnation boundary.** A reused
  branch must never adopt, stop or display sessions from its prior checkout.
- **`tabs[0]` is the root.** Forks point to it with `parentSessionId`, and
  `tabSequence` orders them. The worktree's `tabSequenceCounter` is monotonic,
  so deleting Fork 2 never makes a later fork reuse that label.
- **The active tab belongs to the worktree binding.** Selection updates
  `activeAgentSessionId`; it never stops or recreates a provider process.
- **Only Claude and Codex are forkable.** A provider without a native,
  resumable fork primitive is refused instead of approximated with a new
  conversation. Review and PR-review are refused too: their independence rule
  is the same `assertSessionReuseAllowed` guard used by ordinary resume.
- **Conversation identity is structured and durable.** Codex uses app-server
  `thread/start` / `thread/fork`, Claude is launched with a pinned session id,
  and no tab operation scans provider files or guesses by cwd.
- **A stable pane id is necessary but not sufficient identity.** Every managed
  pane carries a durable random `paneToken`; tmux's `@issue-flow-owner` pane
  option encodes both that nonce and the project owner session. An operation may move, select, stop or
  reconcile it only after proving the full tuple `{paneId, project session,
  worktree main/parking window, paneToken}`. tmux may reuse `%N` after a server
  restart; a matching number without the matching tuple is another process.
- **Every create/select/delete/refresh is under the durable branch lock.** The
  lock covers tmux and both persisted rows, preventing duplicate sequences and
  split-brain active pointers across CLI and HTTP processes.
- **Launching and activating are one durable write.** Once a new pane is
  running, its AgentSession row and the worktree's active pointer are committed
  in one transaction. If that commit fails, only the freshly launched,
  re-authenticated pane is killed; an existing reattached process is preserved.
  The same cleanup boundary covers failures resolving, tagging or reading the
  pane after layout. If ownership cannot be proved or strict cleanup fails, the
  worktree stays in place and an `orphaned` row records the possible writer. A
  newly created checkout that collides with a stale same-branch tmux window is
  especially never removed after a failed reattach: that window predates the
  call, so neither its process nor the checkout underneath it may be destroyed.
- **Reconciliation preserves evidence.** A missing pane marks the AgentSession
  `orphaned`; it never deletes the row. Refresh reattaches a live pane or
  resumes that same conversation when dead. It never kill/recreates a live one.
- **Every worktree-opening surface allocates service ports before creation.**
  `openManagedWorktrees` and the interactive runtime inspect the durable
  bindings, call `allocateServicePorts`, and pass the result to
  `openAgentSession`. Reopening reuses the allocation already stored in the
  binding; it does not silently choose a second port set.
- **The root cannot be deleted.** Closing a fork requires confirmation at the
  human-facing caller and kills only that fork's pane. An authoritatively absent
  pane is a dismissible orphan; a present pane whose owner tuple differs is
  foreign and makes deletion fail closed.
- **Stopping participates in the same lock and tab projection.** Stopping an
  active fork first promotes an authenticated sibling (the visible sibling or
  root), persists the new active pointer, then persists stop intent and kills
  only the authenticated target. A failed kill restores the live row or reports
  both the original and compensation failures. Whole-worktree teardown proves
  every target first and changes every exact-worktree sibling to stopped in one
  database operation.

## O canal estruturado — `claude-stream.ts`, `claude.ts`, `codex.ts`, `codex-conversation.ts`, `export.ts`

ADR-06 faz do terminal e do chat estruturado **canais independentes**. Este é o
segundo: nada aqui depende de `runtime/terminal/`, nada aqui escreve em pane, e
nada aqui lê a tela de um agente.

Ler o arquivo de conversa do provider **não** é o erro que ADR-05 proíbe. O que
ADR-05 proíbe é inferir estado de workflow do que aparece num TUI; estado de
agente continua vindo de hook (`agents/hooks/`). Aqui só se lê o histórico do
modelo, e o resultado é dado que um painel renderiza e um export grava.

### Uma gramática, dois leitores (invariante 13)

`core/stream.ts` já lia o `stream-json` do Claude antes da absorção. Não há uma
segunda cópia:

- **`claude-stream.ts` é a gramática** — que tipos de linha existem e o que cada
  um carrega. Um só módulo, e é dele que `core/stream.ts` lê o `result`.
- **`core/stream.ts` é o desfecho headless** — texto do `result`, `is_error`,
  `usage` (que é `core/metrics.ts`, não gramática), transcrição crua e o
  heartbeat do watchdog. `StreamOutcome` não mudou de forma.
- **`claude.ts` é a conversa** — ler uma conversa *gravada*, listar conversas por
  `cwd`, retomar por id, correlacionar `tool_result` e manter o cursor entre
  linhas. É tudo o que `core/stream.ts` não faz.

Acrescentar um campo à gramática é acrescentar em `claude-stream.ts`. Ler uma
linha à mão em qualquer outro lugar é criar o segundo parser.

### A identidade de bloco (§45.2-A)

Um bloco é `${anthropicMessageId}:${contentBlockIndex}`. `content_block.index`
reinicia em 0 a cada `message_start` e um turno costuma ter várias mensagens de
API, então o índice sozinho colide e dois parágrafos distintos viram uma bolha
só. A transcrição reproduz a **mesma** numeração — contando inclusive os blocos
que ela não renderiza — e é essa igualdade que faz o painel dar upsert em vez de
append quando o bloco chega pelas duas rotas. O sintoma de perder isso aparece
longe da causa; `claude.test.ts` é onde ele é defendido.

### `rejectPending` (§45.2-B)

Quando o `codex app-server` morre, toda requisição em voo é rejeitada. Sem isso
elas esperam para sempre: não há filho da invocação para o watchdog observar, e
o chamador fica bloqueado num `await` que nunca resolve. Duas linhas, e é a
diferença entre requisição falha e processo travado.

### Conversa é dado, nunca instrução

Uma mensagem lida de um arquivo de conversa foi escrita por um modelo.
Reinjetá-la num prompt sem dizer isso é injeção com o atacante já dentro.
`buildConversationSeedPrompt` é o único caminho suportado: ele antepõe
`CONVERSATION_DATA_NOTICE` e fecha o transcript numa cerca
`<prior-conversation>`. É a mesma regra de `agents/handoff/types.ts`, com a
redação deliberadamente parecida.

### Never

- Never spawn an agent from here. `agents/invoke.ts` (headless) and
  `agents/tty.ts` (interactive) are the launcher; the upstream's `sendMessage`
  was deliberately not ported (§25).
- Never log the content of a conversation line. The corrupt-transcript warning
  reports a count and nothing else — §45.3 lists raw logging as the degraded
  form of this project's redacted telemetry.
- Never write a second truncation rule for tool payloads. Both routes go through
  `compactToolPayload`/`extractToolResultText`, or the two copies of one block
  differ by their tail and the block rewrites itself on screen.
- Never let `conversation.ts` drift from `AgentsUiConversationMessage` in
  `packages/issue-flow-contract`. It is a local mirror kept structurally
  identical on purpose, and it disappears the day `src/` depends on that package.
