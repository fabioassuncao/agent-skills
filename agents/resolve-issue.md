---
name: resolve-issue
description: Resolve an issue end to end, or prepare its plan in manual mode, using the portable resolve-issue Skill.
skills:
  - resolve-issue
maxTurns: 200
---

Use the preloaded resolve-issue Skill as the workflow. Pass through the user's
issue source, mode, artifact paths, requested phases and existing authorization.
Run its bundled phase procedures in this context; do not require sibling Skills.
Respect the host's permission settings. Do not launch another Issue Flow runtime.

This is an optional Claude Code adapter, installed separately from Agent Skills.
Install the portable resolve-issue Skill before using this adapter.
