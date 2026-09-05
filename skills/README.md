# Agent Skills — sources

This directory holds the **sources** of the ten Issue Flow
[Agent Skills](https://agentskills.io). It is not what you install.

A skill only works when it is self-contained — every client copies or scans the
directory holding its `SKILL.md` and nothing above it. But a handful of
contracts are cited by more than one skill, and duplicating them here would mean
maintaining the same text in several places. So they live once, in
`_shared/contracts/`, and the tree users install is **assembled**:

```bash
npx skills add fabioassuncao/issue-flow#skills
npx skills add fabioassuncao/issue-flow#skills@create-pr   # just one
```

> **The `#skills` part is required.** Without it the installer reads the default
> branch — this one — where the shared contracts have not been materialised yet,
> and the skills install with references that point at files that are not there.

## Layout

```text
_shared/contracts/     cited by two or more skills; materialised at build time
<skill>/SKILL.md       hand-written, always
<skill>/references/    the skill's own references, hand-written
<skill>/scripts/       executable helpers, when a step is better as code
```

## Working here

```bash
just check     # validate the skills as they are here
just verify    # assemble the publishable tree and validate it strictly
```

Rules, the full catalogue and the compatibility matrix:
[`docs/skills.md`](../docs/skills.md). Invariants for anyone editing:
[`AGENTS.md`](AGENTS.md).
