# src/runtime/worktree

Worktree isolation: a checkout per branch, its durable binding, and the rollback
that keeps a failed creation from leaving debris.

Absorbed from WebMux (`adapters/git.ts`, `services/lifecycle-service.ts`,
`services/worktree-service.ts`, `adapters/fs.ts`, `auto-remove-service.ts`,
`auto-pull-service.ts`). The Issue Flow had no worktree implementation, so the
operations are the upstream's — but how a command runs, and how state is
written, are this project's.

## Invariants

- **Every git call goes through `run()`** (`src/utils/shell.ts`). That is what
  makes the destructive-git allowlist and the retry policy apply to worktree
  operations too. The upstream uses `Bun.spawnSync` with neither. This is also
  why everything here is async where the upstream is synchronous: a second,
  synchronous shell path would be a duplicated responsibility.
- **git is the authority on existence, the database on binding** (ADR-08).
  `list()` joins the two and reports the disagreement as `orphaned`. It never
  recreates a worktree because a row says one should exist, and never deletes a
  row because a directory is missing.
- **Availability reads the raw worktree list, not the live one.** A stale
  registration — a directory a user deleted by hand that git has not pruned —
  still holds its branch in git's view. Filtering it out would report the branch
  as free and then fail at `worktree add` with a much worse message.
- **A rollback only deletes a branch this creation created.** `mode: 'new'`
  always; `mode: 'existing'` only when the branch was cut locally from a remote
  one. Deleting a pre-existing local branch because a rollback ran would destroy
  work.
- **Cleanup errors are appended to the original cause, never substituted.** The
  reason a creation failed is the headline; what the cleanup could not undo is
  context. The same rule applies to `merge`, which says explicitly that the
  merge *succeeded* when only the removal failed — a caller that read it as
  "merge failed" would retry the merge.
- **A dirty worktree is never merged and never auto-removed.** Work committed
  nowhere lives only in that directory, and both operations end by deleting it.
- **Auto-remove requires complete PR and identity evidence.** The `serve`
  maintenance loop runs the sweep only when configured. Any failed repository
  query makes the pass inconclusive; every PR for the branch must be merged;
  the current repository must report a `headRefOid` equal to the checkout HEAD;
  and path/worktree id, cleanliness and occupancy are rechecked under the
  shared cross-process lock immediately before deletion.
- **Runtime artifacts live under the git dir, never in the working tree.**
  `runtime.env` sits in `<gitDir>/issue-flow/`, written with `writeFileAtomic`
  (the upstream's `Bun.write` is not atomic — §45.3), which is why it can never
  be committed.
- **The repository's own entry is recognised by git's path, not by ours.** On
  macOS the temporary and home directories are symlinks, so git answers
  `/private/var/…` where the caller passed `/var/…`. Comparing the configured
  root as a string makes the repository itself show up as one more managed
  worktree.

## Where the boundary with `src/utils/git.ts` runs

Both files shell out to git, and §22 specifies the split. The line is the
caller, not the command:

- `src/utils/git.ts` answers questions about **the repository the pipeline is
  running in**. It takes no cwd by default and its errors are written for
  someone running `issue-flow` in the wrong directory.
- `src/runtime/worktree/git.ts` answers questions about **a directory it was
  handed**. Every function takes a cwd, and its errors name the git command.

`resolveWorktreeRoot(cwd)` and `getProjectRoot()` do run the same git command.
They are not merged because merging them would mean giving one of the two the
other's error contract, and the message a user reads is the point of both.

Branch-name validity is **not** split: `isValidBranchName` lives in
`src/conventions/git/slug.ts` and this module asks it. Two validators
disagreeing is how a name passes one check and fails the other halfway through
creating a worktree.

## Deliberately not here

Tmux windows, containers, port allocation and profiles enter through
`WorktreeLifecycleHooks`, filled in by the phases that own them. The upstream
folds all of them into one 1.523-line service; splitting them keeps each
responsibility with one implementation instead of a weaker copy in here.

`forcePullMainBranch` (fetch + `reset --hard`) is not ported. Auto-pull is
fast-forward only, because nothing destructive runs automatically to repair
state — a diverged branch reports and waits for a person.

## Never

- Never call `git` outside `run()`.
- Never repair a disagreement between git and the database automatically.
- Never delete a directory git still lists as a live worktree: that corrupts the
  repository's view of it. `removeGitWorktree` checks before falling back.
- Never merge or auto-remove without reading the worktree's status first.
