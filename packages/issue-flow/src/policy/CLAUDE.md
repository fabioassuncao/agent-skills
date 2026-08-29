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

## No consumers yet

Issue #56 delivers the foundation and `issue-flow policy` alone. No prompt, no
skill and no phase reads `loadRepositoryPolicy()` — which is what makes the
change fully additive, with no observable behaviour altered.

`issue-flow policy --json` is the bridge for the Agent Skills: they are markdown
and cannot import TypeScript, so a versioned JSON document on stdout is the only
interface available to them. `schemaVersion` therefore belongs to the payload,
not to the CLI, and is bumped only when a reader would have to change.
