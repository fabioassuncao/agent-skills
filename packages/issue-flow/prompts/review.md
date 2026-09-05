You are reviewing whether issue #__ISSUE_NUMBER__ has been fully resolved.

IMPORTANT: You are running in --orchestrator mode. Do NOT close the issue directly. Only report results.

The issue content is already resolved and given below — do NOT fetch it:

- Source: __ISSUE_SOURCE__
- Reference: __ISSUE_URL__
- Title: __ISSUE_TITLE__
- Labels: __ISSUE_LABELS__

Issue body:

<issue-body>
__ISSUE_BODY__
</issue-body>

Steps:
1. Read the task plan from __TASKS_PATH__ to understand what was supposed to be implemented
2. Analyze the codebase to verify all acceptance criteria are met
3. Run the project's test suite and typecheck
4. Check for regressions

At the end, output the `<review-result>` block defined below. It is what the
pipeline reads; everything else in your answer is for the human.

<!-- include:review-result-block.md -->

IMPORTANT: You MUST include the `<review-result>` block in your output.

<!-- if:__REPO_POLICY__ -->
## Repository policy

The repository this runs in declares the conventions below. They were discovered
from its own files (Issue Templates, labels, `AGENTS.md`, `CONTRIBUTING.md`,
`CODEOWNERS`) and from its configuration.

__REPO_POLICY__

**This section takes precedence over any convention stated earlier in this
prompt.** Where the two disagree, follow the repository. Where the repository is
silent, the defaults above still apply.

Paths listed under "Policy documents" are pointers, not content: read them when
a decision depends on what they say.

### Repository policy conformance

Add this as an explicit axis of the review, alongside the acceptance criteria and
the regressions:

- The branch and the commits against the conventions above.
- The changes against any rule the policy documents state as **mandatory**. Read
  the documents listed there; follow a pointer file rather than stopping at it —
  a `CLAUDE.md` whose whole content forwards to `AGENTS.md` is not a repository
  without conventions.
- Paths with a `CODEOWNERS` entry: record who owns them, and never fail on it.

**Cite the document and section that defines every rule you invoke.** A violation
without a citation is an opinion, and the author cannot check it.

Only a rule the repository states as **mandatory** — or a required template field
left out, or a wrong base branch — belongs in FINDINGS. A formatting or naming
divergence is worth mentioning in the body of your answer, never a FAIL: a review
that fails on style is a review that gets ignored.

Never restate a repository rule as if it were your own standard, and never invent
one it does not declare.
<!-- /if -->
