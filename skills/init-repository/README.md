# init-repository

Standardises a repository's conventions — Issue Forms, the template chooser, a
Pull Request template, labels, `AGENTS.md` and a conventions document — by
finding out what it already declares and filling only the real gaps.

**Never overwrites a convention that exists.** A repository that declares
something different from the defaults is not wrong; adapting to it is the point.
Running the skill twice writes nothing the second time.

## Usage

```
Initialize this repository
```

```
Padronizar o repositório
```

```
Add issue templates and an AGENTS.md
```

## What it does

1. Works out what is missing — asking the Issue Flow CLI when it is installed,
   or reading the repository directly when it is not.
2. Shows the plan first, grouped into what already exists (and why it is being
   left alone), what would be created, and what needs a human decision.
3. Applies only what is missing, after confirmation.
4. Reports the two migrations it will never do automatically: promoting a
   `CLAUDE.md` that holds instructions into `AGENTS.md`, and reconciling two
   files that both hold instructions.

## What it can create

| File | Tier |
|---|---|
| `.github/ISSUE_TEMPLATE/*.yml` and `config.yml` | required |
| `.github/PULL_REQUEST_TEMPLATE.md` | required |
| `AGENTS.md` | required |
| `CLAUDE.md` (one line, pointing at `AGENTS.md`) | recommended |
| `docs/conventions.md` | recommended |
| `.github/labels.json` | contextual — only when the repository has no labels |

Nothing is created just to fill out a structure, and **labels are never created
on GitHub**: the proposed set lands in `.github/labels.json` for a human to
apply deliberately.

## Requirements

- **Git**, inside a repository
- A writable working directory
- **GitHub CLI** (`gh`) — optional, used only to read the labels that really
  exist and the organization's Issue Types

## With the Issue Flow CLI

`issue-flow init --json` computes the plan and `issue-flow init --apply` writes
it, re-checking each path immediately before writing. The skill works without
it: [`references/repository-scaffold.md`](references/repository-scaffold.md)
carries the same baseline, so the fallback creates the same files by hand.
