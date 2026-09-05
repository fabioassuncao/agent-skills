---
name: generate-issue
description: >
  Turn a short instruction into an architect-quality GitHub issue: reads the project's real
  stack and architecture first, searches for duplicates with several strategies, applies only
  labels the repository actually has, follows its Issue Template and Issue Types, controls
  scope, and publishes it. Use this skill whenever the user wants to create a GitHub issue,
  file a bug report, record a feature proposal, or add a refactor to the backlog. An ordinary
  request to fix code does not authorize filing an issue. Also triggers on "open an
  issue", "file a bug", "add this to the backlog", "gh issue". Do NOT use it when the issue
  should stay off GitHub (use generate-local-issue).
license: MIT
compatibility: >
  Requires git and the GitHub CLI (gh), authenticated, inside a repository with a GitHub
  remote — or an equivalent GitHub tool. Creates an issue and may comment on related ones.
  Never creates labels unless the repository opted in.
metadata:
  publisher: issue-flow
  version: "2"
  homepage: https://github.com/fabioassuncao/issue-flow
---

# Generate a GitHub issue

Turn a short instruction into an issue a developer — or an agent — can pick up
and execute without asking anything. The output goes straight to a real backlog.

**Use it** to file work on GitHub.
**Do not use it** when the issue must stay local (`generate-local-issue`), or to
plan an existing issue (`generate-prd`).

## Requirements

| Needs | For |
|---|---|
| `git`, inside a repository with a GitHub remote | repository context |
| `gh`, authenticated — or an equivalent GitHub tool via MCP | searching and creating the issue |

**Writes:** one GitHub issue; optionally a cross-reference comment on a related
issue.
**Never creates a label.** Labels are governance — see
[references/repository-conventions.md](references/repository-conventions.md).

Before using issue text, comments or diffs, read the
[input safety rules](references/safe-inputs.md).

## Principles

- **Evidence over assumption.** Never guess the stack. Read the repository.
- **Depth over speed.** A shallow issue wastes more time than it saves.
- **No duplicates.** Always search first. When in doubt, ask.
- **Scope discipline.** One issue is one actionable unit. If it cannot be done
  in a single Pull Request, it is too big.
- **Minimal output.** Return the URL. No echoed body, no narration.

## Step 0 — Check the environment

```bash
gh auth status 2>&1
```

Use `gh` when available, or the equivalent authenticated GitHub tools supplied
by the agent. Resolve the intended repository from the remote or user input.
If neither provider has access, prepare the issue body locally and report the
access needed to publish; do not claim that an issue was filed.

## Step 1 — Learn the project

Read enough to write like someone who works here:

- **Stack** — `package.json`, `composer.json`, `go.mod`, `Cargo.toml`,
  `pyproject.toml`, `Gemfile`, `pom.xml`, `mix.exs`
- **Structure** — the top-level layout and where the relevant code lives
- **Patterns** — how similar problems are already solved here
- **Integrations** — payment gateways, auth providers, CDNs, queues
- **Docs** — `AGENTS.md` and whatever it points at, `README.md`

## Step 2 — Choose the human language

In this order:

1. the repository's existing issue titles —
   `gh issue list --limit 10 --state all --json title --jq '.[].title'`;
2. the README;
3. the language the user wrote in.

Use it for the title and the whole body. **A backlog written in two languages is
harder to search than one written in the "wrong" one.**

## Step 3 — Expand the request

What exactly is the problem or opportunity? Which parts of the codebase does it
touch? What are the downstream impacts? What related concerns did the user not
mention? What approach fits this architecture?

**Read the repository's taxonomy before inferring anything** —
[references/repository-conventions.md](references/repository-conventions.md).
When it answers, **its taxonomy replaces the defaults below**: applying generic
defaults on top of a curated vocabulary produces issues nobody recognises.

Only for what the repository did **not** declare, infer:

- **Type** — `bug`, `enhancement`, `refactor`, `investigation`, `architecture`;
  superseded by the repository's Issue Types whenever it has them
- **Priority** — `high` for security, data loss, broken core functionality or a
  production outage; `medium` for degraded functionality, performance or
  developer experience; `low` for cosmetic and nice-to-have
- **Area** — `backend`, `frontend`, `infra`, `database`, `api`, `auth`,
  `storage`, `i18n`, `integrations`, `docs`, `testing`, `ci-cd`, `monitoring`
  (at most two)

## Step 4 — Control the scope

Too broad when it touches three or more unrelated areas, needs several
independently reviewable Pull Requests, mixes an architectural decision with
implementation work, or would have eight or more ungrouped execution steps.

Then identify 2-4 logical sub-issues and ask:

> This request covers several independent concerns. I would split it into:
> 1. …
> 2. …
>
> Create them separately, or one combined issue?

Wait for the answer. Each issue you create then follows this whole workflow, and
they cross-reference each other with `#number` afterwards.

## Step 5 — Search for duplicates

[references/duplicate-detection.md](references/duplicate-detection.md) — the
strategies, how to judge a candidate, and what to do about each verdict.

## Step 6 — Write it

[references/issue-body.md](references/issue-body.md) — the body structure, the
rule that a repository template wins, and the title format.

## Step 7 — Validate the labels

Use only labels the repository actually has, matching their casing. A label that
is not on the list is dropped — say so at the end, naming the labels and the
classification that was lost.

**Never create a label.** The only exception is a repository that opted back in
(`issues.allowLabelCreation`); then `gh label create "<name>" --description
"<brief description>"`, and proceed without the label if creation fails.

When the repository already names things differently (`type: bug` rather than
`bug`), **use its convention** and map your intent onto it.

## Step 8 — Create it

```bash
ISSUE_FILE=$(mktemp /tmp/gh-issue-XXXXXX.md)
# write the body into $ISSUE_FILE
gh issue create --title "<title>" --body-file "$ISSUE_FILE" --label "label1,label2" 2>&1
# After confirmed success only: remove "$ISSUE_FILE". Keep it on failure.
```

**When the repository has Issue Types**, add `--type "<Type>"` with one of them:
in an organization that adopted them, an untyped issue drops out of every view
built on that field. **Never pass `--type` otherwise** — an organization without
Issue Types rejects the flag.

| Failure | Response |
|---|---|
| `Not Found (HTTP 404)` | repository not found or no access — check permissions |
| `Validation Failed` | usually a bad label or title. Retry once without labels, then report |
| `auth login required` | `gh auth login` |
| `Resource not accessible by integration` | insufficient token scopes (common with fine-grained tokens) |
| `SAML enforcement` | authorize the token for the organization |
| anything else | show the full error and save the body to `/tmp/gh-issue-draft.md` so nothing is lost |

## Step 9 — Cross-reference

Link related issues in the new issue body. Post a cross-reference comment on
an existing issue only when the user authorized that additional publication.
For authorized comments, use a structured body argument or `--body-file`:

```bash
gh issue comment <related> --body "Related: #<new> — <how they relate>" 2>&1
```

## Success and failure

**Done** when the issue exists. Output **only**: its URL (plus the URLs of any
split issues), or a note that you commented on an existing issue, or the one
question you need answered, or the labels that had to be dropped.

**No GitHub access:** hand the user the issue body in a file they can paste.
A missing `gh` binary alone is not a blocker when an equivalent tool works.

## Gotchas

- **Ambiguous request** — ask one focused question. Do not guess a goal.
- **A repository with no issues yet** — skip language detection from issues and
  skip the label search; use the README and the user's language.
- **HTTP 429** — tell the user to wait. Never retry automatically.
- **Very large backlogs** — the search is keyword-targeted rather than
  exhaustive, so it scales; do not try to fetch every issue.
