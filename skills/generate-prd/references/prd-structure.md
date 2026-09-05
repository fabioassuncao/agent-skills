# PRD structure

The Product Requirements Document is what the task plan is derived from. Its
job is to make every unit of work small, ordered and verifiable.

Path: `issues/{ISSUE_NUMBER}/prd.md`.

## Sections

### 1. Context

Why this change is needed. Derived from the issue: what is being built and what
problem it solves.

### 2. Goals

Specific, measurable objectives, as a bullet list. Derived from the issue's
stated goals and acceptance criteria.

### 3. User Stories

Each story must be:

- **small enough to implement in one focused session** (one context window);
- **independently verifiable**;
- **ordered by dependency** — database, then backend, then UI.

```markdown
### US-001: [Title]

**Description:** As a [user], I want [feature] so that [benefit].

**Acceptance Criteria:**
- [ ] Specific, verifiable criterion
- [ ] Another criterion
- [ ] Typecheck passes
- [ ] **[UI stories only]** Verify in the browser with whatever browser automation
      this environment offers (a Playwright CLI, an MCP browser tool, or a browser
      skill); if none is available, say so instead of claiming verification
```

Acceptance criteria must be verifiable, never vague:

- ❌ "Works correctly", "Good UX", "Handles edge cases"
- ✅ "Clicking delete shows a confirmation dialog", "Button is disabled while
  loading", "Returns 404 when the resource does not exist"

The project’s applicable quality check is the last criterion of a story that
changes code. Use `Typecheck passes` only when a typechecker actually exists.

### 4. Functional Requirements

A numbered list — `FR-1: The system must…`, `FR-2: When a user does X, the
system must…`. Explicit and unambiguous: a junior developer or an agent will
read this and nothing else.

### 5. Out of Scope

What this issue will **not** include. This is the section that prevents scope
creep, so write it even when it feels obvious.

### 6. Technical Approach *(optional)*

Constraints, integration points, performance requirements, breaking changes,
existing components to reuse.

### 7. Design Considerations *(optional)*

UI/UX requirements, mockups.

### 8. Success Metrics

How anyone will know the issue is fully resolved.

### 9. Open Questions

Uncertainties left to resolve during implementation. An empty section is a
claim; write "None." deliberately rather than deleting it.

## Story sizing

**Right-sized — one iteration each:**

- add a database column and its migration
- add a UI component to an existing page
- update a server action with new logic
- add a filter dropdown to a list
- write one API endpoint

**Too big — must be split:**

- "Build the entire dashboard" → schema, queries, UI components, filters
- "Add authentication" → schema, middleware, login UI, session handling
- "Refactor the API" → one story per endpoint or per pattern

**Rule of thumb:** if you cannot describe the change in 2-3 sentences, it is too
big.

## Story ordering

Order so that no story depends on a later one:

1. schema and database changes — migrations first
2. server actions, backend logic, API endpoints
3. UI components consuming that backend
4. dashboards and summary views that aggregate the rest

## Before saving

- [ ] ambiguities in the issue were asked about, not guessed
- [ ] stories are small and independently completable
- [ ] no story depends on a later one
- [ ] every acceptance criterion is verifiable
- [ ] UI stories carry a browser-verification criterion
- [ ] "Out of Scope" is present and substantive
