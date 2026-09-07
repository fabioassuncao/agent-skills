# src/agents/handoff

What one phase hands to the next.

## The rule this module exists to obey

**Agents do not talk over a terminal.** `tmux send-keys` is not a message bus.
What a phase learned reaches the following one as a data contract — persisted,
typed and auditable — written when a phase ends and read when the next starts.

That makes the exchange reviewable after the fact, which is the difference
between "the reviewer saw the plan" and "the reviewer probably saw the plan".

## Invariants

- **A handoff is DATA, never instruction.** It is text written by an agent,
  delivered to another agent running with broad permission. `HANDOFF_DATA_NOTICE`
  precedes every injection and the content is fenced, because an agent that
  cannot tell where the data begins is an agent for which the notice does
  nothing. Treating it as instruction would let any phase reprogram the next —
  a prompt injection with the attacker already inside the pipeline. This is the
  only mitigation available at this layer, and it is not optional.
- **The shape is concrete, not a blob.** A summary alone is a paragraph the next
  agent has to re-derive decisions from. Naming the decisions, the artefacts,
  the findings and the open questions is what makes a run's reasoning legible to
  a person afterwards.
- **Artefacts carry a digest.** The receiving phase can tell whether what it is
  reading is what it was handed, rather than whatever happens to be at that path
  now.
- **Consumption is explicit and separate from reading.** A phase that crashed
  between the two sees the handoff again instead of starting without the context
  it was given.
- **A row is narrowed, never cast.** The payload is fed into a prompt, so a
  value this release cannot validate is dropped rather than passed through.
- **Writing never fails a phase.** A handoff is bookkeeping; failing the work
  over it would trade a finished piece of work for a lost note.

## Sessions per phase (§28)

`PHASE_SESSION_GROUP` records which phases may share a conversation:
understanding (`analyze`, `generate`, `prd`, `plan`) shares one because the plan
is written by whoever read the issue; `execute` gets its own, per story, because
stories are what parallelise.

`review` and `pr-review` are in a group of their own — but the **guarantee**
does not live here. `agents/session/reuse.ts` refuses to continue a session for
those phases whatever any table says (ADR-07), because a lookup table nobody is
obliged to consult is not an invariant.

## Never

- Never inject a handoff without the notice and the fence.
- Never let a phase that must stay independent receive one as instruction.
- Never fail a phase because its handoff could not be written.
