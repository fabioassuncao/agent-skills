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
