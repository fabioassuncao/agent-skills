# src/conventions

Default taxonomy and the only implementation of branch, commit and Pull
Request naming. Provider-independent by construction —
`dependency-direction.test.ts` forbids importing `agents/` or core
facades into this tree.

User-facing rules live in [`docs/git-conventions.md`](../../../../docs/git-conventions.md)
and [`docs/conventions.md`](../../../../docs/conventions.md). This package
is the machine-readable half; `policy/` discovers what a target repo
already has.

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
- **Change-type ladder:** declared → Issue Type → labels (`typeMap`
  overlays defaults) → title `[prefix]` → `feat` fallback. Issue Type
  wins conflicts.
- **Commits use `Refs`, never `Closes`.** Closing is a PR decision
  (`issueReferenceLines`). A container closes only when
  `allChildrenComplete`.
- **Branches are deterministic.** `{type}/{N}-{slug}`; `style` /
  `revert` map to branch prefix `chore`; legacy `issue/{N}-*` still
  parses.
- **Scaffold assets are generated from `defaults.ts`.** Taxonomy and
  rendered forms / labels / docs must not drift.

## Never

- Never put `Closes` on a commit.
- Never import `agents/` or `core/` into this tree.
- Never use provider names as type or scope.
- Never invent an Issue Type when absent.
