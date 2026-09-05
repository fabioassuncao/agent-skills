---
name: generate-local-issue
description: >
  Turn a short instruction into an architect-quality issue stored as files in the repository —
  `issues/{N}/issue.md` plus `issues/{N}/metadata.json` — with no GitHub involved. Reads the
  project's real stack first, allocates a collision-free identifier, and checks the local
  backlog for duplicates. Use this skill whenever an issue should be created without GitHub:
  offline, in a repository with no remote, when gh is missing or unauthenticated, or when the
  demand is not public yet. Triggers on "create a local issue", "criar issue local", "open an
  issue offline", "file this in issues/ without GitHub", "add this to the backlog locally". Do
  NOT use it when the issue belongs on GitHub (use generate-issue).
license: MIT
compatibility: >
  Requires git and a writable working directory. Needs no network and no GitHub access; gh is
  used only, and optionally, to avoid identifier collisions. Bundled script needs node or
  python3.
metadata:
  publisher: issue-flow
  version: "1"
  homepage: https://github.com/fabioassuncao/issue-flow
---

# Generate a local issue

Turn a short instruction into an issue that lives in the repository as plain
files — versionable, reviewable, and readable with no network at all.

**Use it** when the issue must not (or cannot) go to GitHub.
**Do not use it** when the issue belongs on GitHub — `generate-issue` does that.

## Requirements

| Needs | For |
|---|---|
| `git` | locating the project root |
| a writable working directory | `issues/<id>/` |
| `node` or `python3` | the bundled `scripts/content-hash.sh` |
| `gh` — **optional** | raising the allocated identifier above the remote counter |

**Writes:** `issues/<id>/issue.md` and `issues/<id>/metadata.json`.
**Never:** overwrites an existing issue, touches the network, or fails because
`gh` is absent.

## Principles

- **Evidence over assumption.** Never guess the stack. Read the repository.
- **Offline first.** Nothing here may fail because `gh` is missing or
  unauthenticated. Never surface a `gh` error to the user: the whole point of a
  local issue is not needing GitHub.
- **Never overwrite.** An existing `issues/<id>/issue.md` is someone's work.
- **Scope discipline.** One issue is one actionable unit of work.
- **Minimal output.** Return the created paths. No echoed body, no narration.

## Step 0 — Find the project root

```bash
git rev-parse --show-toplevel 2>&1
```

Not a git repository? Ask which directory `issues/` should live in, and use that
as the project root. Do not create issues outside it.

**Do not check `gh auth status`.** This skill must work with no GitHub access.

## Step 1 — Learn the project

Read enough to write like someone who works here:

- **Stack** — `package.json`, `composer.json`, `go.mod`, `Cargo.toml`,
  `pyproject.toml`, `Gemfile`, `pom.xml`, `mix.exs`
- **Structure** — the top-level layout and where the relevant code lives
- **Patterns** — how similar problems are already solved here
- **Docs** — `AGENTS.md` and whatever it points at, `README.md`

## Step 2 — Choose the human language

In this order:

1. the titles of existing local issues —
   `cat issues/*/metadata.json 2>/dev/null | grep '"title"'`;
2. the README;
3. the language the user wrote in.

Use it for the title and the whole body.

## Step 3 — Expand the request

What exactly is the problem? Which parts of the codebase does it touch? What are
the downstream impacts? What did the user not mention? What approach fits this
architecture?

A local issue has no GitHub label registry, but the repository still has
conventions — Issue Templates in `.github/ISSUE_TEMPLATE/`, a title convention,
`AGENTS.md`. Ask for them before inferring anything:
[references/repository-conventions.md](references/repository-conventions.md).

Only for what the repository did **not** declare, infer:

- **Type** — `bug`, `enhancement`, `refactor`, `investigation`, `architecture`
- **Priority** — `high` for security, data loss, broken core functionality;
  `medium` for degraded functionality, performance, developer experience; `low`
  for cosmetic and nice-to-have
- **Area** — `backend`, `frontend`, `infra`, `database`, `api`, `auth`,
  `storage`, `i18n`, `integrations`, `docs`, `testing`, `ci-cd`, `monitoring`
  (at most two)

These become the `labels` array. Nothing validates them, so keep them
consistent with whatever the repository already uses.

## Step 4 — Control the scope

Too broad when it touches three or more unrelated areas, needs several
independently reviewable changes, mixes an architectural decision with
implementation work, or would have eight or more ungrouped steps.

Then propose 2-4 sub-issues and ask whether to create them separately. Wait for
the answer, and cross-reference them afterwards.

## Step 5 — Search for duplicates

[references/duplicate-detection.md](references/duplicate-detection.md). Here the
**local backlog is the source of truth**; the remote search is a bonus that must
never fail the workflow.

If a duplicate exists only on GitHub, say so and ask whether the user wants a
local mirror or prefers to work from the remote one.

## Step 6 — Allocate the identifier and write the files

[references/local-issue-files.md](references/local-issue-files.md) — identifier
allocation, the collision check, the exact shape of both files, and how to
compute `contentHash` with the bundled script.

The body itself follows
[references/issue-body.md](references/issue-body.md), including the rule that a
repository Issue Template wins over the default structure.

## Step 7 — Verify

Run the verification at the end of
[references/local-issue-files.md](references/local-issue-files.md): the files
exist, the JSON parses, the H1 matches `title`, `number` matches the directory,
and the hash came from the final file.

## Success and failure

**Done** when both files exist and verify. Output **only** the created paths —
plus, when the Issue Flow CLI is in use, that `issue-flow run <id> --local`
picks them up from here.

**Collision:** report it and suggest the next free identifier. Never overwrite.

## Gotchas

- **`issues/` does not exist** — normal for the first issue. The highest local
  number is `0`, so the first identifier is `1`, or one above the remote
  counter when `gh` answered.
- **A non-numeric identifier** (`spike-auth`) is allowed. Set `"number": null` —
  `0` is invalid, and a fake number will collide with a real one later.
- **`issue.md` with no `metadata.json`** is still readable — title from the H1,
  `state: "open"`, timestamps from the filesystem. Write both anyway: derived
  labels are empty and derived timestamps change whenever the file is touched.
- **A malformed `metadata.json` in an existing directory** — report it to the
  user rather than skipping it silently, keep going, and treat that number as
  taken.
- **Should `issues/` be committed?** For local issues, yes: the demand lives in
  the repository, which is what makes it shareable and reviewable.
