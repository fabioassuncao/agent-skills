# src/execution

Multi-issue queue above a single `TaskPlan`: discovery → confirm → order
→ `execution-plan.json`. The single-issue path stays untouched when no
neighbours are discovered.

Runtime ownership of "run this queue" lives in
`commands/run/multi-issue.ts` (once split); this directory owns the
**plan**, not the phase loop. Do not confuse with `commands/run.ts`.

## Invariants

- **Additive by silence.** One issue and no discovered neighbours → no
  plan file, no prompt, same behaviour as before. A plan is written only
  for queues with more than one issue.
- **Same request resumes, never re-confirms.** A completed queue stops
  with exit 0 and does not overwrite PR history. A corrupted plan is
  replanned (derived state).
- **`--only` / no `fetchRelations` → single.** The local provider never
  becomes a queue. A cycle on a single requested root degrades to single
  + warning; a multi-request cycle fails.
- **Confirm before any phase.** Non-interactive multi-issue needs
  `--yes` / `--only` / `--cascade`. EOF is cancel, never consent.
- **Container ≠ work.** `role: 'container'` never runs phases;
  auto-completes when all children complete; `dependsOn` treats
  containers as satisfied.
- **Resume hand-out order:** `in_progress` → `failed` → `pending` →
  `skipped`. Never hand out `blocked`. `skipped` is not terminal for
  queue status; `blocked` makes the queue `failed`.
- **Closed discovered Issues are satisfied context, not work.** New plans leave
  them out of the execution order; resumed plans refresh unfinished discovered
  entries and complete the ones now closed. Explicitly requested Issues remain
  in scope regardless of state.
- **Topology first.** Parent/child is tie-break only, not a hard edge.
  Cycles are reported, never papered over.
- **`registry.ts` is the only cross-project `run.lock` reader.** Lock
  means existence; the session enriches the phase. A dead pid is
  `orphan`, never `running`.

## Never

- Never re-confirm a resumed queue.
- Never create `execution-plan.json` for a true single-issue run.
- Never treat `blocked` as retryable via `nextQueueIssue`.
- Never use `--background` with `--mode manual` or a non-TTY / CI
  environment.
