# The `<pr-review-result>` block

A machine-readable recommendation that lets an orchestrator — the Issue Flow
CLI, a sub-agent, a CI job — act on this review without parsing prose.

It is an **integration contract, not a requirement**. A review nobody is
orchestrating still ends with it: it is cheap, it is the last thing, and it costs
nothing when nobody parses it.

Emit it as the **last thing** in your output, after the report.

```text
<pr-review-result>
RECOMMENDATION: APPROVE
BLOCKERS:
- None
</pr-review-result>
```

## Rules

- `RECOMMENDATION` is exactly one of `APPROVE`, `APPROVE_WITH_SUGGESTIONS` or
  `REQUEST_CHANGES`. Any other value is a failed review, never read as approval.
- Every `REQUEST_CHANGES` lists at least one blocker, one per line.
- Keep `- None` when there are none.

## Why the exact spelling matters

A malformed block is never coerced into an approval — it fails loudly instead,
and the raw output is preserved. That is deliberate: silently reading an
unparseable verdict as `APPROVE` would turn a broken review into a merged Pull
Request.
