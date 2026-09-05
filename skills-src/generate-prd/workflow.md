# Generate requirements

Read issue-input and repository-policy. Accept issue content or an existing analysis; fetch missing context only as needed. Do not require analyze-issue to be installed. Resolve material scope questions before freezing acceptance criteria.

Write the requested PRD path, default issues/<id>/prd.md. Include overview/context, goals, user stories, functional requirements, technical constraints, out of scope, dependencies/risks and open questions when applicable. Each story has a stable US-NNN identifier, description and concrete acceptance criteria. Read plan-format before allocating IDs that will be shared with a plan.

Order stories by real dependencies. Keep each implementable and verifiable in a focused iteration. Split independently deliverable work; do not split only because a story touches frontend and backend. Acceptance criteria describe observable behavior and the repository's relevant checks. Include browser verification for changed UI when required; no mandatory named browser tool or universal TypeScript check.

Save only the PRD, preserving unrelated artifacts. If updating an existing PRD, retain applicable IDs and completed work, and describe scope changes. Return the path, concise scope, story count and any unresolved decision. Do not implement or automatically invoke another Skill.
