# Git conventions

Canonical rules for branches, commits and Pull Requests. CLI, prompts, skills
and the portable `resolve-issue` Skill consume the same implementation in
`packages/issue-flow/src/conventions/git/`. Skills ship bundled helpers generated from those modules; they do not import
the source tree or require the CLI at runtime.

See also [`docs/conventions.md`](conventions.md) for how conventions are
discovered, and `issue-flow conventions` / `issue-flow policy --json` for the
machine-readable surface.

## Strong defaults, minimal policy

Everything below is what Issue Flow does when the repository has decided
nothing. **The moment the repository declares its own rule, Issue Flow yields
the whole decision** — it does not overlay or merge it. A rule the repository
wrote down is `declared` and turns the fallback off; a pattern read out of
history is `inferred`, reported and nothing more.

Four rules never yield, because each is a guarantee rather than a preference:
provider independence, `Refs` instead of `Closes` on a commit, `Closes` versus
`Refs` in a PR as a function of the verification state, and the ban on inferring
priority or triage labels from a diff.

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

The type comes from two rungs: a type the repository declares — directly, or
through the label map (`policy.git.typeMap` overlays the default one) — and
otherwise `feat`, marked as `fallback`. Inferring it from an Issue Type name or
a `[Bug]` title prefix gave a confident answer nobody could check and changed
nothing downstream; both rungs and their tables are gone.

Work with no issue takes one of two other paths: a free description with a
generator configured produces a flat kebab-case name of at most 40 characters
and **no prefix**; anything else produces `change-<uuid8>`. Without a configured
generator — the default — no model is ever called to name a branch.

`issue/{N}-*` remains recognised when extracting a number, so existing branches
are not renamed and a resumed run keeps `tasks.json.branchName`.

```bash
issue-flow conventions branch --issue 63
```

## Commits

`commit.format` picks between two. **`conventional`** (the default) renders the
message below and wraps the body at 72 columns. **`free`** leaves subject and
body exactly as written, which is what a repository shipping a `.gitmessage` or
declaring its own format gets.

```text
<type>(<scope>)[!]: <subject>

Refs #N
```

- Default vocabulary: `feat` `fix` `docs` `refactor` `perf` `test` `build` `ci` `chore` `style` `revert`
- A repository declaring its own types replaces that list; one declaring a
  convention without enumerating types gets `types: 'any'`, so a legitimate type
  of its own is never rejected.
- One commit, one type. Footers use `Refs`, never `Closes`, in both formats.
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

```bash
issue-flow conventions pr-title --issue 63
```

### PR description and metadata

The repository's `PULL_REQUEST_TEMPLATE` governs the body — fill in the sections
it actually has. With no template, say what changed and how it was tested.
Apply existing labels the diff genuinely supports, querying the live registry
first; never create one to fit, and never infer `high`, `medium`, `low`,
`blocked`, size or triage labels from a diff.

Assignees, reviewers, milestone and project membership need explicit values or a
concrete applicable rule; unspecified fields may stay empty. The publication
procedure Skills and the CLI share — how metadata is applied and verified, and
what to do when one field fails — is the
[PR metadata contract](../skills-src/_shared/pr-metadata.md).

GitHub documents [PR templates](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository),
[repository labels](https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/managing-labels)
and [separate metadata options in gh pr create](https://cli.github.com/manual/gh_pr_create).

## Discovery

Declared sources: `commitlint` (config file or `package.json`), `release-please`,
`semantic-release`, Changesets, `amannn/action-semantic-pull-request`, a CI job
running `commitlint`, `.husky/commit-msg`, and the repository's
`commit.template` (`.gitmessage`, or wherever `git config commit.template`
points). Inferred sources: recent commit subjects and existing branch names.

All are recorded in `issue-flow policy --json` with their status. JavaScript
commitlint configs are read as text and never executed. A value declared in
`.issue-flow.json` wins over discovery; discovery wins over the default.
