# src/conventions

Default taxonomy and the only implementation of branch, commit and Pull
Request naming. Provider-independent by construction —
`dependency-direction.test.ts` forbids importing `agents/` or core
facades into this tree.

User-facing rules live in [`docs/git-conventions.md`](../../../../docs/git-conventions.md)
and [`docs/conventions.md`](../../../../docs/conventions.md). This package
is the machine-readable half; `policy/` discovers what a target repo
already has.

Distribution of these pure rules to independent Skills is defined in the
[source/artifact contract](../../../../docs/skills.md#source-and-distribution).

## Invariants

- **Last rung only.** `defaults.ts` applies when repo, org and config are
  silent. Discovery lives in `policy/`; this package does not invent from
  prose.
- **Native > field > label > free text.** No priority / status / type /
  size labels when GitHub already models them. `FALLBACK_TYPE_LABELS`
  (`type:*`) only when the org has no Issue Types.
- **Six types, not thirteen.** `Idea` / `Research` / `Epic` are
  non-executable; `Feature` / `Bug` / `Task` are. `NON_TYPES` is part of
  the convention.
- **Git layer accepts no provider, agent or model.** Names such as
  `claude` may appear in a subject; never as type or scope
  (`FORBIDDEN_PROVIDER_NAMES`). Telemetry stays in `session.json`.
- **Change-type ladder: two rungs.** declared (explicit, or a label
  through `typeMap` overlaying `DEFAULT_LABEL_TYPE_MAP`) → `feat`
  fallback. The Issue Type and title-prefix rungs, with
  `ISSUE_TYPE_MAP` and `TITLE_PREFIX_MAP`, were removed: they inferred
  a type from a name, produced an answer nobody could check, and
  changed nothing observable.
- **The repository declares, Issue Flow yields.** `resolveGitConvention`
  is the one place that decides `commit.format`, `commit.types` and the
  PR title format. Only a `declared` source turns a fallback off; an
  `inferred` one informs. `closesWhenVerified` and the `Refs` footer
  never yield — they are guarantees, not preferences.
- **Commits use `Refs`, never `Closes`.** Closing is a PR decision
  (`issueReferenceLines`). A container closes only when
  `allChildrenComplete`. There is no `Story:` trailer: that link lives
  in the `stories` table, and a copy in the message was a second truth.
- **Branches are deterministic.** `{type}/{N}-{slug}`; legacy
  `issue/{N}-*` still parses. Three paths, in `resolveBranchName`:
  convention, generated name, `change-<uuid8>`.
- **`auto-name.ts` names no provider.** The model call is an injected
  `BranchNameGenerator`; the prompt, the eleven normalization steps and
  the fallback stay here. Every failure — missing CLI, non-zero exit,
  timeout, unusable output — degrades to the fallback, because a run
  must be nameable with no model reachable.
- **Scaffold assets are generated from `defaults.ts`.** Taxonomy and
  rendered forms / labels / docs must not drift.

## Never

- Never put `Closes` on a commit.
- Never import `agents/` or `core/` into this tree.
- Never use provider names as type or scope.
- Never invent an Issue Type when absent.
- Never name a provider, agent, model or CLI in `auto-name.ts`.
- Never reject a type the repository declared for itself.
