# CLI issue sources, hierarchies and queues

[CLI guide](cli.md) · [Project overview](../README.md)

The demand reaches the pipeline through an **issue provider**, so every phase
works the same way regardless of where the issue lives.

| Provider | Origin | Requires |
|----------|--------|----------|
| `github` (default) | GitHub issues, read through `gh` | `gh` installed and authenticated |
| `local` | `issue.md` + `metadata.json` under `~/.issue-flow/…/issues/<n>/` | nothing beyond git — works offline, in a repo with no remote, or on a demand that is not public yet |

This page describes CLI providers. Standalone Skills read the selected issue
directly, using files or an authenticated GitHub capability; see
[Skill inputs and artifacts](../skills/README.md#artifacts-resumption-and-limits).

The issue content is fetched **in the CLI** and injected into every prompt
(`analyze`, `prd`, `plan`, `review`, `pr`). The agent never runs
`gh issue view`, so all phases see byte-identical content and a local issue is
not a special case for them.

> Running with no flags and no `.issue-flow.json` is indistinguishable from
> earlier versions: GitHub is the preferred provider and the behaviour is
> unchanged.

## Flags

Available on `run`, `resume`, `init`, `analyze`, `prd`, `plan`, `review` and
`pr`:

| Flag | Effect |
|------|--------|
| `--local` | Prefer the local provider |
| `--github` | Prefer the GitHub provider (default) |
| `--prefer-local` | On divergence, use the local version without asking |
| `--prefer-github` | On divergence, use the GitHub version without asking |
| `--ask` | On divergence, ask which version to use (interactive terminals only) |

`--local` and `--github` are mutually exclusive, and so are `--prefer-local`,
`--prefer-github` and `--ask`. Preferring an origin does not exclude the other:
both are still queried, which is what makes divergence detectable.

Configured through the [`issues` key](configuration.md#issues) of
`.issue-flow.json`.

## Resolution and conflicts

`run` resolves the origin **once** and propagates the decision to every phase;
standalone phase commands resolve on their own. Content is compared through
`contentHash` — a SHA-256 of the normalized title and body — so the two copies
are equal when the text is equal, regardless of line-ending formatting.

| Situation | Behaviour |
|-----------|-----------|
| Only the local copy exists | uses the local one |
| Only the GitHub issue exists | uses the remote one |
| Both, identical `contentHash` | reports the equivalence and continues with the preferred provider, no prompt |
| Both, different `contentHash` | reports the divergence (title, size, `updatedAt`, hash of each side) and applies `conflictPolicy` |
| Neither | fails with exit code `1`, listing what each origin answered |

With `conflictPolicy: "ask"` **and** an interactive terminal, the versions are
listed and you choose: `[1] Local  [2] GitHub  [3] Cancel` (cancelling exits
non-zero). In CI or any non-TTY environment the prompt is never shown — the
preferred provider is used and a warning is printed, so an automated run can
never hang. `prefer-local` and `prefer-github` never prompt.

## Local issue format

```
~/.issue-flow/projects/<project-id>/issues/42/
  issue.md        # H1 (first non-empty line) is the title, everything after it is the body
  metadata.json   # validated against the issue metadata schema
```

```json
{
  "schemaVersion": 1,
  "id": "42",
  "number": 42,
  "source": "local",
  "title": "Add dark mode support",
  "labels": ["enhancement"],
  "state": "open",
  "createdAt": "2026-08-03T12:00:00Z",
  "updatedAt": "2026-08-03T12:00:00Z",
  "contentHash": "sha256:…",
  "remote": {
    "provider": "github",
    "ref": "https://github.com/owner/repo/issues/42",
    "syncedAt": "2026-08-03T12:00:00Z",
    "syncedContentHash": "sha256:…"
  }
}
```

- `remote` is optional and written only by `generate --both`; all four of its
  fields go together.
- `contentHash` is **recalculated from `issue.md` on every read**, so editing the
  file by hand immediately shows up as a divergence against the GitHub copy
  instead of being silently ignored.
- `metadata.json` may be absent: with only `issue.md`, minimal metadata is
  derived (id, H1 title, `state: "open"`, file timestamps). An **invalid**
  `metadata.json` is a hard error naming the path and the offending field.
- `generate --local` allocates identifiers above the highest number found among
  the project's issue directories, including migrated legacy issues. It does not
  consult GitHub. Remote coordination and collision limits are described in
  [Local generation boundary](#local-generation-boundary); `generate --both`
  reuses the number allocated by GitHub.

Local issues are machine-local: a clone on another machine does not see them.
`generate --both` (a GitHub issue plus a local mirror) is the way to keep the
demand shared.

## Hierarchies and queues

`run` accepts one issue or several, and before starting anything it asks the
provider what the issue is related to. When the answer is "nothing", the run is
exactly the single-issue pipeline it has always been: no prompt, no extra
output, no artifact.

### Discovery

The GitHub provider reconciles three mechanisms that only partially overlap, so
a repository is covered whichever one it adopted:

| Source | Reads | Produces |
|--------|-------|----------|
| [Sub-issues](https://docs.github.com/rest/issues/sub-issues) | `GET /repos/{owner}/{repo}/issues/{n}/sub_issues` and the `parent` field | `children`, `parent` |
| [Issue Dependencies](https://docs.github.com/rest/issues/dependencies) | `GET …/issues/{n}/dependencies/blocked_by` and `…/blocking` | `blockedBy`, `blocking` |
| Issue body (heuristic) | `Depends on #N`, `Depends-on: #N`, `Blocked by #N`, `Requires #N`, `Blocks #N` and their Portuguese spellings (`Depende de`, `Bloqueada por`, `Requer`, `Bloqueia`), plus task list items `- [ ] #N` | `blockedBy`, `blocking`, `children` |
| Timeline cross-references | `GET …/issues/{n}/timeline` | `referencedBy` (Pull Requests excluded) |

Every source is queried through `gh api` and is allowed to fail on its own: an
organization without Issue Dependencies enabled simply gets those two fields
empty — a 404 costs a field, never the discovery.

The textual fallback is **heuristic**, and its limits are deliberate:

- fenced code blocks and inline code spans are stripped first, so `#42` inside a
  snippet is never a dependency;
- a keyword only creates a relation when it is **immediately** followed by the
  id — "blocked by the redesign discussed in #12" is a mention, not a dependency;
- `#N, #M and #O` after a single keyword are all read, and a parenthetical gloss
  between them does not end the list;
- a task list item counts as a sub-issue only when the citation **opens** it
  (`- [ ] #21 Title`); an item that merely mentions an issue in its prose is a
  note, not a sub-issue;
- everything else becomes a plain `reference`, which **never** orders execution;
- an id that only the heuristic found is flagged as such, and `run` marks it with
  `~` in the confirmation summary.

From these relations the CLI builds a **dependency graph**, walking hierarchy and
dependencies breadth-first from the issues you asked for. Plain mentions are
recorded but never expanded. Traversal is bounded by **25 nodes and depth 3**;
hitting either limit is reported rather than silently truncating.

Issues already closed when they are discovered remain visible as context, but
are not added to the execution order. A closed dependency is already satisfied;
it must not create a session or send an agent back through work that has been
resolved. An Issue named explicitly on the command line is still honored. When
an existing queue is resumed, unfinished discovered entries are refreshed and
ones closed since the plan was created are marked complete before the next item
is selected.

The `local` provider does not implement discovery: a local issue simply has no
relations.

### Confirmation

When a larger structure is found, the pipeline **stops before the first phase**:

```
Issue #50 is part of a larger structure:
  Main issue:   #50 Discover dependencies between issues
  Total issues: 4
  Suggested order:
    1. #50 Discover dependencies between issues (requested)
    2. #51 Multiple issues as input (after #50)
    3. #52 Sequential multi-issue execution (after #51, high)
    4. #53 One consolidated Pull Request (after #52)
Which scope should run? [1] Only the issues informed (1)  [2] The whole hierarchy (4)  [3] Cancel:
```

Answering `2` (or pressing Enter) runs the whole thing; `1` trims it to what you
typed; `3` cancels without executing anything.

**Outside a TTY** (CI, a pipe) the answer must come from a flag: `--yes` runs the
whole hierarchy, `--cascade` runs the children of a container, `--only` runs just
what you informed.

| Situation | With no scope flag |
|---|---|
| Several issues informed | **fails with exit code `1`** rather than guessing |
| A single non-container issue | falls back to that issue alone, with a warning |
| A container (Epic, or any issue with sub-issues) | **fails** — running the umbrella by omission would implement a document nobody approved |
| A discovered dependency cycle | refused for a multi-issue request; degraded to the single issue you asked for otherwise |

`--yes` and `--only` cannot be combined.

### Ordering

The queue is ordered by, in this precedence:

1. **dependencies and blocks** — a hard constraint: an issue never starts before
   something it depends on has finished;
2. **hierarchy** — a parent before its children;
3. **priority labels** — `high` > `medium` > `low`; an issue with no priority
   label sorts after every labelled one;
4. **issue number**.

A dependency **cycle** is refused with an explicit error instead of being
resolved into an arbitrary order.

### How a queue runs

Every issue goes through the same phases (`prd` → `plan` → `execute` →
`review`), each with its own `tasks.json`, its own session and its own
token/cost accounting, all inside a single process. What the queue owns is what
is shared:

- **one branch** for the whole queue: the first issue's `plan` phase names it,
  and every later issue's plan is made to use it;
- **commits scoped per issue**: inside a queue the execute prompt commits as
  `feat(issue-51): [Story ID] - [Story Title]` (and `fix(issue-51): …` for
  review corrections), so `git log` on the shared branch stays readable. A
  single-issue run keeps `feat: [Story ID] - [Story Title]`;
- **one Pull Request** at the end, covering every issue;
- **one consolidated summary**, with a per-issue breakdown of stories, duration
  and cost.

### Failure and resume

A failure stops the queue where it happened: the branch and every commit already
made are kept untouched, and the queue records which issue failed and in which
phase. Re-running the same command resumes from that issue — the completed ones
are never redone, and the confirmation is not asked again:

```bash
issue-flow run 50        # stops at #52, in the execute phase
issue-flow run 50        # resumes at #52; #50 and #51 are left alone
```

`--from <phase>` addresses the issue the queue is resuming, not the ones after
it. `--on-issue-failure` decides what one failing issue does to the rest — see
[resilience](resilience.md#queue-behaviour).

Coordination state lives in
`~/.issue-flow/projects/<project-id>/queues/<queue-id>/execution-plan.json`; each
issue's own artifacts stay exactly where they were. The queue id is the
identifier of the **primary issue** (the first one informed), which is what lets
`issue-flow run 50` find and resume the queue it started.

## Local generation boundary

`generate --local` discovers local policy and local numbering without probing
GitHub labels, organization templates, issue types or remote issue numbers. Its
prompt excludes remote duplicate discovery. Consequently, an ID allocated while
offline can collide with a remote ID when later synchronized; normal conflict
resolution applies. Dual/remote delivery keeps remote discovery. Direct provider
APIs retain their legacy allocation behavior unless `localOnly` is requested.

Issue closure is an explicit execution choice; see [command contract](commands.md#explicit-issue-closure).
