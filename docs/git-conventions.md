# Git conventions

Canonical rules for branches, commits and Pull Requests. CLI, prompts, skills
and the `resolve-issue` agent all consume the same implementation in
`packages/issue-flow/src/conventions/git/`. They do not reimplement slugify or
invent a type.

See also [`docs/conventions.md`](conventions.md) for how conventions are
discovered, and `issue-flow conventions` / `issue-flow policy --json` for the
machine-readable surface.

## Independence of provider

Branch, commit and Pull Request title are a function of the issue and the
repository convention. They do not depend on which agent ran the phase.
`src/conventions/git/` accepts no provider, agent or model. A name such as
`claude`, `codex` or `cursor` may appear in a **subject** (`feat(agents): add
Cursor CLI runner`) because that is the topic of the change. It must never
appear as the **type** or the **scope** because that would record the executor.

Provider, model, duration, retries and cost live in `session.json` and in the
execution header. They do not enter a branch, a commit, a PR title, a PR body,
a tag, a release or the changelog.

## Branches

Default pattern: `{type}/{N}-{slug}`.

| Situation | Result |
|---|---|
| Issue #63, feature | `feat/63-execucao-autonoma-resiliente` |
| Issue #72, bug | `fix/72-timeout-headless` |
| No associated issue | `{type}/{slug}` |
| Empty slug | `{type}/{N}` |

`style` and `revert` are valid commit types and are not used as branch prefixes.

The type is resolved by a five-rung ladder: a declared `policy.git.branchConvention`
(format), native Issue Type, labels (`policy.git.typeMap` overlays the default
map), a title prefix such as `[Bug]`, then `feat` marked as `fallback`.

`issue/{N}-*` remains recognised when extracting a number, so existing branches
are not renamed and a resumed run keeps `tasks.json.branchName`.

```bash
issue-flow conventions branch --issue 63
```

## Commits

```text
<type>(<scope>)[!]: <subject>

Refs #N
Story: US-010
```

- Vocabulary: `feat` `fix` `docs` `refactor` `perf` `test` `build` `ci` `chore` `style` `revert`
- One commit, one type. Footers use `Refs`, never `Closes`.
- `commit.signoff` in `~/.issue-flow/config.json` adds `Signed-off-by:`.

```bash
issue-flow conventions commit --type fix --scope runner --subject "recover created PR"
```

## Pull Requests

Title: `<type>(<scope>): <subject>` — so a GitHub squash-merge is a Conventional
Commit. A consolidated PR takes the highest-impact type (`feat` > `fix` > rest)
and drops the scope when the set is mixed.

Reference lines are deterministic:

| Condition | Line |
|---|---|
| Every story `passes: true` and `lastReviewFindings === null` | `Closes #N` |
| Partial delivery | `Refs #N` |
| Container whose children all closed | `Closes #N` |
| Container with pending children | `Refs #N` |

A repository `PULL_REQUEST_TEMPLATE` still governs the body.

```bash
issue-flow conventions pr-title --issue 63
```

## Discovery

`commitlint`, `release-please`, `semantic-release`, Changesets,
`amannn/action-semantic-pull-request` and `.husky/commit-msg` are discovered
and recorded in `issue-flow policy --json`. JavaScript commitlint configs are
read as text and never executed. A value declared in `.issue-flow.json` wins
over discovery; discovery wins over the default.
