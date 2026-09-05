# Repository policy

Read this when a decision depends on conventions. Paths named below are inputs in the **consumer repository**, not dependencies in the Issue Flow source tree.

1. Locate the working repository and current scope. Read applicable AGENTS.md files from root to the affected directory, then their relevant documentation pointers. Follow CLAUDE.md or other agent entry points when present; a pointer is not an empty policy. Do not create provider-specific instruction files during ordinary work.
2. Read CONTRIBUTING.md, applicable issue forms/templates, PR templates, CODEOWNERS and declared Git conventions. Inspect configuration as text; do not execute arbitrary configuration code. For monorepos, the most specific applicable instruction refines the root policy.
3. Respect explicit user choices. For optional Issue Flow policy configuration use the precedence: discovery < project policy in .issue-flow.json < ISSUE_FLOW_POLICY_* overrides < explicit invocation. If decoding an override is ambiguous, use the optional integration or ask about that decision; do not invent its meaning. policy.enabled=false disables enrichment/discovery, not the agent's obligation to follow user and repository instructions.
4. For GitHub work, obtain actual labels and organization Issue Types with available authenticated capabilities. With gh, use label list --limit 200 --json name and api orgs/{org}/issue-types. If local templates are absent, inspect organization defaults through GitHub's issueTemplates GraphQL connection. A failed lookup means unavailable, not a confirmed empty registry. Do not manufacture governance to compensate.
5. Resolve base branch from explicit choice/configuration, then the remote default (origin/HEAD or repository metadata). Use an existing plan's base only when consistent. If still unknown, ask before branching or calculating the PR diff. The existence of main does not prove it is the base.

Use the repository's applicable issue template instead of layering another body template over it. Fill required fields; ask when two templates fit equally. Keep the PR template's sections, explaining non-applicable ones briefly.

Use existing label casing. Never create a label unless explicitly opted in by issues.allowLabelCreation and the action is authorized. Drop labels known to be absent; report lost classification. When the registry is unavailable, report that validation could not be performed rather than claiming the label does not exist. Local metadata labels are free-form and should reuse the local vocabulary.

Prefer native fields over labels and textual prefixes. Do not reintroduce a type prefix when the repository uses native Issue Types unless its declared title convention requires it. Defaults apply only to undeclared choices; obtain the fallback taxonomy from the bundled conventions helper where supplied.

Cite document and section behind policy findings. Mandatory requirements, missing required fields and a wrong base may block; naming preferences alone are observations. CODEOWNERS informs review ownership, not a simulated approval gate.

Optional CLI enrichment is described in the Skill's CLI integration reference. Its absence never prevents direct discovery. No network is necessary for local-only work; retrieving or publishing remote GitHub data does require remote access.
