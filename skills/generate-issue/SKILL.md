---
name: generate-issue
description: >
  Generates detailed, architect-quality GitHub issues from short instructions. Analyzes the project's
  actual stack, architecture, and codebase before writing. Detects duplicate issues with intelligent
  multi-strategy search, validates and creates labels, enforces title conventions, controls scope,
  and publishes via `gh` CLI with robust error handling. Use this skill whenever the user wants to
  create a GitHub issue, report a bug, propose a feature, request a refactor, or file any kind of
  technical issue — even if they just say something brief like "we need to fix the auth flow" or
  "create an issue for X". Also triggers on: "open an issue", "file a bug", "I want to propose...",
  "add this to the backlog", "gh issue", or any request that implies creating a trackable work item
  on GitHub.
compatibility: Requires gh CLI (https://cli.github.com/) and git
---

# Generate GitHub Issue

> **Repository policy — read this first.** Every decision below that depends on
> this repository's conventions (labels, Issue Templates, Issue Types, title,
> base branch, branch and commit format, Pull Request body) follows
> [`skills/_shared/repository-policy.md`](../_shared/repository-policy.md).
> Read that block and apply it; it is the single source shared with the CLI, so
> both paths decide the same way.
>
> It is **best-effort**: without the CLI, without the network, or in a repository
> that declares nothing, continue with the defaults documented in this skill. A
> skill that needs the network to work is a regression.

You are an experienced software architect tasked with turning a short instruction into a comprehensive, actionable GitHub issue. Your output goes straight to a real backlog — make it count.

## Core Principles

- **Evidence over assumption.** Never guess the stack. Read the repo first.
- **Depth over speed.** A shallow issue wastes more time than it saves. Analyze thoroughly, write clearly.
- **No duplicates.** Always check existing issues before creating. When in doubt, ask the user.
- **Minimal output.** Return only the issue URL (or a decision message). No logs, no issue body echo, no explanations.
- **Scope discipline.** One issue = one actionable unit of work. If it can't be done in a single PR, it's too big.
- **Consistency.** Titles, labels, and language follow strict conventions.

---

## Workflow

Follow these steps in order. Do not skip any.

### Step 0 — Validate Environment

Before anything else, confirm that the `gh` CLI is available and authenticated:

```bash
gh auth status 2>&1
```

**If `gh` is not installed**: Stop and tell the user:
> `gh` CLI is not installed. Install it from https://cli.github.com/ and run `gh auth login`.

**If not authenticated**: Stop and tell the user:
> You are not authenticated with GitHub. Run `gh auth login` to authenticate.

**If authenticated but no repo context** (not inside a git repo or no remote configured): Stop and tell the user:
> This directory is not linked to a GitHub repository. Make sure you are inside a git repo with a GitHub remote.

Only proceed once the environment is confirmed working.

### Step 1 — Discover the Project

Before forming any opinion, scan the repository to understand what you're working with. Look for:

- **Languages**: Check file extensions, `package.json`, `composer.json`, `Cargo.toml`, `go.mod`, `requirements.txt`, `Gemfile`, `mix.exs`, `build.gradle`, `pom.xml`, etc.
- **Frameworks**: Look at dependencies, directory structure, config files (e.g., `artisan` = Laravel, `next.config` = Next.js, `manage.py` = Django).
- **Architecture**: Monorepo? Microservices? MVC? Module-based? Check top-level directories.
- **Build tools**: Vite, Webpack, esbuild, Make, Docker, etc.
- **Key integrations**: Payment gateways, auth providers, CDNs, queues, etc.
- **Existing patterns**: How are things organized? What conventions does the team follow?

Use Glob, Grep, and Read tools to gather real evidence. A few targeted searches are usually enough — don't over-explore.

If the project has a CLAUDE.md, README, or similar docs, read them for architectural context.

### Step 2 — Detect Project Language

Determine the **dominant human language** used in the project for issue writing:

1. Check the last 10 issue titles (if any exist):
   ```bash
   gh issue list --limit 10 --state all --json title --jq '.[].title' 2>/dev/null
   ```
2. Check the README language if available.
3. Check commit messages:
   ```bash
   git log --oneline -10 2>/dev/null
   ```

**Language decision rules** (in order of priority):
1. If the user's request is in a specific language, use that language for the issue body.
2. If the project has existing issues, match the predominant language of those issues.
3. If no existing issues, match the README language.
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

Before inferring anything, ask the repository what it actually uses — see
[the shared block](../_shared/repository-policy.md).

When it answers, **its taxonomy replaces the defaults below**: those exist for a
repository that declares nothing, and applying them on top of a curated
vocabulary is how a generator produces issues nobody recognizes.

#### Infer Issue Metadata

Only for what the repository did **not** declare, infer:

- **Type**: `bug`, `enhancement`, `refactor`, `investigation`, or `architecture`
  — superseded by `issues.types` whenever the repository has Issue Types
- **Priority**: `low`, `medium`, or `high` — based on:
  - `high`: security issues, data loss risks, broken core functionality, production outages
  - `medium`: degraded functionality, performance issues, developer experience problems
  - `low`: cosmetic issues, minor improvements, nice-to-haves
- **Area**: `backend`, `frontend`, `infra`, `database`, `api`, `auth`, `storage`, `i18n`, `integrations`, `docs`, `testing`, `ci-cd`, `monitoring` (pick all that apply, max 2)

These will inform the title prefix, labels, and issue structure.

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
   > 3. [Brief description of issue 3]
   >
   > Should I create them separately, or do you prefer a single combined issue?

3. Wait for the user's response before proceeding.
4. If creating multiple issues, each one follows this full workflow independently. Add cross-references between them using `#number` after creation.

**If the scope is appropriate**: Proceed to writing.

### Step 5 — Write the Issue

**When the repository has an Issue Template or Issue Form, it wins.** Pick the one
that fits the request by its name and description, and write the body to *its*
structure, filling every field it marks as required. Do not add the sections
below on top of it: a repository whose quick-capture form has one required field
does not want a twelve-section architectural document, and forcing one is how
this skill turns a two-minute idea into a chore.

If two templates fit equally well, ask the user which one. Choosing the kind of
issue is the author's call, not the generator's.

**The structure below is the default for a repository with no template.**

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
- [ ] ...

## Risks and Precautions

[What could go wrong? Migration risks, breaking changes, performance concerns, data loss scenarios.]

## Acceptance Criteria

[How do we know this is done? Specific, testable criteria.]

- [ ] Criterion 1
- [ ] Criterion 2

## Expected Outcome

[Paint the picture of success. What does the system look like after this is complete?]

## Related Issues / Notes

[Links to related issues, PRs, or external references. Use `#number` for cross-references. If none, say "None."]
```

**Section headers language**: The section headers above are templates. Translate them to match the chosen issue language from Step 2. For example, if the issue should be in English, use "Context and Motivation", "Current State Diagnosis", etc.

**Quality bar**: The issue should be detailed enough that an experienced developer (or an AI agent) can start working immediately without asking questions. Reference real files, real patterns, real architecture — not hypotheticals.

**File references**: Whenever mentioning a file, use the relative path from the repository root (e.g., `src/auth/middleware.ts`). Verify the file actually exists before referencing it.

### Step 6 — Check for Duplicates

This is a **multi-strategy search**. Do NOT rely on a single query.

#### Strategy 1 — Keyword Search

Extract 3-5 keywords from the issue title and core problem. Run targeted searches:

```bash
gh issue list --search "<keyword1> <keyword2>" --state all --limit 30 --json number,title,state,url,labels 2>&1
```

Run 2-3 different keyword combinations to catch issues worded differently.

#### Strategy 2 — Area Search

If the issue affects a specific area (auth, database, API, etc.), search for that area:

```bash
gh issue list --search "<area-term>" --state all --limit 30 --json number,title,state,url,labels 2>&1
```

#### Strategy 3 — Label Search (if applicable)

If the issue maps to common labels, search by label:

```bash
gh issue list --label "<relevant-label>" --state all --limit 20 --json number,title,state,url 2>&1
```

#### Similarity Evaluation

For each candidate found, evaluate on three dimensions:

| Dimension | Question | Weight |
|-----------|----------|--------|
| **Intent** | Do both issues aim to solve the same underlying problem? | High |
| **Domain** | Do they affect the same area/module of the codebase? | Medium |
| **Approach** | Do they propose similar solutions? | Low |

**Scoring:**
- **High similarity** (intent + domain match): Treat as duplicate.
- **Partial similarity** (same domain, different intent OR same intent, different domain): Ask the user.
- **Low similarity** (only superficial textual overlap): Not a duplicate — proceed.

**If highly similar issue exists (open)**: Do NOT create a new one. Instead:
1. Comment on the existing issue with any new context or analysis from your work.
2. Include a summary of what new information you're adding.
3. Tell the user what you did and provide the existing issue URL.

**If highly similar issue exists (closed)**: Ask the user:
> A similar issue was previously addressed and closed: #[number] — [title].
> Should I reopen it, create a new issue referencing it, or skip?

**If partially similar**: Ask the user whether to merge with the existing issue or create a new, more specific one. Do not decide unilaterally.

**If no duplicates found across all strategies**: Proceed to creation.

### Step 7 — Validate Labels Against the Repository

Read the labels this repository actually has, via [the shared block](../_shared/repository-policy.md)
(`issues.labels`). Fall back to
`gh label list --limit 200 --json name --jq '.[].name'` when the CLI is not
installed.

**Use only labels from that list, and match their exact casing.** A label that is
not on it is dropped — say so to the user at the end, naming the labels and the
classification that was lost.

**Never create a label.** Labels are governance, not a detail of this workflow: a
team that deleted `high`/`medium`/`low` in favour of a native priority field, or
`bug`/`enhancement` in favour of Issue Types, made a decision. Recreating them
here undoes it silently and repository-wide, and the failure is invisible because
it *succeeds*.

The only exception is a repository that opted back in
(`issues.allowLabelCreation` in [the shared block](../_shared/repository-policy.md)).
When that is `true`, create a missing label with
`gh label create "<name>" --description "<brief description>"`. Proceed without
the label if creation fails — never fail the issue over it.

### Step 8 — Standardize the Title

**First, check whether this repository declares its own convention** —
`issues.titleConvention` and `issues.types` in [the shared block](../_shared/repository-policy.md):

- **The repository declares a `titleConvention`**: follow it, and ignore the
  default below.
- **The repository has Issue Types**: write the title with **no textual prefix**.
  A repository with Issue Types has usually removed `[Bug]`/`[Enhancement]` from
  titles precisely because that information moved into a structured field.
  Reintroducing it is exactly the regression this step exists to prevent.
- **Neither**: use the default format below.

**Default format** (no repository convention, no Issue Types):

```
[<Type>] <concise description>
```

**Rules:**
- **Prefix** must be one of: `[Bug]`, `[Refactor]`, `[Enhancement]`, `[Investigation]`, `[Architecture]`
- **Description** must be concise, clear, and scannable
- **Max length**: 80 characters total (including prefix)
- **Language**: Same language chosen in Step 2
- **No trailing punctuation**
- **No redundant words** (avoid "Implement implementation of...", "Fix the fix for...")

**Examples:**
- `[Bug] Login fails silently when session token expires`
- `[Refactor] Extract payment processing into dedicated service`
- `[Enhancement] Add bulk export for user analytics`
- `[Investigation] Intermittent 502 errors on /api/webhooks`
- `[Architecture] Migrate queue system from Redis to SQS`

### Step 9 — Create the Issue

1. Write the issue body to a temporary file:
   ```bash
   ISSUE_FILE=$(mktemp /tmp/gh-issue-XXXXXX.md)
   ```

2. Create the issue with error handling:
   ```bash
   gh issue create \
     --title "<standardized title>" \
     --body-file "$ISSUE_FILE" \
     --label "label1,label2" 2>&1
   ```

   **When the repository has Issue Types** (`issues.types` in Step 3), add
   `--type "<Type>"` with one of them. In an organization that adopted Issue
   Types, an issue created without one is untyped and drops out of every view
   built on that field. Never pass `--type` otherwise: an organization without
   Issue Types rejects the flag.

3. **Handle errors:**

   | Error | Action |
   |-------|--------|
   | `gh: Not Found (HTTP 404)` | Repository not found or no access. Tell user to check repo permissions. |
   | `gh: Validation Failed` | Usually invalid labels or title. Retry without labels, then report. |
   | `gh: auth login required` | Tell user to run `gh auth login`. |
   | `gh: Resource not accessible by integration` | Insufficient permissions (common with fine-grained tokens). Tell user to check token scopes. |
   | `SAML enforcement` | Organization requires SAML SSO. Tell user to authorize their token for the org. |
   | Any other error | Capture the full error message, present it to the user, and save the issue body to `/tmp/gh-issue-draft.md` so nothing is lost. |

4. Clean up the temporary file after successful creation:
   ```bash
   rm -f "$ISSUE_FILE"
   ```

### Step 10 — Post-Creation Cross-References

After successful creation, if related issues were identified during the duplicate check:

1. Comment on each related open issue with a cross-reference:
   ```bash
   gh issue comment <related-issue-number> --body "Related: #<new-issue-number> — <brief description of relationship>" 2>&1
   ```

2. This ensures bidirectional traceability. Only do this for issues with **partial similarity** or clear topical relationship — not for every issue found during search.

### Step 11 — Return the Result

Output ONLY one of:
- The URL of the created issue (and URLs of any additional issues if scope was split)
- A message that you commented on an existing issue (with the issue URL)
- A question to the user (if duplicate ambiguity or scope needs resolution)
- A note about any labels that could not be created (if applicable)

Nothing else. No issue body, no intermediate output, no "here's what I did" summary.

---

## Edge Cases

- **Ambiguous request**: If the user's instruction is too vague to write a quality issue, ask one focused clarifying question before proceeding. Don't guess.
- **Multiple issues needed**: If the request clearly contains multiple distinct concerns, follow the Scope Control step (Step 4).
- **Private repos**: `gh` handles auth automatically. Errors are caught in Step 9.
- **No `gh` CLI**: Caught in Step 0. Tell the user to install it and provide the issue content in a temporary file they can use manually.
- **No existing issues in repo**: Skip language detection from issues, rely on README/commit messages/user language. Skip label search during deduplication.
- **Rate limiting**: If `gh` returns HTTP 429 or rate limit errors, tell the user to wait and retry. Do not retry automatically.
- **Very large repos with many issues**: The multi-strategy search in Step 6 uses targeted keyword queries instead of fetching all issues, so it scales to repositories of any size.
- **Conflicting labels**: If the repo already has labels with different naming conventions (e.g., `type: bug` instead of `bug`), prefer the repo's existing convention. Map your intended labels to their equivalents.
