# src/policy

## What this layer is for

The consumer repository usually already decided how issues are titled, which
labels exist, what a Pull Request body looks like and what an agent may do. This
module finds those decisions and hands them over as one typed object, so no flow
has to re-invent the discovery.

It is **discovery, not inference**. Every field is something the repository
actually declares. Nothing is derived from prose, guessed from a name, or filled
in with a plausible default — that is what `null` is for, and what the `policy`
key of `.issue-flow.json` is for when a human wants to declare it.

## Silent degradation is the contract, not a nicety

Issue Flow works offline today, and this layer must not change that. Every
discovery is best-effort by construction: an unreadable directory, a missing
`gh`, an unauthenticated one, a network that never answers, a repository that
declares nothing — all produce an empty result, no warning, and no error. A
repository with none of these sources resolves to a policy that is empty, which
is exactly the input every consumer had before this module existed.

The one thing that *is* recorded is why a source could not answer:
`PolicySource.status === 'unavailable'` distinguishes "the repository declares
nothing" from "we could not find out", and without that distinction a wrong
discovery is undebuggable.

Two consequences that are easy to get wrong:

- `discoverBaseBranch()` deliberately does **not** reuse `utils/git.ts`'s
  `getBaseBranch()`, which falls back to `'main'`. A discovery layer that
  invents a value is indistinguishable from one that found it, and `sources`
  would then be lying.
- Nothing absent is recorded. A repository without `CONTRIBUTING.md` would
  otherwise drown `sources` in negative entries and bury the entries that matter.

## The precedence ladder

```
Issue Flow defaults
  < discovered repository policies
  < "policy" key of .issue-flow.json
  < ISSUE_FLOW_POLICY_*
  < CLI flags
```

Applied by `mergeConfigLayers()` (`src/config.ts`), through its `discovered`
layer — no second merge mechanism exists. The three explicit rungs are collapsed
first by `loadPolicyConfig()`, which is why **that function must never
materialize a declaration as `null`**: `mergeConfigLayers` treats only
`undefined` as absent, so a materialized `null` would overrule the value
discovery found. `config.test.ts` pins this.

`policy.enabled: false` returns before a single `stat()` or round-trip: an
escape hatch that still pays for the discovery is not an escape hatch.

## The `gh` budget

At most one `gh` invocation per kind of data, each with a timeout:

| Data | Call |
|---|---|
| Labels | `gh label list --json name,description,color` |
| Issue Types | `gh api orgs/{org}/issue-types` |
| Organization Issue Templates | `gh api graphql` — the `issueTemplates` connection |

The organization templates use **GraphQL, not REST**: REST has no issue-template
endpoint at all (`repos/{o}/{r}/issues/templates` 404s everywhere), and the
GraphQL connection returns the bodies inline, so the organization defaults cost
one round-trip instead of a listing plus one call per template. Owner and
repository travel as GraphQL *variables* — they come from a git remote, which is
user-controlled input, and a query built by string concatenation is a query
someone else can rewrite.

That call only fires when the local tree has no templates: a repository with no
`.github/ISSUE_TEMPLATE/` still serves the organization's on github.com, and
that is precisely the case filesystem discovery cannot see. When the tree does
have templates, asking would spend a round-trip to re-learn what is on disk.

## Documents are followed, not scanned

`AGENTS.md` is an index. Its markdown links are followed **one level**, and only
to in-repository markdown. Scanning `docs/` instead would pull in changelogs,
ADR archives and translated copies — a large context cost for content the
repository never nominated as policy.

Every document is capped at `MAX_POLICY_DOCUMENT_BYTES`, with the truncation
recorded in `sources`. Discovery feeds an agent's context window; an unbounded
`AGENTS.md` costs more than it explains.

## Scope, in a monorepo

`scopeLadder()` composes from the root down to the scope (`''`, `apps`,
`apps/api`), so the more specific document is simply the later one in `docs[]`.
Only the per-directory agent instructions (`AGENTS.md`, `CLAUDE.md`) walk the
ladder — `.github/`, `CONTRIBUTING.md` and `CODEOWNERS` are read once at the
root, because that is where GitHub reads them from.

## The YAML reader

`parsers/issue-forms.ts` reads six top-level keys, not YAML. It works on
indentation-zero key regions and skips everything nested, which is what keeps
`- type: markdown` inside an Issue Form's `body:` from being mistaken for the
top-level `type:` of an Issue Type. Pulling in a YAML engine to read six keys
would trade a supply-chain surface for nothing.

## Cache

One resolution per `(root, scope)` per process. The **promise** is cached, not
its result, so two concurrent callers share a discovery instead of racing two; a
rejection is evicted so it is not served forever. `resetPolicyCache()` exists for
tests and long-lived processes.

## The projection into prompts

`placeholders.ts` turns a resolved policy into the `__REPO_*` placeholders. Two
rules there are load-bearing:

- **`__REPO_DOCS__` carries paths, never content.** The agent has `Read`.
  Embedding `AGENTS.md` would multiply the cost of every run and freeze a copy of
  the repository's own rule inside a prompt, which is the thing this whole layer
  exists to avoid.
- **Over budget, a section is replaced whole, never truncated.** A summary cut
  mid-rule is worse than one that says where the rule lives. Essentials (base
  branch, conventions, Issue Types, templates, labels) keep their slot as a
  pointer; the rest simply drop out. `policy.contextBudget` sets the ceiling.

`resolvePolicyPlaceholders()` is what commands call. It never throws and never
warns: no git checkout, no `gh`, a discovery that fails — all yield the empty
projection and the command behaves exactly as before.

## Byte-identity is the contract

A repository that declares no policy must get a prompt that is **byte for byte**
the one it got before this layer existed. That is why the policy section of each
packaged prompt is wrapped in `<!-- if:__REPO_POLICY__ -->` … `<!-- /if -->` and
stripped by `applyConditionalSections()` (`core/prompt-resolver.ts`) — including
the blank line before it. `core/prompt-override.test.ts` pins this against every
file in `prompts/`, so adding a prompt does not require remembering the rule.

An empty "Repository policy" heading would not just break byte-identity; it
would invite the agent to wonder what was supposed to be there.

## Prompt overrides

`loadPrompt()` resolves `<root>/.issue-flow/prompts/<name>.md` (replacement),
then `<name>.append.md` (appended), then the packaged prompt. `append` is the
recommended form, and the doc comment says why: replacing a whole prompt makes
the repository inherit its maintenance, so every later improvement stops
reaching it, silently.

`loadPrompt` falls back to `getProjectRoot()` when no root is passed, which costs
a `git rev-parse`. Pass `projectRoot` wherever one is already in hand — `engine.ts`
does, from `resolvePaths()`.

## No consumers yet

Issue #56 delivered the foundation and `issue-flow policy`; #57 added the
projection into the prompts and the per-repository override. The Agent Skills
still do not consume any of it — that is #61.

Git conventions (`commitlint`, release-please, semantic-release, Changesets,
`action-semantic-pull-request`, husky) are discovered as text. A `.js`/`.ts`
commitlint file is never `import()`ed. The canonical implementation lives in
`src/conventions/git/` — this layer only *finds* what the repository declared.

`issue-flow policy --json` is the bridge for the Agent Skills: they are markdown
and cannot import TypeScript, so a versioned JSON document on stdout is the only
interface available to them. `schemaVersion` therefore belongs to the payload,
not to the CLI, and is bumped only when a reader would have to change.
