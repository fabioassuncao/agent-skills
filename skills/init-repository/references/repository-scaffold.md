# The baseline this skill proposes

Two rules shaped every default below.

**Native structure before textual convention.** The order of preference is
native feature > structured field > label > free text. Anything the forge
already models is not re-implemented as a title prefix or a label, because that
creates a second truth that ages on its own.

**Do not fragment the backlog.** A type per flavour of work makes no query
better and every filter worse.

## Files, and why each exists

| File | Tier | Responsibility |
|---|---|---|
| `.github/ISSUE_TEMPLATE/*.yml` | required | One Issue Form per type. Structure is what makes an issue actionable by an agent |
| `.github/ISSUE_TEMPLATE/config.yml` | required | The chooser. Keeps blank issues **enabled** — a closed chooser turns a report into silence |
| `.github/PULL_REQUEST_TEMPLATE.md` | required | Gives review a body it can rely on |
| `AGENTS.md` | required | The canonical agent entry point, as an *index* |
| `CLAUDE.md` | recommended | The one-line bridge to `AGENTS.md` |
| `docs/conventions.md` | recommended | The source of truth the other files reference |
| `.github/labels.json` | contextual | Proposed only when the repository has no labels at all |

Nothing is created to fill out a structure. A repository whose
`CONTRIBUTING.md` and Issue Templates already document how it works does not get
a competing conventions document.

## Six issue types

| Type | What it is | Authorises implementation? |
|---|---|---|
| **Idea** | A hypothesis, opportunity or perceived problem, not yet analysed | **No** |
| **Research** | An investigation that produces knowledge | **No** |
| **Epic** | An umbrella objective delivered through sub-issues | **No** |
| **Feature** | A new capability, or a change to what the product does | Yes, once ready |
| **Bug** | Existing behaviour diverging from what is expected | Yes, once ready |
| **Task** | Concrete work that is neither a feature nor a bug | Yes, once ready |

`Bug`, `Feature` and `Task` are GitHub's own defaults, so they exist in every
organization. The other three answer a question those cannot: *is this worth
doing*, *what is the answer*, and *what is the umbrella*.

**An open issue is not approved work.** `Idea`, `Research` and `Epic` record
intent; they never authorise an agent to start implementing.

### Deliberately not types

| Concept | Represent it as | Why |
|---|---|---|
| Documentation | `Task` + label `docs` | The work is a task; what varies is the area |
| Maintenance, chore | `Task` | That is already what `Task` means |
| Refactor, technical debt | `Task` + label `tech-debt` | A cross-cutting characteristic, not a nature |
| Security | the real type + label `security` | It cuts across every type |
| Spike, investigation | `Research` | The same concept under another name |
| Enhancement | `Feature` | A change to what the product does is a feature |
| Proposal, RFC | `Research`, plus an ADR for the decision | The decision belongs in a document that outlives the issue |
| Question | a Discussion, or `Research` | A question needing no work is not a backlog item |

## Labels

A small vocabulary, for what has no native representation — area, component,
cross-cutting characteristic:

```text
api  backend  frontend  database  infra  docs  security  tech-debt  blocked
good first issue
```

There is deliberately **no** `priority`, `status`, `type` or size label: GitHub
models all four. The one exception is `type:*`, proposed only for an
organization with no Issue Types at all.

## Agent entry points

```text
CLAUDE.md  →  AGENTS.md  →  specialised documentation  →  single source of truth
```

- **`AGENTS.md`** is the canonical entry point, for any agent of any vendor. It
  is an *index*: it names the documents to read and holds no rule of its own.
- **`CLAUDE.md`** exists only as the Claude Code bridge and holds one line:
  `Read and follow the instructions in AGENTS.md.` The same applies to any other
  tool-specific adapter — a pointer, never a second copy.
- **The documentation** is where the rules live.

Do not put commands, code style, architecture rules or testing strategy into
`AGENTS.md`. If it is a rule, a standard, or reusable knowledge, it belongs in
its own document that `AGENTS.md` points at. Instructions duplicated in an agent
file age out of sight and start contradicting their source without anyone
noticing.

## The three verdicts

| Verdict | Meaning |
|---|---|
| `create` | Missing, and the repository has no equivalent |
| `keep` | Something equivalent exists — left untouched |
| `review` | Present but inconsistent; reported, never rewritten |

## Behaviour by repository state

| State | What happens |
|---|---|
| No conventions at all | The full baseline is proposed |
| Some templates | Only the gaps are filled; existing files are kept |
| Complete conventions | Nothing to create; the report says what was recognised |
| Conventions differing from these defaults | Preserved. The defaults never apply |
| Templates served by the organization | Kept there; no local copy is made |
| `AGENTS.md` already present | Kept; only `CLAUDE.md` may be added |
| Only `CLAUDE.md`, carrying instructions | `review`. Promoting it moves text a person wrote, and is never automatic |
| Both, both carrying instructions | `review`, naming the duplication |
| No Issue Types in the organization | Reported. They are an organization setting; `type:*` labels are only a fallback |
