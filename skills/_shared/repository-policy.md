# Shared: reading the repository's policy

**One source, many references.** Every skill that takes a policy decision reads
this block instead of restating it. When the rule changes, it changes here.

## Why this exists

The CLI and the skills are two paths to the same outcome, and a user is entitled
to the same decisions from both. The CLI resolves the repository's policy in
`packages/issue-flow/src/policy/`; skills are markdown and cannot import
TypeScript, so `issue-flow policy --json` is the bridge between them.

Without it, each skill re-derives the repository's conventions its own way, and
the two paths drift — which is exactly the divergence this shared block exists to
close.

## How to read it

Run this as the **first** step of any decision that depends on repository
conventions:

```bash
issue-flow policy --json --scope "$(git rev-parse --show-prefix)" 2>/dev/null
```

`--scope` matters in a monorepo: it selects the `AGENTS.md` hierarchy that
applies to the directory you are working in, root first, most specific last.
`git rev-parse --show-prefix` is empty at the repository root, which the command
reads as "the whole repository".

If `issue-flow` is not on the PATH, try `npx --yes issue-flow@latest policy --json`
once. Do not retry beyond that.

## Best-effort is the contract

**A skill that needs the network to work is a regression.** Treat this step as an
enrichment that may simply not answer:

| Outcome | What to do |
|---|---|
| Valid JSON | follow the policy it returns |
| Command not found | follow the skill's documented defaults |
| Non-zero exit, empty output, unparseable JSON | follow the skill's documented defaults |
| Takes too long | stop waiting; follow the defaults |
| `"enabled": false` | the repository turned discovery off — follow the defaults |

Never fail, never block, and never tell the user to install anything just to
proceed. Say which path you took only when it changed a decision.

The payload may gain fields in a future release: read the ones you need and
ignore the rest. `schemaVersion` only changes when a reader would have to.

## What the payload carries

```jsonc
{
  "schemaVersion": 1,
  "root": "/abs/path",          // repository root
  "scope": "apps/api",          // subdirectory resolved, or null
  "enabled": true,              // false when the repository turned discovery off
  "issues": {
    "templates": [ /* name, path, format, labels, type, title, content */ ],
    "types": ["Bug", "Feature"],       // organization Issue Types, when any
    "labels": [ /* name, description, color — the ones that REALLY exist */ ],
    "titleConvention": null
  },
  "pullRequests": {
    "template": "…",            // content of the default PR template
    "templates": [ /* every template, for the multi-template layout */ ],
    "baseBranch": "develop",
    "titleConvention": null
  },
  "git": {
    "branchConvention": null,
    "commitConvention": null,
    "pullRequestTitleConvention": null,
    "issueReference": null,
    "typeMap": null,
    "allowedTypes": null,
    "scopes": null
  },
  "docs": [ /* path, kind, scope, referencedFrom, content */ ],
  "codeowners": "…",
  "sources": [ /* provenance of every value above */ ]
}
```

## How to apply it

- **Labels** — use only what `issues.labels` lists, matching its casing. Never
  create one. Labels are governance: a team that deleted `high`/`medium`/`low` in
  favour of a native priority field made a decision, and recreating them undoes
  it silently. `issues.allowLabelCreation` is the only exception, and it is off
  by default.
- **Issue Templates** — when `issues.templates` is non-empty, the applicable one
  defines the body's structure and its required fields. A skill's own default
  structure is the fallback for a repository with no template, never a floor to
  stack on top of one. Two templates fitting equally well is a question for the
  user, not a coin toss.
- **Issue Types** — when `issues.types` is non-empty, pick one and pass
  `--type`. A repository with Issue Types has usually removed the equivalent
  textual prefix from titles, precisely because that information moved into a
  structured field: do not reintroduce it.
- **Base branch** — `pullRequests.baseBranch` is the target of a Pull Request and
  the left side of every `git log`/`git diff` range. Never assume `main`: in a
  repository based on `develop`, `main` usually exists too, so assuming it does
  not fail — it silently produces the wrong diff.
- **Branch and commits** — follow `git.branchConvention` and
  `git.commitConvention` when declared. When they are empty, use
  `issue-flow conventions` (see `docs/git-conventions.md`). A branch that does
  not match is worth a warning, never a stop.
- **Pull Request body** — when `pullRequests.template` is present, keep every one
  of its headings and answer the sections that do not apply with one line saying
  why. Deleting a section is what makes automated review read it as unanswered.
- **Documents** — `docs[].path` are pointers. Read the ones a decision depends on,
  and **follow a pointer file rather than stopping at it**: a `CLAUDE.md` whose
  entire content forwards to `AGENTS.md` is not a repository without conventions.
- **Never restate a repository rule as your own standard**, and never invent one
  it does not declare. Cite the document and section behind every rule you
  invoke — a rule without a citation is an opinion the author cannot check.

## When nothing is declared

Every field empty is the normal case, and it means the skill behaves exactly as
it did before this layer existed. That is the compatibility guarantee of the
whole series: a repository that declares nothing sees no change.
