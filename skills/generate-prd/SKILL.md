---
name: generate-prd
description: >
  Generate a structured Product Requirements Document (PRD) from a GitHub issue analysis.
  Produces issues/{ISSUE_NUMBER}/prd.md with user stories, acceptance criteria, and
  functional requirements. Use this skill when you need to create a PRD from an analyzed
  GitHub issue, plan implementation of a feature or fix, or when the resolve-issue skill
  delegates PRD generation. Triggers on: "generate prd", "create a plan for this issue",
  "write requirements", or any request to produce a structured implementation plan from an issue.
---

# PRD Generator (GitHub Issue)

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

## The Job

1. Take the analysis output from `analyze-issue`
2. Ask clarifying questions if the issue is ambiguous
3. Generate a structured PRD
4. Save to `issues/{ISSUE_NUMBER}/prd.md`

**Important:** Do NOT start implementing. Just create the PRD.

---

## Step 1: Clarifying Questions (If Needed)

Only ask if the issue analysis revealed ambiguities. Focus on:

- **Problem/Goal**: What problem does this solve?
- **Core Functionality**: What are the key actions/behaviors?
- **Scope/Boundaries**: What should it NOT do?
- **Success Criteria**: How do we know it's done?

### Format Questions Like This:

```
Before I write the plan, I need to clarify a few things:

1. What is the primary goal of this change?
   A. [Option based on issue context]
   B. [Option based on issue context]
   C. Other: [please specify]

2. What should the scope be?
   A. Minimal viable implementation
   B. Full-featured as described in the issue
   C. Just backend/API changes
   D. Just UI changes
```

Users can respond with short codes like "1A, 2B". Keep it fast and friction-free.

---

## Step 2: PRD Structure

Generate the PRD with these sections:

### 1. Introduction/Overview
Brief description derived from the issue: what feature/fix is being built and what problem it solves.

### 2. Goals
Specific, measurable objectives (bullet list). Derived from the issue's stated goals and acceptance criteria if any.

### 3. User Stories

Each story must be:
- **Small enough to implement in one focused session** (one context window)
- **Independently verifiable**
- **Ordered by dependency** (database → backend → UI)

**Format:**
```markdown
### US-001: [Title]
**Description:** As a [user], I want [feature] so that [benefit].

**Acceptance Criteria:**
- [ ] Specific, verifiable criterion
- [ ] Another criterion
- [ ] Typecheck passes
- [ ] **[UI stories only]** Verify in browser using `playwright-cli` if available; otherwise use the `playwright` MCP/skill
```

**Rules for acceptance criteria:**
- Must be verifiable, not vague
- ❌ Bad: "Works correctly", "Good UX", "Handles edge cases"
- ✅ Good: "Clicking delete shows confirmation dialog", "Button is disabled while loading", "Returns 404 when resource not found"
- Always include "Typecheck passes" as the last item
- Always include "Verify in browser using `playwright-cli` if available; otherwise use the `playwright` MCP/skill" for stories with UI changes

### 4. Functional Requirements
Numbered list:
- `FR-1: The system must...`
- `FR-2: When a user does X, the system must...`

Be explicit and unambiguous. A junior developer or AI agent will read this.

### 5. Non-Goals (Out of Scope)
What this issue will NOT include. Critical for preventing scope creep.

### 6. Design Considerations (Optional)
UI/UX requirements, existing components to reuse, mockup links if available.

### 7. Technical Considerations (Optional)
Constraints, integration points, performance requirements, breaking changes.

### 8. Success Metrics
How will we know this issue is fully resolved?

### 9. Open Questions
Remaining uncertainties to be resolved during implementation.

---

## Story Sizing Rules

**Right-sized (one iteration each):**
- Add a database column and migration
- Add a UI component to an existing page
- Update a server action with new logic
- Add a filter dropdown to a list
- Write a new API endpoint

**Too big (must split):**
- "Build the entire dashboard" → Split into: schema, queries, UI components, filters
- "Add authentication" → Split into: schema, middleware, login UI, session handling
- "Refactor the API" → Split into one story per endpoint or pattern

**Rule of thumb:** If you cannot describe the change in 2-3 sentences, it is too big.

---

## Story Ordering

Stories must be ordered so earlier stories never depend on later ones:

1. Schema/database changes (migrations first)
2. Server actions / backend logic / API endpoints
3. UI components that consume the backend
4. Dashboard/summary views that aggregate data

---

## Output

Save the PRD to `issues/{ISSUE_NUMBER}/prd.md`.

Create the directory if it doesn't exist: `mkdir -p issues/{ISSUE_NUMBER}`

---

## Checklist Before Saving

- [ ] Asked clarifying questions if the issue was ambiguous
- [ ] User stories are small and independently completable
- [ ] Stories are ordered by dependency (no story depends on a later one)
- [ ] All acceptance criteria are verifiable (not vague)
- [ ] UI stories include browser verification criterion
- [ ] Non-goals section is present
- [ ] Saved to `issues/{ISSUE_NUMBER}/prd.md`
