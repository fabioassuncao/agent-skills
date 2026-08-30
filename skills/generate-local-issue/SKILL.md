---
name: generate-local-issue
description: >
  Generates detailed, architect-quality issues as local files under `issues/<N>/issue.md` and
  `issues/<N>/metadata.json`, with no GitHub involved. Analyzes the project's actual stack,
  architecture, and codebase before writing, allocates a collision-free identifier, and checks
  for duplicates against existing local issues. Use this skill whenever the user wants to create
  an issue without GitHub — offline, in a repository with no remote, when `gh` is not installed
  or not authenticated, or when the demand is still private. Triggers on: "create a local issue",
  "issue local", "criar issue local", "open an issue offline", "file this in issues/ without
  GitHub", "add this to the backlog locally", or any request to record a trackable work item as
  files in the repository. Do NOT use when the issue should live on GitHub — use `generate-issue`
  for that.
compatibility: Requires git. `gh` CLI is optional and only used to avoid identifier collisions.
---

# Generate Local Issue

You are an experienced software architect tasked with turning a short instruction into a comprehensive, actionable issue stored as plain files in the repository. Your output goes straight into the Issue Flow pipeline (`issue-flow run <N> --local`) — make it count.

## Why this skill exists

Issue Flow treats the origin of an Issue as pluggable: the `local` provider reads and writes `issues/<id>/issue.md` + `issues/<id>/metadata.json`, and every pipeline phase works over it exactly as it does over GitHub. This skill is the authoring side of that provider — it produces artifacts the `LocalFileIssueProvider` can read back without a single network call.

The CLI equivalent is `issue-flow generate --prompt "..." --local`. Use this skill when you are inside an agent session and want the analysis, duplicate check, and file writing done interactively.

## Core Principles

- **Evidence over assumption.** Never guess the stack. Read the repo first.
- **Depth over speed.** A shallow issue wastes more time than it saves. Analyze thoroughly, write clearly.
- **No duplicates.** Always check `issues/*/metadata.json` before creating. When in doubt, ask the user.
- **Never overwrite.** An existing `issues/<id>/issue.md` is someone's work. Refuse and suggest another identifier.
- **Offline first.** Nothing in this workflow may fail because `gh` is missing or unauthenticated.
- **Minimal output.** Return only the created paths (or a decision message). No logs, no issue body echo.
- **Scope discipline.** One issue = one actionable unit of work. If it can't be done in a single PR, it's too big.

---

## Workflow

Follow these steps in order. Do not skip any.

### Step 0 — Validate Environment

Confirm you are inside a git repository and that the project root is writable:

```bash
git rev-parse --show-toplevel 2>&1
```

**If not a git repository**: Ask the user to confirm the directory where `issues/` should live, then use that directory as the project root. Do not create issues outside it.

Everything below is relative to the project root. Do **not** check `gh auth status` — this skill must work with no GitHub access at all.

### Step 1 — Discover the Project

Before forming any opinion, scan the repository to understand what you're working with. Look for:

- **Languages**: Check file extensions, `package.json`, `composer.json`, `Cargo.toml`, `go.mod`, `requirements.txt`, `Gemfile`, `mix.exs`, `build.gradle`, `pom.xml`, etc.
- **Frameworks**: Look at dependencies, directory structure, config files (e.g., `artisan` = Laravel, `next.config` = Next.js, `manage.py` = Django).
- **Architecture**: Monorepo? Microservices? MVC? Module-based? Check top-level directories.
- **Build tools**: Vite, Webpack, esbuild, Make, Docker, etc.
- **Existing patterns**: How are things organized? What conventions does the team follow?

Use Glob, Grep, and Read tools to gather real evidence. A few targeted searches are usually enough — don't over-explore.

If the project has a CLAUDE.md, README, or similar docs, read them for architectural context.

### Step 2 — Detect Project Language

Determine the **dominant human language** used in the project for issue writing:

1. Check the titles of existing local issues:
   ```bash
   cat issues/*/metadata.json 2>/dev/null | grep '"title"'
   ```
2. Check the README language if available.
3. Check commit messages:
   ```bash
   git log --oneline -10 2>/dev/null
   ```

**Language decision rules** (in order of priority):
1. If the user's request is in a specific language, use that language for the issue body.
2. If local issues already exist, match their predominant language.
3. If none exist, match the README language.
4. Fallback: use the language the user wrote their request in.

Store the chosen language — it will be used for the title, body, and all content.

### Step 3 — Analyze the Request

Take the user's short instruction and expand it technically:

1. What exactly is the problem or opportunity?
2. Which parts of the codebase are affected?
3. What are the downstream impacts?
4. Are there related concerns the user might not have mentioned?
5. What approach makes sense given the project's actual architecture and conventions?

Think like an architect who knows this codebase. The goal is to produce an issue that someone (human or AI agent) can pick up and execute without needing to ask clarifying questions.

#### Read the repository's own taxonomy first

A local issue has no GitHub label registry, but the repository still has
conventions — Issue Templates in `.github/ISSUE_TEMPLATE/`, a title convention,
`AGENTS.md`. Ask for them before inferring anything:

```bash
issue-flow policy --json 2>/dev/null
```

When it answers, its taxonomy replaces the defaults below, exactly as it does for
a GitHub issue: a local issue that ignores the repository's conventions is one
more thing to reconcile the day it is pushed.

#### Infer Issue Metadata

Only for what the repository did **not** declare, infer:

- **Type**: `bug`, `enhancement`, `refactor`, `investigation`, or `architecture`
- **Priority**: `low`, `medium`, or `high` — based on:
  - `high`: security issues, data loss risks, broken core functionality, production outages
  - `medium`: degraded functionality, performance issues, developer experience problems
  - `low`: cosmetic issues, minor improvements, nice-to-haves
- **Area**: `backend`, `frontend`, `infra`, `database`, `api`, `auth`, `storage`, `i18n`, `integrations`, `docs`, `testing`, `ci-cd`, `monitoring` (pick all that apply, max 2)

Labels are free-form strings in local metadata — there is no repository label registry to validate against and nothing to create. Reuse labels already present in `issues/*/metadata.json` before inventing new ones.

### Step 4 — Scope Control

Before writing, evaluate whether the request is too broad for a single issue.

**An issue is too broad if:**
- It touches 3+ unrelated areas of the codebase
- It requires multiple independent PRs that could be reviewed separately
- It contains both architectural decisions AND implementation work
- The execution plan would have 8+ steps with no logical grouping

**If the scope is too broad:**
1. Identify the logical sub-issues (2-4 pieces).
2. Ask the user:
   > This request covers multiple independent concerns. I recommend splitting into separate issues:
   > 1. [Brief description of issue 1]
   > 2. [Brief description of issue 2]
   >
   > Should I create them separately, or do you prefer a single combined issue?

3. Wait for the user's response before proceeding.
4. If creating multiple issues, each one follows this full workflow independently, allocating its own identifier. Cross-reference them by identifier in the "Related Issues / Notes" section.

**If the scope is appropriate**: Proceed to writing.

### Step 5 — Check for Duplicates

The local backlog is the source of truth. Read every existing issue's metadata:

```bash
ls -d issues/*/ 2>/dev/null
cat issues/*/metadata.json 2>/dev/null
```

`issues/` may not exist yet — that is a normal empty backlog, not an error.

For candidates whose title looks related, read the full body:

```bash
cat issues/<candidate>/issue.md
```

If `gh` happens to be installed and authenticated, also check the remote backlog — but never fail when it is not:

```bash
gh issue list --state all --search "<keywords>" --limit 30 --json number,title,state,url 2>/dev/null || true
```

#### Similarity Evaluation

For each candidate found, evaluate on three dimensions:

| Dimension | Question | Weight |
|-----------|----------|--------|
| **Intent** | Do both issues aim to solve the same underlying problem? | High |
| **Domain** | Do they affect the same area/module of the codebase? | Medium |
| **Approach** | Do they propose similar solutions? | Low |

**Scoring:**
- **High similarity** (intent + domain match): Treat as duplicate. Do NOT create a new issue — report the existing identifier and path to the user, and offer to append the new context to its `issue.md`.
- **Partial similarity**: Ask the user whether to extend the existing issue or create a new, more specific one. Do not decide unilaterally.
- **Low similarity** (only superficial textual overlap): Not a duplicate — proceed.

**If a duplicate exists only on GitHub**: Tell the user, and ask whether they want the local issue anyway (a mirror) or prefer working from the remote one. If they want a mirror, keep the remote identifier as the local `id` (see Step 6) and fill the `remote` block in Step 8.

### Step 6 — Allocate the Identifier

The identifier is the directory name under `issues/`. It shares a numbering space with GitHub Issues **and** pull requests, which share a single counter — so allocating above the local maximum alone is not enough when a remote exists.

1. **Highest local number**: the maximum across numeric directory names in `issues/` and the `number` field of every `issues/*/metadata.json`. Absent directory means `0`.
   ```bash
   ls issues/ 2>/dev/null
   cat issues/*/metadata.json 2>/dev/null | grep '"number"'
   ```
2. **Highest remote number**, only when `gh` answers — any failure counts as `0`:
   ```bash
   gh issue list --state all --limit 1 --json number 2>/dev/null || true
   gh pr list --state all --limit 1 --json number 2>/dev/null || true
   ```
3. **Allocate** `max(highest local, highest remote) + 1`.

**Mirroring an existing remote Issue**: skip the allocation and reuse the remote number as the identifier, so `issue-flow run <N>` sees one demand in two places instead of two unrelated Issues.

**Collision check** — before writing anything:

```bash
test -e issues/<id>/issue.md && echo COLLISION
```

If it exists, do **not** overwrite. Stop and tell the user:
> Local issue `<id>` already exists at `issues/<id>/issue.md`. Remove it or pick another identifier before creating a new Issue.

Identifiers are path segments: reject anything containing `/` or `\`, plus `.` and `..`. A leading `#` is stripped.

### Step 7 — Write the Issue Body

**When the repository has an Issue Template or Issue Form, it wins.** Pick the one
that fits the request and write the body to *its* structure, filling every
required field. The structure below is the default for a repository with no
template — do not stack it on top of one.

If two templates fit equally well, ask the user which one.

Use this exact structure. Every section must be present and substantive — no placeholders or one-liners.

```markdown
## Context and Motivation

[Why does this matter? What business or technical need drives this?]

## Current State Diagnosis

[What exists today? How does the current implementation work? Be specific — reference files, patterns, and architecture.]

## Identified Problems

[Concrete problems with the current state. Use a numbered or bulleted list.]

## Objectives

[What should be true when this is done? Clear, measurable goals.]

## Proposed Solution

[The recommended approach. Be specific about what to change, where, and how. Reference actual files/modules when possible.]

## Alternatives Considered

[At least one alternative approach and why it was not chosen.]

## Pros and Cons

### Pros
[Benefits of the proposed solution]

### Cons
[Tradeoffs, costs, or downsides]

## Execution Plan

[Step-by-step implementation plan. Order matters — list dependencies between steps. Use checkboxes.]

- [ ] Step 1
- [ ] Step 2

## Risks and Precautions

[What could go wrong? Migration risks, breaking changes, performance concerns, data loss scenarios.]

## Acceptance Criteria

[How do we know this is done? Specific, testable criteria.]

- [ ] Criterion 1
- [ ] Criterion 2

## Expected Outcome

[Paint the picture of success. What does the system look like after this is complete?]

## Related Issues / Notes

[References to related local issues (`issues/<N>/issue.md`) or remote ones (`#number`). If none, say "None."]
```

**Section headers language**: translate them to the language chosen in Step 2.

**Title format** — the title MUST follow:

```
[<Type>] <concise description>
```

- **Prefix**: `[Bug]`, `[Refactor]`, `[Enhancement]`, `[Investigation]`, or `[Architecture]` —
  unless the repository declares its own `issues.titleConvention` (follow it
  instead) or uses Issue Types (then write no textual prefix at all, since the
  repository moved that information into a structured field)
- **Max length**: 80 characters total, no trailing punctuation, no redundant words
- **Language**: same as Step 2

**File references**: use paths relative to the repository root (e.g., `src/auth/middleware.ts`). Verify the file actually exists before referencing it.

### Step 8 — Create the Files

Create the directory and write both files. **`issue.md` is the source of truth for the content; `metadata.json` for everything else.**

```bash
mkdir -p issues/<id>
```

#### `issues/<id>/issue.md`

The **first non-empty line must be the H1 with the title**, and the body is everything after it. A heading further down belongs to the body and is never promoted to the title.

```markdown
# [Enhancement] Concise description

## Context and Motivation

...
```

#### `issues/<id>/metadata.json`

Every field below is required except `remote`. Validated against `issueMetadataSchema`:

```json
{
  "schemaVersion": 1,
  "id": "42",
  "number": 42,
  "source": "local",
  "title": "[Enhancement] Concise description",
  "labels": ["enhancement", "backend"],
  "state": "open",
  "createdAt": "2026-01-31T12:00:00.000Z",
  "updatedAt": "2026-01-31T12:00:00.000Z",
  "contentHash": "sha256:<hex>"
}
```

| Field | Rules |
|-------|-------|
| `schemaVersion` | Literal `1`. Not optional, no default. |
| `id` | Non-empty string, equal to the directory name. |
| `number` | Positive integer for numeric identifiers, `null` for non-numeric ones (e.g. `"spike-auth"`). Never `0`. |
| `source` | `"local"`. |
| `title` | Must match the H1 in `issue.md`. |
| `labels` | Array of strings, `[]` when none. Never omit the key. |
| `state` | `"open"` on creation, `"closed"` once the pipeline finishes. |
| `createdAt` / `updatedAt` | ISO 8601 (`new Date().toISOString()`). Equal on creation. |
| `contentHash` | `sha256:<hex>` over the normalized title and body (see below). |
| `remote` | Optional. When present, **all four** fields are required: `provider`, `ref`, `syncedAt`, `syncedContentHash`. Fill it only for a mirror of a remote Issue. |

Timestamps:

```bash
node -e 'process.stdout.write(new Date().toISOString())'
```

#### Computing `contentHash`

The hash is what lets the resolver tell "the local and the remote Issue are the same demand" from "they diverged". It is the SHA-256 of the canonical JSON `{"title":...,"body":...}`, with CRLF/CR normalized to LF and both fields trimmed. Compute it from the file you just wrote — never by hand:

```bash
node -e '
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const raw = readFileSync(process.argv[1], "utf-8").replace(/\r\n?/g, "\n");
const lines = raw.split("\n");
const i = lines.findIndex((l) => l.trim().length > 0);
const m = i === -1 ? null : lines[i].match(/^#[ \t]+(.*)$/);
const title = m ? m[1].trim() : "";
const body = m ? lines.slice(i + 1).join("\n").trim() : raw.trim();
const payload = JSON.stringify({ title, body });
process.stdout.write("sha256:" + createHash("sha256").update(payload, "utf8").digest("hex"));
' issues/<id>/issue.md
```

Write `issue.md` **before** `metadata.json`, so the hash always describes content that is already on disk.

### Step 9 — Verify

Confirm the artifacts are readable by the pipeline:

```bash
ls issues/<id>/
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf-8"))' issues/<id>/metadata.json
```

Check by eye that:
- the H1 in `issue.md` is byte-identical to `title` in `metadata.json`;
- `number` matches the directory name (or is `null` for non-numeric identifiers);
- `contentHash` was computed from the final `issue.md`, not from a draft.

Any pipeline command run with `--local` (`issue-flow analyze <id> --local`, `issue-flow run <id> --local`) reads these files back through the provider, so a mismatch surfaces as an explicit error citing the path and the offending field — never as silently empty content.

### Step 10 — Return the Result

Output ONLY one of:
- The created paths (`issues/<id>/issue.md`, `issues/<id>/metadata.json`) and the command to run the pipeline over it (`issue-flow run <id> --local`)
- A message that an equivalent issue already exists (with its path)
- A question to the user (if duplicate ambiguity or scope needs resolution)

Nothing else. No issue body, no intermediate output, no "here's what I did" summary.

---

## Edge Cases

- **`issues/` does not exist**: normal for a first issue. `mkdir -p` creates it; the highest local number is `0`, so the first allocated identifier is `1` (or above the remote maximum when `gh` answers).
- **`gh` missing or unauthenticated**: expected. Skip every remote probe. Never surface a `gh` error to the user — the whole point of a local issue is not needing GitHub.
- **Repository with no remote**: same as above.
- **Non-numeric identifier** (e.g. `spike-auth`): allowed. Set `"number": null` — `0` is rejected by the schema, and a fake number would collide with a real one later.
- **Ambiguous request**: ask one focused clarifying question before proceeding. Don't guess.
- **Existing `issue.md` at the target identifier**: never overwrite. Report the collision and suggest the next free identifier.
- **`issue.md` without `metadata.json`**: valid — the provider derives minimal metadata from the file (title from the H1, `state: "open"`, timestamps from the filesystem). Prefer writing both anyway: derived labels are empty and derived timestamps change when the file is touched.
- **Invalid `metadata.json` in an existing directory**: the provider fails loudly citing the path and field. When you hit one while scanning for duplicates, report it to the user instead of silently skipping — but keep going, and treat that directory's number as taken.
- **Mirroring a remote Issue**: reuse the remote number as the identifier and fill `remote` with all four fields (`provider: "github"`, `ref` = the Issue URL, `syncedAt` = now, `syncedContentHash` = the hash of the remote content at sync time).
- **Should `issues/` be committed?** For local issues, yes — the demand itself lives in the repository, so versioning it is what makes it shareable and reviewable.
