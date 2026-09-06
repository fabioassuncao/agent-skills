# Git conventions

Canonical rules for branches, commits and Pull Requests. CLI, prompts, skills
and the portable `resolve-issue` Skill consume the same implementation in
`packages/issue-flow/src/conventions/git/`. Skills ship bundled helpers generated from those modules; they do not import
the source tree or require the CLI at runtime.

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

The format below is the Issue Flow fallback. Portable Skills first apply an
explicit invocation rule, declared project conventions, or clearly established
project practice. Their `auto`, `project` and `issue-flow` strategies are described
in the [Skill invocation guide](../skills/README.md#configure-an-invocation). The
bundled commit renderer generates this fallback, not arbitrary project formats.

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

### PR description and metadata

The single [PR template](../.github/PULL_REQUEST_TEMPLATE.md) governs the body:
what changed, how it was tested, related issues and notes for reviewers. Keep all
four sections and explain non-applicable sections briefly. Include concrete
before/after behavior and compatibility or migration risks when useful. The
Conventional Commit-style title is this project's convention, not a requirement
of the GitHub platform.

A template does not populate the PR sidebar. For PRs **in this repository**, apply
existing labels automatically when the actual diff supports them:

| Dimension | Existing labels | Selection |
|---|---|---|
| Nature | `bug`, `enhancement`, `refactor` | Behavior corrected, capability added, or code reorganized |
| Area | `architecture`, `backend`, `frontend`, `infra`, `monitoring` | Material architectural, server/CLI, UI, infrastructure, or observability impact |
| Documentation | `documentation` | Documentation is a relevant part of the delivered change |

Labels can coexist. A backend correction can use `bug` and `backend`; a document
that mentions an API does not automatically need `backend`. Architectural work
changes boundaries or responsibilities, not merely many files. Do not classify
by changed-file count or blindly copy issue labels. Use `documentation`, not a
new synonymous `docs` label. Query the live registry before applying labels;
this table does not authorize recreating a deleted label.

Do not infer `high`, `medium`, `low`, `blocked`, size or triage labels from a diff.
Such decisions need an explicit user selection or an applicable PR rule. The
repository's issue-type guidance is about issues; it does not make issue types
into PR fields or forbid useful PR labels such as `bug` and `enhancement`.

Assignees, reviewers, milestone and project membership require explicit values
or a concrete applicable rule. Do not assume the issue author owns the PR, assign
the current account automatically, or invent a reviewer/release. CODEOWNERS may
let GitHub request review; avoid duplicate manual requests. Unspecified fields
may remain empty.

Skills and the CLI share the publication procedure in the
[PR metadata contract](../skills-src/_shared/pr-metadata.md). They read the
consumer project's conventions and vocabulary; the label table above is not a
universal default. Metadata is applied separately from the body and verified on
the created PR. If a field fails, preserve the PR URL and report what is pending;
retry only the missing authorized operation, never create another PR. Plain
adoption of an existing PR does not reclassify it. Explicit updates preserve
manual metadata unless removal/replacement was requested. No bulk migration of
older PRs is part of this workflow.

GitHub documents [PR templates](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository),
[repository labels](https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/managing-labels)
and [separate metadata options in gh pr create](https://cli.github.com/manual/gh_pr_create).

## Discovery

`commitlint`, `release-please`, `semantic-release`, Changesets,
`amannn/action-semantic-pull-request` and `.husky/commit-msg` are discovered
and recorded in `issue-flow policy --json`. JavaScript commitlint configs are
read as text and never executed. A value declared in `.issue-flow.json` wins
over discovery; discovery wins over the default.
