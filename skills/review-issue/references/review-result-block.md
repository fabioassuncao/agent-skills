# The `<review-result>` block

A machine-readable verdict that lets an orchestrator — the Issue Flow CLI, a
sub-agent, a CI job — act on this review without parsing prose.

It is an **integration contract, not a requirement**. A review nobody is
orchestrating still ends with it: it is cheap, it is the last thing, and it costs
nothing when nobody parses it.

Emit it as the **last thing** in your output, after the human-readable report.

## Passing

```text
<review-result>
STATUS: PASS
</review-result>
```

## Failing

```text
<review-result>
STATUS: FAIL
FINDINGS:
- [US-004] `src/auth/session.ts:88` refreshes the token after the expiry check, so an expired session is accepted once. Move the refresh above the check.
- [GENERAL] `npm test` fails: 3 assertions in `session.test.ts`.
</review-result>
```

## Rules

- `STATUS: PASS` only when the verdict is genuinely approved. Anything else —
  rejected, partial, uncertain — is `STATUS: FAIL`.
- Prefix each finding with the affected story ID (`[US-004]`), or `[GENERAL]`
  when it is not tied to one.
- One line per finding.
- Every `FAIL` lists at least one finding.

## Write findings for a reader who was not here

**Findings are handed verbatim to a correction iteration that has no other
context about this review.** It sees this text and nothing else.

So name the exact file and line, say what is wrong and why, and state — or
strongly imply — what a correct fix looks like. "Tests could be improved" is not
a finding: either the code fails an acceptance criterion or a regression, or it
does not.

## Why the exact spelling matters

A malformed block is never coerced into a pass — it fails loudly instead. That is
deliberate: silently reading an unparseable verdict as `PASS` would close an
issue that nobody verified.
