# src/issues

Origin-agnostic Issue model, registry, resolution, relation graph, and
the only place commands may talk to GitHub or local issues. Built-in
providers live under `providers/`; everything the CLI **reads** from
GitHub about a Pull Request, its CI and its review comments lives under
`github/`.

User-facing behaviour: [`docs/issues.md`](../../../../docs/issues.md).
Pure Markdown parsing, hashing and schema distribution to standalone Skills:
[`docs/skills.md`](../../../../docs/skills.md#source-and-distribution).

## Invariants

- **Commands never call `gh issue *`.** Enforced by `migration.test.ts`.
  Resolve once, pass `__ISSUE_*` placeholders; `preResolved` must not
  re-query.
- **Extensible by registration.** `IssueSource` is open; a new origin
  needs no command or template edits. `ensureProvidersRegistered` is
  idempotent and never replaces a caller-registered provider.
- **`get` returning null ≠ throw.** Absent versus broken.
  `isAvailable` / `checkAvailability` never throw. Optional methods via
  `?.`.
- **Resolver is origin-agnostic.** Same `contentHash` → preferred (or
  first found), no prompt. Divergence follows `conflictPolicy`; non-TTY
  `ask` falls back to preferred + warning.
- **Hash is CRLF / trim-stable.** Local `contentHash` is always
  recomputed from `issue.md`.
- **Graph is structural only.** Expand parent / children / blockedBy /
  blocking; never expand plain `references`. Mentions are context.
  Parent/child is not a schedule constraint (`dependencyEdges`).
- **Validate labels, never create** (unless `allowLabelCreation`). An
  empty known set passes through (offline ≠ missing).
- **One implementation per GitHub read.** `gh pr list`, `gh pr view`,
  `gh run view` and the review-comment API are invoked only from
  `github/`. `core/session-git.ts` and `commands/pr-review.ts` delegate
  there. Enforced by `github/single-implementation.test.ts`, whose
  exemption list is documented in the file.
- **Pull Request creation is not here.** It belongs to `commands/pr.ts`,
  which owns the deterministic `Closes` / `Refs` body.
- **A failed `gh` query is not an empty answer.** List reads return a
  Result; the cross-repository state sweep returns `null` if any
  repository failed, because acting on partial data removes work that
  was merely unreachable.
- **`github/client.ts` is the only `gh` entry point of the module**, and
  every call carries the resilience policy. No second copy of
  `ghPolicy`.
- **Read cheaply.** Review comments use `If-None-Match`; an unchanged
  `updatedAt` skips the read entirely; the periodic refresh is
  activity-gated and makes zero calls while nothing is watching.
- **Local provider:** never mutate the filesystem in `isAvailable`;
  never write under `<projectRoot>/issues/`; paths go through
  `resolveIssuePaths`; create uses `wx`.
- **`claims(id)` is exclusive, and therefore rare.** An origin that
  declares it makes the resolver query *only* the claimants of that
  identifier. It is for a namespace no other origin could ever produce
  (`inline-<12 hex>`, minted here); an origin whose ids could collide
  with another's must not implement it, or the divergence machinery
  never runs. Pure, synchronous, never throws — a `claims` that throws
  is read as "no claim", because a predicate that is an optimization
  must never be why an Issue cannot be found.
- **Inline provider (§17):** the origin of `issue-flow run --prompt`.
  The identifier is the sha-256 of the prompt, so the same demand is the
  same Issue and a second invocation resumes rather than forks. It
  answers `null` for any identifier that is not its own **before**
  touching storage, and reports itself unavailable (never throws)
  outside a repository or on the legacy JSON store. Rows live in
  `inline_issues` (migration 18), keyed by `(project_id, id)` — the same
  prompt in two repositories is two Issues.

## Never

- Never shell `gh issue view|create|close` from commands or prompts.
- Never call `gh` for Pull Request, CI or review-comment state outside
  `github/`.
- Never poll GitHub without a gate on the interactive path, and never
  turn a `304` into "no comments".
- Never invent an Issue Type or default labels for "absent".
- Never expand mention-only citations into the execution graph.
- Never treat self as a dependency.
- Never materialize CLI override keys as `undefined` (would wipe
  config).
