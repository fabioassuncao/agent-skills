# src/scaffold

Plan-then-apply initialization from the **resolved** policy: fill gaps,
never replace. Assets are rendered from `conventions/defaults` so
taxonomy and files cannot drift.

## Invariants

- **Plan from policy, not a second scan.** The same repository every
  other flow already sees; discovered conventions are never re-proposed.
- **Non-destructive and idempotent.** Never overwrite. A second run
  writes nothing. Apply re-checks existence before each write (TOCTOU).
- **Org templates stay at the org.** A local ISSUE_TEMPLATE /
  conventions doc would fork; the plan says `keep` + note.
- **Never rewrite an existing label taxonomy.** A labels file is only
  planned when discovery found zero labels.
- **`type:*` labels only without Issue Types.** With types, omit them.
- **`CLAUDE.md` is a one-line bridge.** `isClaudeBridge` is size / shape
  (≤2 meaningful lines citing `AGENTS.md`), not a substring match. An
  instructionful `CLAUDE.md` becomes `review`, never auto-promoted.
- **Apply is dumb.** Only `create` writes; judgement lives in `plan.ts`.
- **`blank_issues_enabled: true` is deliberate** — templates must not
  silence unmatched reports.

## Never

- Never overwrite existing files.
- Never copy org templates into the repository.
- Never rewrite labels when any taxonomy already exists.
- Never auto-move `CLAUDE.md` content into `AGENTS.md`.
- Never hand-author scaffold YAML that disagrees with `defaults.ts`.
