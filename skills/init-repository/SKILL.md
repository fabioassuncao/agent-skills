---
name: init-repository
description: >
  Initialize or standardize a repository with the recommended conventions — Issue Forms, template
  chooser, Pull Request template, labels, AGENTS.md, CLAUDE.md and the conventions document.
  Analyzes what already exists first and never overwrites it: initialization is incremental,
  non-destructive and idempotent. Use this skill whenever the user wants to set up a repository's
  conventions, bootstrap a new project, standardize an existing one, add issue templates, adopt
  AGENTS.md, or asks "initialize this repository", "set up the conventions", "inicializar este
  repositório", "padronizar o repositório", "adicionar templates de issue", "criar AGENTS.md".
  Do NOT use to create an issue (use generate-issue) or to review one (use review-issue).
compatibility: Requires git; `gh` only to read the repository's real labels and Issue Types
---

# Initialize repository conventions

> **Repository policy — read this first.** Every decision below that depends on
> this repository's conventions follows
> [`skills/_shared/repository-policy.md`](../_shared/repository-policy.md).
> Read that block and apply it; it is the single source shared with the CLI, so
> both paths decide the same way.

You are standardizing a repository so that both humans and coding agents can work
in it predictably. Your job is **not** to impose a structure: it is to find out
what the repository already decided, respect it, and fill only the real gaps.

## The one rule

**Never overwrite a convention that exists.** A repository that declares
something different from the defaults is not wrong — adapting to it is the entire
point of this tool. "Initialize" must never become a euphemism for "replace".

When you find an inconsistency you cannot resolve without guessing, **report it
and leave it alone**. A wrong automatic fix costs more than a documented
inconsistency.

## Step 1 — Ask the shared core what is missing

The analysis and the plan are not yours to re-derive: the CLI owns them, and it
is the same code path the `issue-flow init` command uses. Run it:

```bash
issue-flow init --json
```

Add `--scope <dir>` in a monorepo, to resolve the conventions that apply to the
directory being worked in.

The payload carries:

| Field | Meaning |
|---|---|
| `root` | The repository the plan applies to |
| `actions[].path` | The file |
| `actions[].kind` | `create` (missing), `keep` (already handled), `review` (present but inconsistent) |
| `actions[].tier` | `required`, `recommended` or `contextual` |
| `actions[].reason` | Why that decision was taken — quote it to the user |
| `notes` | Findings that are not tied to one file |

**If the CLI is not available**, fall back to the manual analysis in Step 2. Do
not stop, and do not tell the user to install anything before you can help.

## Step 2 — Manual analysis, only when the CLI is unavailable

Determine, by reading the repository:

- `.github/ISSUE_TEMPLATE/` — does it have templates or Issue Forms? Does the
  **organization** serve them instead (a repository with none still gets the
  organization's on github.com)?
- `.github/PULL_REQUEST_TEMPLATE.md`, or the directory of several
- `AGENTS.md`, `CLAUDE.md` — at the root and at each level being worked in
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CODEOWNERS`
- the labels that really exist (`gh label list`)
- the organization's Issue Types (`gh api orgs/{org}/issue-types`)
- any conventions document under `docs/`

Apply the same rule the core applies: anything present is kept.

## Step 3 — Show the plan before writing anything

Report, grouped:

1. what already exists and will be left alone, **and why** — this is usually the
   most valuable half of the report, because it tells the user the tool
   understood their repository;
2. what is missing and would be created;
3. what is inconsistent and needs a human decision.

Then ask for confirmation, unless the user already asked you to just do it.

## Step 4 — Apply

```bash
issue-flow init --apply
```

It writes only what was marked `create`, re-checking each path immediately before
writing. Running it twice writes nothing the second time.

Without the CLI, create the same files by hand, following
[`docs/conventions.md`](../../docs/conventions.md) for their content — and skip
any path that already exists.

## Step 5 — The two migrations that need a human

The core reports these as `review` and never resolves them, because both mean
moving text somebody wrote:

**`CLAUDE.md` holds instructions and there is no `AGENTS.md`.** Offer to promote
it: move the content into `AGENTS.md`, reduce `CLAUDE.md` to the single line
`Read and follow the instructions in AGENTS.md.` Do it only with the user's
agreement, and preserve the content verbatim — reorganize it afterwards, in a
separate step the user can review.

**Both files hold instructions.** Two copies of the same rules diverge the first
time only one is edited. Keep `AGENTS.md` as the canonical source, tell the user
what differs between the two, and let them decide what survives.

## Step 6 — What only the user can do

Some conventions are not files and cannot be created from here:

- **GitHub Issue Types** are an organization setting. When there are none, say
  so: defining them there is better than the `type:*` label fallback, because a
  label alongside a native field becomes a second truth that drifts.
- **Labels** are never created by Issue Flow. When the repository has none, the
  proposed set lands in `.github/labels.json` for the user to apply
  deliberately — with `gh label create`, or by syncing the file.

## What gets created, and why each file exists

| File | Tier | Responsibility |
|---|---|---|
| `.github/ISSUE_TEMPLATE/*.yml` | required | One Issue Form per type. Structure is what makes an issue actionable by an agent |
| `.github/ISSUE_TEMPLATE/config.yml` | required | The chooser. Keeps blank issues enabled — a closed chooser turns a report into silence |
| `.github/PULL_REQUEST_TEMPLATE.md` | required | Gives review a body it can rely on |
| `AGENTS.md` | required | The canonical entry point for any agent, as an index |
| `CLAUDE.md` | recommended | One line pointing at `AGENTS.md` |
| `docs/conventions.md` | recommended | The source of truth the other files reference |
| `.github/labels.json` | contextual | Proposed only when the repository has no labels at all |

Nothing is created just to fill out a structure. A repository whose
`CONTRIBUTING.md` and Issue Templates already document how it works does not get
a competing `docs/conventions.md`.

## Agent entry points

The convention this establishes:

```text
CLAUDE.md  →  AGENTS.md  →  specialized documentation  →  single source of truth
```

- **`AGENTS.md`** is the canonical entry point, for any agent of any vendor. It
  is an *index*: it names the documents to read and holds no rule of its own.
- **`CLAUDE.md`** exists only as the Claude Code integration, and contains one
  line pointing at `AGENTS.md`. The same applies to any other tool-specific
  adapter.
- **The documentation** is where rules live.

Do not put commands, code style, architecture rules or testing strategy into
`AGENTS.md`. If it is a rule, a standard or reusable knowledge, it belongs in its
own document, and `AGENTS.md` only points at it. Instructions duplicated in an
agent file age out of sight and start contradicting the source without anyone
noticing.
