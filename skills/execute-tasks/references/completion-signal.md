# The completion signal

One machine-readable marker lets an orchestrator — the Issue Flow CLI, a
sub-agent, a CI job — know the execution phase finished, without parsing prose.

It is an **integration contract, not a requirement**. A run nobody is
orchestrating still emits it: it is one line, it is the last one, and it costs
nothing when nobody parses it.

## When to emit it

When, and only when, **every** story has `passes: true` **and**
`lastReviewFindings` is `null`:

```text
<promise>COMPLETE</promise>
```

Emit it after updating the plan — `issueStatus: "completed"`, `completedAt` and
`lastAttemptAt` set, `lastError` cleared, `pipeline.executionCompleted` true.

## When not to

Stories still pending, or review findings still outstanding, means **no marker**.
End the turn normally and let the next iteration pick up the work.

`lastReviewFindings` outranks the story list: non-null means the phase is
unfinished even when every story already passes. Emitting the marker there tells
the orchestrator that corrections it is still waiting for are done.

## Why the exact spelling matters

An orchestrator matches this literally. A near-miss — different tag, extra
words inside it, a code fence around it — is not read as completion, and the run
either loops or stalls. Write it exactly as above, on its own line.
