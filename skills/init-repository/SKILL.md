---
name: init-repository
description: >
  Standardise a repository's conventions — Issue Forms, the template chooser, a Pull Request
  template, labels, AGENTS.md and a conventions document — by finding out what it already
  declares and filling only the real gaps. Incremental, non-destructive and idempotent: it
  never overwrites a convention that exists. Use this skill whenever the user wants to set up
  or standardise a repository's conventions, bootstrap a new project, add issue templates or
  adopt AGENTS.md — "initialize this repository", "set up the conventions", "inicializar este
  repositório", "padronizar o repositório", "adicionar templates de issue", "criar AGENTS.md".
  Do NOT use it to create an issue (use generate-issue) or to review one (use review-issue).
license: MIT
compatibility: >
  Requires git and a writable working directory. gh is optional, used only to read the
  repository's real labels and the organization's Issue Types. Creates files; never overwrites
  or deletes one.
metadata:
  publisher: issue-flow
  version: "1"
  homepage: https://github.com/fabioassuncao/issue-flow
---

# Initialise a repository's conventions

Make a repository predictable for both humans and agents. The job is **not** to
impose a structure: it is to find out what the repository already decided,
respect it, and fill only the real gaps.

**Use it** to bootstrap or standardise conventions.
**Do not use it** to create or review an issue.

## Requirements

| Needs | For |
|---|---|
| `git`, inside a repository | locating the root and the working scope |
| a writable working directory | the files it creates |
| `gh` — **optional** | reading the labels that really exist and the organization's Issue Types |

**Writes:** only files that are missing — see
[references/repository-scaffold.md](references/repository-scaffold.md).
**Never overwrites and never deletes.** Existence is re-checked immediately
before each write.

Optional: when the Issue Flow CLI is on the PATH it computes the plan and
applies it deterministically. It is a convenience, not a requirement.

## The one rule

**Never overwrite a convention that exists.** A repository that declares
something different from the defaults is not wrong — adapting to it is the
entire point. "Initialise" must never become a euphemism for "replace".

When you find an inconsistency you cannot resolve without guessing, **report it
and leave it alone.** A wrong automatic fix costs more than a documented
inconsistency.

## Step 1 — Work out what is missing

### With the Issue Flow CLI

```bash
issue-flow init --json
```

Add `--scope <dir>` in a monorepo, to resolve the conventions that apply to the
directory being worked in.

| Field | Meaning |
|---|---|
| `root` | the repository the plan applies to |
| `actions[].path` | the file |
| `actions[].kind` | `create` (missing), `keep` (already handled), `review` (present but inconsistent) |
| `actions[].tier` | `required`, `recommended` or `contextual` |
| `actions[].reason` | why that decision was taken — quote it to the user |
| `notes` | findings not tied to one file |

### Without it

Derive the same plan by reading the repository. Do not stop, and do not tell the
user to install anything before you can help:

- `.github/ISSUE_TEMPLATE/` — templates or Issue Forms? A repository with none
  may still get the **organization's** on github.com;
- `.github/PULL_REQUEST_TEMPLATE.md`, or the directory of several;
- `AGENTS.md` and `CLAUDE.md`, at the root and at each level being worked in;
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CODEOWNERS`;
- the labels that really exist — `gh label list`;
- the organization's Issue Types — `gh api orgs/{org}/issue-types`;
- any conventions document under `docs/`.

More detail in
[references/repository-conventions.md](references/repository-conventions.md).

Apply the same rule either way: **anything present is kept.** The verdicts and
the behaviour expected for each repository state are in
[references/repository-scaffold.md](references/repository-scaffold.md).

## Step 2 — Show the plan before writing anything

Report, grouped:

1. **what already exists and will be left alone, and why** — usually the most
   valuable half of the report, because it tells the user the tool understood
   their repository;
2. what is missing and would be created;
3. what is inconsistent and needs a human decision.

Then ask for confirmation, unless the user already said to just do it.

## Step 3 — Apply

```bash
issue-flow init --apply
```

It writes only what was marked `create`, re-checking each path immediately
before writing. Running it twice writes nothing the second time.

Without the CLI, create the same files by hand, following
[references/repository-scaffold.md](references/repository-scaffold.md) for their
content and their purpose — and skip any path that already exists.

## Step 4 — The two migrations that need a human

Both mean moving text somebody wrote, so neither is ever automatic.

**`CLAUDE.md` holds instructions and there is no `AGENTS.md`.** Offer to promote
it: move the content into `AGENTS.md`, reduce `CLAUDE.md` to the single line
`Read and follow the instructions in AGENTS.md.` Only with the user's agreement,
and preserve the content **verbatim** — reorganise it afterwards, in a separate
step they can review.

**Both files hold instructions.** Two copies of the same rules diverge the first
time only one is edited. Keep `AGENTS.md` as the canonical source, tell the user
what differs, and let them decide what survives.

## Step 5 — What only the user can do

- **Issue Types are an organization setting.** When there are none, say so:
  defining them there is better than the `type:*` label fallback, because a
  label alongside a native field becomes a second truth that drifts.
- **Labels are never created here.** When the repository has none, the proposed
  set lands in `.github/labels.json` for the user to apply deliberately — with
  `gh label create`, or by syncing the file.

## Success and failure

**Done** when every gap is either filled or reported, and nothing that existed
was touched. Say what was created, what was kept and why, and what still needs a
human.

**Not a git repository:** say so and stop. There is nothing to standardise.

## Gotchas

- **A repository with no local templates is not a repository without
  templates** — the organization may serve them on github.com. Check before
  proposing local copies.
- **Running twice must write nothing the second time.** The plan comes from what
  is present, never from what a previous run did.
- **`review` is a report, not a task.** Never resolve one by rewriting a file.
