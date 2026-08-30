# src/utils

Shared process, git and filesystem primitives. No domain rules. This is
the chokepoint for shell retries and the "never auto-fix the repo"
rule.

## Invariants

- **`run()` is the only shell path.** execa, `reject: false`, no shell.
  Default: no retry (byte-identical to pre-retry behaviour). Opt-in
  `retry` only when a non-zero exit means failure.
- **Destructive git is never retried**, even if the caller asked.
  Absolute list covers rebase / cherry-pick / merge / am / revert /
  restore / …; conditional covers force-push, hard reset, `clean -f`.
- **Preflight reports, never fixes.** Suggestions are printed strings,
  never executed. A dirty tree blocks only for `new-phase`, not
  `resume-same-phase`. Sequencer refs are read-only probes.
- **`getBaseBranch` defaults to `main` and never throws.** Discovery in
  `policy/` must not reuse it (would invent a value). Prefer an
  explicit `cwd` for `getRemoteUrl` / `getHeadCommit`.
- **`normalizeRemoteUrl` lowercases host + path** (clone matching beats
  case-sensitive self-host). `stripRemoteUrlCredentials` only strips
  http(s) userinfo; SSH is left alone.
- **`writeFileAtomic`** is the single atomic write: mkdir of the
  destination when needed, temp beside the target, rename, `EXDEV` →
  copy + unlink. Domain modules do not keep a private copy.
- **`retry.ts` is a thin adapter** for agent exit / text. Prefer
  `resilience/errors.classify` when errno / HTTP / `timedOut` exist. The
  real retry executor is `resilience/retry` via `shell.run`.

## Never

- Never retry destructive git "to recover".
- Never auto `rebase --abort` / stash / reset from preflight.
- Never invent a base branch in discovery by calling `getBaseBranch`.
- Never omit `cwd` when resolving a known `projectRoot`.
- Never put secrets into diagnostics via raw remotes — strip
  credentials on display surfaces.
