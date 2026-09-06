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
- **The branch is generated when nobody names one** — `session/<slug>-<8 hex>`.
  Requiring a branch would reinstate the ceremony a free session exists to skip.
  No model is consulted; the upstream's optional auto-namer is not ported.
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
