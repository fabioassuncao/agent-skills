# CLI configuration

[CLI guide](cli.md) · [Project overview](../README.md)

The Issue Flow CLI resolves configuration through the layers below. Nothing is mandatory: with no
configuration at all, every default reproduces the behaviour of a plain
`issue-flow run 42` against a GitHub issue on Claude Code.

These settings configure the CLI runtime. Agent Skills use their current host's
configuration and repository instructions; they do not require `.issue-flow.json`
or a global CLI configuration. Their portable artifact helper does honor
`ISSUE_FLOW_HOME`, so CLI and Skills resolve the same default store. See
[optional CLI enrichment](../skills/README.md#optional-cli-enrichment).

- [The precedence ladder](#the-precedence-ladder)
- [`.issue-flow.json`](#issue-flowjson) — per project
- [`~/.issue-flow/config.json`](#issue-flowconfigjson) — per machine
- [Custom agents](#custom-agents) — terminal command templates layered by id
- [Environment variables](#environment-variables)
- [Per-repository prompt overrides](#per-repository-prompt-overrides)

## The precedence ladder

Settings resolve from the highest-priority source that provides them:

| Priority | Source | Example |
|----------|--------|---------|
| 1 (highest) | CLI flag | `--port 4000` |
| 2 | Environment variable | `ISSUE_FLOW_WEB_PORT=4000` |
| 3 | `.issue-flow.json` in the project root | `{ "web": { "port": 4000 } }` |
| 4 | `~/.issue-flow/config.json` | `{ "web": { "port": 4000 } }` |
| 5 (lowest) | Built-in default | `3737` |

Only declared keys participate in merging. An absent setting does not erase a
value from another layer. Do not assume nested objects merge recursively; the
domain-specific rules below describe the exceptions.

These domains have specific precedence or merge behavior:

- **`resilience`** climbs all five rungs and merges `retry` one level deeper —
  per failure kind *and* per field, because that table is two levels deep by
  construction.
- **`agent`** climbs all five rungs and merges `phases`, `claude` and `codex`
  key by key, so a project's `phases.plan` does not erase a global
  `phases.execute`.
- **`agents`** is a registry of custom terminal agents, layered by id as
  global → project. A project entry replaces the same global id; `null` masks
  it. There is no environment or CLI rung for command templates.
- **`linear`**, **`github`** and **`autoName`** are project integration policy.
  They do not read the global file. Linear and GitHub accept the environment
  overrides documented below; `autoName` is project-only.
- **`routing`** has no environment rung, but merges `escalation` and `ceilings`
  one level deeper: defaults < global < project < CLI.
- **`policy`** replaces the "machine" rung with *what the repository declares
  about itself*: defaults < discovered conventions < `.issue-flow.json` <
  `ISSUE_FLOW_POLICY_*` < CLI. See [Conventions](conventions.md).
- **`web`** does not read the global file. See the actual layers in
  [monitor configuration](web-monitor.md#configuration).

A missing file is silent — it is the common case. Invalid JSON, a non-object
root, an unreadable path or an invalid key each degrade to "no preference" with
a warning, **key by key**: a typo under `retry` costs you `retry` only, never
your `web` settings. Unknown keys are dropped without a warning, which is what
keeps a file written by a newer release readable by an older one.

For agent selection, the web monitor captures the resolved provider/model and
the winning source at session start. Its configuration card presents the ladder
as **built-in default → global user → project → environment → CLI → phase/step
override**, with the effective value highlighted. A loopback-bound monitor can
save global provider/model preferences per phase and routing preferences for
future runs; project, environment, CLI and phase overrides remain visible and
continue to win according to the table above. An active session is never
reconfigured retroactively.

## `.issue-flow.json`

Optional, at the project root. Every key is independent:

```json
{
  "web":        { "enabled": true, "port": 3737, "host": "127.0.0.1" },
  "issues":     { "preferredProvider": "github", "conflictPolicy": "ask" },
  "prReview":   { "publisher": "local" },
  "github":     { "linkedRepos": [{ "repo": "acme/api", "alias": "api" }], "autoRemoveOnMerge": false },
  "linear":     { "enabled": true, "autoCreateWorktrees": false, "watchTeams": ["ENG"] },
  "autoName":   { "maxLength": 60, "timeoutMs": 15000 },
  "runtime":    { "profile": "default", "profiles": { "default": { "runtime": "host" } } },
  "agent":      { "provider": "claude", "phases": { "plan": { "provider": "codex" } } },
  "agents":     { "gemini-cli": { "label": "Gemini CLI", "startCommand": "gemini ${PROMPT}" } },
  "verify":     { "level": "L1", "contract": [{ "id": "test", "run": "npm test", "fatal": true }] },
  "routing":    { "mode": "shadow", "profile": "balanced" },
  "resilience": { "profile": "continuous", "journal": { "enabled": true } },
  "telemetry":  { "enabled": true, "maxExecutions": 500 },
  "policy":     { "pullRequests": { "baseBranch": "develop" } }
}
```

### `web`

| Key | Values | Default |
|-----|--------|---------|
| `enabled` | boolean | `false` |
| `port` | 1–65535 | `3737` |
| `host` | string | `0.0.0.0` — reachable from your LAN/VPN. Use `127.0.0.1` to restrict it |
| `refreshSeconds` | number > 0 | `5` |
| `logLimit` | integer > 0 | `200` |
| `includeLogs` | boolean | `true` |

See [Web monitoring](web-monitor.md).

### `issues`

| Key | Values | Default | Meaning |
|-----|--------|---------|---------|
| `defaultGenerateTarget` | `github` \| `local` \| `both` | `github` | Where `generate` creates the issue with no destination flag |
| `preferredProvider` | `github` \| `local` | `github` | Which origin wins when both have the issue |
| `conflictPolicy` | `ask` \| `prefer-local` \| `prefer-github` | `ask` | What to do on divergence |
| `requireConfirmation` | boolean | `true` | Reserved for confirmation prompts; validated but not consumed yet |

See [Issue sources](issues.md).

A third origin, **`inline`**, is registered automatically and needs no
configuration: it holds the demands typed straight into
[`issue-flow run --prompt`](commands.md#a-demand-with-no-issue). It answers only
for its own `inline-<12 hex>` identifiers, so it never competes with `github` or
`local` for one, and it is therefore never a party to `conflictPolicy`.

### `run`

| Key | Values | Default | Meaning |
|-----|--------|---------|---------|
| `autoClose` | boolean | `false` | Whether a finished run closes the agent sessions it left open |

Off by default, because `run` has always left its sessions in place. `--auto-close`
turns it on for one invocation and `--keep-open` revokes a configured default.
Sessions are marked `stopped`; nothing is deleted, and no branch or worktree is
touched. A run a person took over (`human_hold`) is never closed automatically —
see [closing what a run left open](commands.md#closing-what-a-run-left-open).

### `prReview`

| Key | Values | Default |
|-----|--------|---------|
| `publisher` | `local` \| `github` | `local` |

`local` writes the `.md` report and `index.json` under the issue's `pr-review/`
directory. `github` does all of that **and** posts the report as a Pull Request
comment — it composes rather than replaces. Each round's comment carries an
invisible marker (`<!-- issue-flow:review:<round> -->`), so republishing a round
(a retried phase, a re-run after a correction, a resume) **updates** that comment
instead of stacking another copy. A later round is a different statement and gets
its own comment. An unknown value degrades to `local` with a warning.

### `github`

```json
{
  "github": {
    "linkedRepos": [{ "repo": "acme/api", "alias": "api", "dir": "../api" }],
    "syncIntervalMs": 10000,
    "autoRemoveOnMerge": false
  }
}
```

| Key | Values | Default |
|-----|--------|---------|
| `linkedRepos` | List of `{ repo, alias, dir? }` | `[]` |
| `syncIntervalMs` | Integer ≥ 1000 | `10000` |
| `autoRemoveOnMerge` | boolean | `false` |

`linkedRepos` declares sibling repositories whose Pull Requests belong to the
same unit of work: `repo` is the `owner/name` slug, `alias` is the short label
shown next to a Pull Request coming from it, and `dir` is an optional local
checkout. Declaring none — the default — queries only the repository the command
runs in.

`syncIntervalMs` is how often the Pull Request / CI view refreshes. The refresh
is **activity-gated**: with nothing watching it makes no `gh` call at all, and
the calls it does make are conditional requests, so an unchanged Pull Request
costs no GitHub rate limit.

`autoRemoveOnMerge` enables the headless maintenance pass run by
`issue-flow serve`. A candidate is removed only when every known Pull Request
for its branch is merged, the current repository proves the merged head is the
worktree's current commit, the tree is clean, and the binding still has the
same path/id under the shared mutation lock. A failed or partial GitHub read is
inconclusive and removes nothing. The dashboard can persist this toggle only on
loopback; `ISSUE_FLOW_GITHUB_AUTO_REMOVE_ON_MERGE` pins it and takes precedence.

### `linear`

```json
{
  "linear": {
    "enabled": true,
    "autoCreateWorktrees": false,
    "watchTeams": ["ENG", "WEB"]
  }
}
```

| Key | Values | Default |
|-----|--------|---------|
| `enabled` | boolean | `true` |
| `autoCreateWorktrees` | boolean | `false` |
| `watchTeams` | Team keys, for example `["ENG"]` | `[]` (all teams) |

`autoCreateWorktrees` is a headless `serve` loop, not a browser poll. Once per
60 seconds it considers assigned, unstarted tickets carrying the `issue-flow`
label, optionally restricted by `watchTeams`, and opens each eligible branch
through the same managed-worktree/session operation used by the web routes.
Existing branches in git suppress duplicate pickup even when Issue Flow did not
create them.

`LINEAR_API_KEY` is the only credential source. It is read from the process
environment directly by the Linear client and is never written to either JSON
configuration file, argv, logs or telemetry. `ISSUE_FLOW_LINEAR_ENABLED`,
`ISSUE_FLOW_LINEAR_AUTO_CREATE` and `ISSUE_FLOW_LINEAR_WATCH_TEAMS` override
only the non-secret policy. An environment-pinned auto-create value makes the
dashboard toggle read-only.

The dashboard can list assigned tickets, show the Linear panel/badge/detail,
and post a Claude or Codex conversation to an existing ticket or a new ticket
in a selected team. The durable payload is the canonical versioned Issue Flow
conversation attachment; the summary comment is best-effort. Attachment upload
accepts only HTTPS signed URLs on Google Storage, rejects redirects,
credentials and unsafe headers, and redacts credential-shaped data from Linear
responses and errors. Tests use injected HTTP doubles; this repository does not
claim a live Linear-account acceptance run.

### `autoName`

`autoName` enables the provider-neutral branch naming policy already owned by
`src/conventions/git/auto-name.ts` when an explicit worktree request provides a
prompt but no branch:

```json
{
  "autoName": {
    "maxLength": 60,
    "timeoutMs": 15000,
    "systemPrompt": "Return only a concise kebab-case branch name."
  }
}
```

The value may also be `true` (canonical defaults) or `false`/absent (disabled).
The read-only `GET /api/project/auto-name` exposes the same resolved constants
that creation consumes; there is no second naming implementation in the web
layer and no global/environment rung.

### `runtime`

Profiles, panes and services — how an *interactive* or *sandbox* run opens a
worktree. It changes nothing for `headless`, which is the default and never
depends on tmux, docker or a worktree.

```json
{
  "runtime": {
    "profile": "default",
    "profiles": {
      "default": {
        "runtime": "host",
        "panes": [
          { "id": "agent", "kind": "agent", "focus": true },
          { "id": "shell", "kind": "shell", "split": "right", "sizePct": 25 }
        ]
      },
      "sandbox": {
        "image": "issue-flow-sandbox",
        "permission": "autonomous",
        "envPassthrough": ["GITHUB_TOKEN"],
        "mounts": [{ "hostPath": "/data", "guestPath": "/mnt/data", "writable": true }],
        "panes": [
          { "id": "agent", "kind": "agent", "focus": true },
          { "id": "app", "kind": "command", "cwd": "worktree", "workingDir": "web", "command": "npm run dev" }
        ]
      }
    },
    "services": [
      { "name": "frontend", "portEnv": "FRONTEND_PORT", "portStart": 3000, "portStep": 10,
        "urlTemplate": "http://localhost:${FRONTEND_PORT}" }
    ],
    "startupEnv": { "FEATURE_FLAG": true },
    "maxConcurrent": 1
  }
}
```

| Key | Values | Default |
|-----|--------|---------|
| `profile` | Name of a declared profile | `default` |
| `profiles` | Map of name → profile | one `default` profile |
| `services` | List of service declarations | `[]` |
| `startupEnv` | Map of name → string, number or boolean | `{}` |
| `maxConcurrent` | Integer 1–20 | `1` |

**`maxConcurrent`** is how many execution units may run at once in a project.
The default of `1` is not a placeholder: it is the serial queue behind a
project-wide `run.lock` that this project has always had, and it stays the
default so that nothing becomes parallel by upgrading.

Above `1`, the lock moves from the project to the execution **unit** — an issue,
or a story — and a ceiling replaces the exclusion. Two runs of the *same* unit
still can never both start; that guarantee is exact. The ceiling itself is a
throttle: two processes starting in the same instant can both see room and
transiently make it one over, because making it exact would require serialising
the very thing it exists to parallelise.

It only means anything where a run has a worktree of its own. Parallelism is a
consequence of that isolation, not a feature beside it, so `headless` — which
runs on a branch in the repository — keeps the project lock whatever this says.

**Profile keys**

| Key | Values | Default |
|-----|--------|---------|
| `runtime` | `host` \| `docker` | `host`, except for a profile *named* `sandbox`, which defaults to `docker` |
| `image` | Container image | — (required by `runtime: docker`) |
| `permission` | `read-only` \| `workspace` \| `autonomous` | absent — the phase's own permission is kept |
| `envPassthrough` | List of host variable names forwarded into the runtime | `[]` |
| `systemPrompt` | Text; `${VAR}` is expanded against the worktree's runtime environment | — |
| `mounts` | List of `{ hostPath, guestPath?, writable? }`, `runtime: docker` only | — |
| `security` | Sandbox hardening — see [`sandbox-security.md`](sandbox-security.md) | every default, which is the hardened set |
| `panes` | List of pane templates | agent pane, plus a shell on 25% to its right |

A profile that declares no `permission` **does not** widen what the agent may
do: the phase's permission stands. `yolo: true` is accepted as a synonym for
`permission: "autonomous"` — it is the spelling the absorbed upstream uses — and
`yolo: false` overrides nothing.

A profile that declares no `security` gets the hardened defaults all the same:
`--cap-drop=ALL`, `no-new-privileges`, a process limit, a memory limit and an
explicit network. The object exists for the launches those would otherwise
break — one that genuinely needs the host's SSH agent, or a capability — and
[`sandbox-security.md`](sandbox-security.md) is where each knob and its cost is
described. A `mounts` entry pointing at a container runtime socket
(`docker.sock` and friends) is refused whatever else the profile says.

**Pane keys**

| Key | Values | Default |
|-----|--------|---------|
| `id` | Label for the pane | `pane-<n>` |
| `kind` | `agent` \| `shell` \| `command` | — (required; an unknown kind drops the pane) |
| `split` | `right` \| `bottom` | `right` for every pane after the first |
| `sizePct` | Number | tmux's own split |
| `focus` | boolean | first pane |
| `cwd` | `repo` \| `worktree` | `worktree` |
| `command` | Shell command | — (required by `kind: command`) |
| `workingDir` | Directory relative to `cwd` | the pane's `cwd` |

**Service keys**

| Key | Values | Default |
|-----|--------|---------|
| `name` | Display name | — (required) |
| `portEnv` | Variable carrying the allocated port | — (required) |
| `portStart` | First port of the range | — (a service without one is never allocated a port) |
| `portStep` | Distance between consecutive worktrees | `1` |
| `urlTemplate` | Template with `${VAR}` placeholders | — |

Ports are allocated per worktree from the **first** service that declares a
`portStart`: its lowest free slot is found and `portStart + slot × portStep` is
applied to every service, so one worktree's ports stay aligned across services.
Slot 0 is reserved for the repository itself — the server a person already runs
in the main checkout — so the first worktree gets slot 1.

Health is a TCP probe with a hard 300 ms ceiling, attempted on `127.0.0.1` **and**
`::1` in parallel. Both matter: a server bound to only one of them is invisible
on the other.

Like `web` and `github`, `runtime` does **not** read the global file: a profile
names pane commands and container images that only mean something inside one
repository. A parse is tolerant key by key — an unusable pane, profile or service
is dropped with a warning and the rest of the section still applies.

Agent tabs have no configuration key. For a managed `runtime: "host"`
worktree, Claude/Codex forks use the same resolved profile, permission, runtime
environment and agent-pane template as the root session. Their active pointer
and monotonic sequence are operational state in SQLite, never policy in
`.issue-flow.json`. Docker/sandbox profiles currently keep a single agent
session; declaring a profile does not imply tab support.

### `agent`

```json
{
  "agent": {
    "provider": "claude",
    "model": null,
    "codex": { "ignoreUserConfig": true },
    "phases": {
      "plan": { "provider": "codex", "codex": { "reasoningEffort": "low" } },
      "execute": { "provider": "codex", "model": "gpt-5.6" },
      "review": { "model": "claude-sonnet-5" }
    }
  }
}
```

A phase override is **partial**: declaring only `model` keeps the provider. Full
reference — providers, permission mapping, authentication, token economy — in
[Agents](agents.md).

| Key | Values | Default | Meaning |
|-----|--------|---------|---------|
| `hooks.enabled` | boolean | `true` | Whether the pipeline installs the [lifecycle hooks](agents.md#lifecycle-hooks) through which an agent reports that it is working or blocked on a human. Off means nothing is written into the working tree's `.claude/` or `.codex/` |

### Custom agents

Custom agents let an interactive session run a terminal harness that Issue Flow
does not ship as a built-in runner. They are configured under the top-level
`agents` key in either configuration file:

```json
{
  "agents": {
    "gemini-cli": {
      "label": "Gemini CLI",
      "startCommand": "gemini --prompt ${PROMPT}",
      "resumeCommand": "gemini --resume --prompt ${PROMPT}"
    }
  }
}
```

The object key is the stable id: lowercase letters and digits separated by
single hyphens, beginning with a letter, at most 64 characters. `label` and
`startCommand` are required; `resumeCommand` is optional. Without a resume
command, reopening starts a fresh process and the advertised `resume`
capability is false.

The global registry in `~/.issue-flow/config.json` is loaded first. A matching
entry in `.issue-flow.json` replaces it; a project can hide one inherited id
with a tombstone:

```json
{ "agents": { "gemini-cli": null } }
```

Templates accept `${PROMPT}`, `${SYSTEM_PROMPT}`, `${WORKTREE_PATH}`,
`${REPO_PATH}`, `${BRANCH}`, `${PROFILE}` and `${PERMISSION}`. The editable
field is parsed into argv without executing a shell; `&&`, `$(...)`, redirects
and semicolons are ordinary arguments. Known placeholders become references to
an ephemeral `0600` environment file and their values never enter argv, tmux
commands or logs. Unknown placeholders remain untouched for the program to
interpret.

`PERMISSION` is one of `read-only`, `workspace` or `autonomous`, defaults to
`workspace` for a new session, and is persisted on the session so reopen and
profile changes do not silently escalate it. A custom template is a TTY
extension only: it does not become a headless pipeline provider and cannot
claim structured chat, conversation history or interrupt support.

The dashboard lists and validates agents with `agents:read`. On a remote bind,
the response redacts both commands. Create/update/delete and the editor require
`agents:write`, which the server announces only on loopback. Project writes are
atomic and preserve unrelated `.issue-flow.json` keys.

### `verify`

```json
{
  "verify": {
    "level": "L1",
    "triggers": [],
    "crossVerify": true,
    "contract": [
      { "id": "typecheck", "run": "npm run typecheck", "fatal": true },
      { "id": "lint", "run": "npm run lint", "fatal": true },
      { "id": "test", "run": "npm test", "fatal": true }
    ]
  }
}
```

| Key | Values | Default |
|-----|--------|---------|
| `level` | `L0` \| `L1` \| `L2` \| `L3` \| `L5` | `L1` |
| `triggers` | `string[]` | `[]` |
| `crossVerify` | boolean | `true` |
| `pairings` | `Record<string, string>` | `{}` |
| `contract` | `{ id, run?, expectFiles?, fatal? }[]` | absent |

See [Verification and routing](verification.md).

### `routing`

```json
{
  "routing": {
    "mode": "shadow",
    "profile": "balanced",
    "policy": "recommended",
    "escalation": { "enabled": false, "minAttemptsBeforeEscalation": 2, "maxEscalations": 2 },
    "ceilings": { "maxCostUsdPerIssue": null, "maxDurationMsPerIssue": null }
  }
}
```

| Key | Values | Default |
|-----|--------|---------|
| `mode` | `off` \| `shadow` \| `recommend` \| `active` | `shadow` |
| `profile` | `economy` \| `balanced` \| `quality` \| `speed` | `balanced` |
| `policy` | `recommended` | absent (adaptive score) |
| `escalation.enabled` | boolean | `false` |
| `escalation.minAttemptsBeforeEscalation` | integer > 0 | `2` |
| `escalation.maxEscalations` | integer ≥ 0 | `2` |
| `escalation.maxRungs` | subset of `effort`, `model`, `harness`, `review`, `decompose` | `["effort","model","harness"]` |
| `ceilings.maxCostUsdPerIssue` | number \| `null` | `null` |
| `ceilings.maxDurationMsPerIssue` | number \| `null` | `null` |
| `ceilings.maxExecutionsPerIssue` | integer \| `null` | `null` |
| `ceilings.onCeiling` | `block` | `block` |

See [Verification and routing](verification.md#shadow-routing).

`routing` is accepted in both `.issue-flow.json` and
`~/.issue-flow/config.json`. Resolution is
`default → global → project → CLI`; there is no environment-variable rung.
The recommended policy and `active` remain independent opt-ins: writing the
policy does not change the default `shadow` mode. In `recommend` / `active`,
the router receives a readiness inventory (install, authentication, model
access, cooldown) as an injected snapshot — it never probes itself — and ranks
only attemptable harnesses. Affinity in `RECOMMENDED_POLICY` is a soft prior,
not a pin.

### `resilience`

Retry policy per failure kind, provider failover, queue behaviour, watchdog,
journal and decomposition. **The same object is accepted in
`~/.issue-flow/config.json`** — they are two rungs of one ladder, not two
formats. Every field is optional and none carries a default at this rung, so a
project that configures nothing resolves to `{}`.

```json
{
  "resilience": {
    "profile": "continuous",
    "failoverOnAuth": false,
    "retry": {
      "network": { "retryForever": true, "maxDelayMs": 120000 },
      "rateLimit": { "retryForever": true, "maxDelayMs": 900000 },
      "providerDown": { "maxAttempts": 4, "failover": "after_attempts" }
    },
    "providers": {
      "failover": true,
      "chain": ["claude", "codex"],
      "cooldownMs": 60000,
      "maxCooldownMs": 1800000,
      "failureWindowMs": 300000,
      "failuresToTrip": 3
    },
    "queue": { "onIssueFailure": "skip", "maxIssueAttempts": 3 },
    "watchdog": { "inactivityTimeoutMs": 600000 },
    "journal": { "enabled": true },
    "decompose": { "auto": false }
  }
}
```

Full reference — the retry table, the failure taxonomy and what no configuration
can override — in [Resilience](resilience.md).

### `telemetry`

| Key | Values | Default |
|-----|--------|---------|
| `enabled` | boolean | `true` |
| `maxExecutions` | integer > 0 | `500` (legacy compatibility; SQLite history is not truncated) |
| `pricing.estimate` | boolean | `false` |
| `pricing.overrides` | `Record<model, { inputPerMillion, outputPerMillion, cacheReadPerMillion, cacheWritePerMillion }>` | `{}` |

Telemetry is one row per agent invocation in SQLite, projected to
`tasks.json.executions` for compatibility, and read with `issue-flow usage`. See
[Storage → execution telemetry](storage.md#execution-telemetry).

### `policy`

The `policy` key both **declares** what discovery cannot infer and **turns off**
what it gets wrong:

```json
{
  "policy": {
    "enabled": true,
    "contextBudget": 1500,
    "issues": { "titleConvention": "[Area] Title", "allowLabelCreation": false },
    "pullRequests": { "baseBranch": "develop", "titleConvention": "type(scope): subject" },
    "git": { "branchConvention": "feat/{slug}", "commitConvention": "conventional" },
    "discovery": { "labels": false }
  }
}
```

| Key | Effect |
|---|---|
| `enabled` | `false` runs no discovery at all — not a single `stat()` or network call. Default `true` |
| `contextBudget` | Token budget for the policy summary injected into prompts (default `1500`). Over it, a whole section is replaced by a pointer — never truncated mid-rule |
| `issues.titleConvention` | Declares an issue title convention; nothing discovers one |
| `issues.allowLabelCreation` | `true` lets Issue Flow create a label the repository does not have. **Defaults to `false`** |
| `pullRequests.baseBranch` | Overrides the branch discovered from git |
| `pullRequests.titleConvention`, `git.*` | Declared here, or discovered from commitlint / release-please / semantic-release / Changesets / `action-semantic-pull-request`. See [Git conventions](git-conventions.md) |
| `discovery.{issueTemplates,pullRequestTemplate,docs,codeowners,labels,issueTypes}` | Turns a single discovery pass off, leaving the others running. All default `true` |

A declaration you do not write stays **absent** rather than becoming `null`, so
it never erases what discovery found. Full behaviour in
[Conventions](conventions.md).

## `~/.issue-flow/config.json`

Machine-wide preferences, all keys optional and **none carrying a default** —
this file is an intermediate rung, and a default materialized here would be
indistinguishable from a value you actually wrote.

```json
{
  "schemaVersion": 1,
  "storageDir": "/mnt/data/issue-flow",
  "storage": { "driver": "sqlite", "backupRetention": 5, "retention": { "executions": 0, "events": 0, "snapshots": 0, "backups": 5 } },
  "web": { "port": 3737, "host": "127.0.0.1", "refreshSeconds": 5, "logLimit": 200 },
  "retry": { "retryLimit": 10, "retryForever": false, "backoffBaseSeconds": 30, "backoffMaxSeconds": 900 },
  "commit": { "signoff": false, "conventional": true },
  "resilience": { "profile": "continuous" },
  "telemetry": { "enabled": true },
  "agent": { "provider": "claude", "phases": { "execute": { "provider": "codex" } } },
  "agents": { "gemini-cli": { "label": "Gemini CLI", "startCommand": "gemini ${PROMPT}" } },
  "routing": { "mode": "shadow", "policy": "recommended" }
}
```

| Key | Meaning |
|-----|---------|
| `schemaVersion` | Format version of the file |
| `storageDir` | Alternative directory holding `projects/` |
| `storage` | Structured-state driver (`sqlite` by default; `json` keeps the compatibility path active), pre-migration backup retention (5 by default), and optional explicit row retention. A positive `retention.executions`, `events` or `snapshots` limit is enforced transactionally on writes and imports; `0` retains all rows. `retention.backups` overrides `backupRetention` when both are set. |
| `web` | Machine-wide web defaults. Deliberately a subset of the project key: `enabled` and `includeLogs` stay a per-project decision |
| `retry` | Retry and backoff preferences, mirroring the engine defaults |
| `commit` | Commit preferences. `signoff` is consumed by `commitMessage()` |
| `resilience` | The same object `.issue-flow.json` accepts |
| `telemetry` | The same object `.issue-flow.json` accepts |
| `agent` | Machine default provider, model and per-phase overrides |
| `agents` | Machine-wide custom terminal agents; a project may replace or mask each id |
| `routing` | Machine-wide routing mode, profile, policy, escalation and ceilings |

There is no `verify`, `issues`, `prReview` or `policy` rung in this
file — those are per-project decisions and resolve from `.issue-flow.json`
upwards only.

## Environment variables

| Variable | Overrides |
|----------|-----------|
| `ISSUE_FLOW_HOME` | The default global storage root; an existing workspace `.issue-flow/issues/` selects local storage — see [Storage](storage.md#issue_flow_home) |
| `ISSUE_FLOW_WEB`, `ISSUE_FLOW_WEB_PORT`, `ISSUE_FLOW_WEB_HOST`, `ISSUE_FLOW_WEB_REFRESH`, `ISSUE_FLOW_WEB_LOG_LIMIT` | The `web` key |
| `ISSUE_FLOW_PROJECT_DIR` | Extra repositories [`issue-flow serve`](commands.md#web-monitor) should serve, for that process only. Several are accepted, separated by `:` (or `;`) — a `systemd` unit starts in `/` and has no working directory to infer them from |
| `ISSUE_FLOW_AGENT`, `ISSUE_FLOW_AGENT_MODEL` | The `agent` key. There are **no** per-phase variables |
| `ISSUE_FLOW_AGENT_HOOKS` | `agent.hooks.enabled` |
| `ISSUE_FLOW_CODEX_SANDBOX`, `ISSUE_FLOW_CODEX_REASONING_EFFORT`, `ISSUE_FLOW_CODEX_IGNORE_USER_CONFIG` | Codex runner settings |
| `ISSUE_FLOW_CURSOR_SANDBOX`, `ISSUE_FLOW_CURSOR_PERMISSIONS_FILE` | Cursor runner settings |
| `ISSUE_FLOW_ANTIGRAVITY_SANDBOX`, `ISSUE_FLOW_ANTIGRAVITY_EFFORT`, `ISSUE_FLOW_ANTIGRAVITY_EXECUTE_TIMEOUT` | Antigravity runner settings |
| `ISSUE_FLOW_OPENCODE_VARIANT`, `ISSUE_FLOW_OPENCODE_MIN_VERSION` | OpenCode runner settings |
| `ISSUE_FLOW_PR_REVIEW_PUBLISHER` | `prReview.publisher` |
| `ISSUE_FLOW_RUN_AUTO_CLOSE` | `run.autoClose` |
| `ISSUE_FLOW_GITHUB_LINKED_REPOS`, `ISSUE_FLOW_GITHUB_SYNC_INTERVAL_MS`, `ISSUE_FLOW_GITHUB_AUTO_REMOVE_ON_MERGE` | The `github` key. Linked repositories are a comma-separated list of `owner/repo=alias` pairs; the alias may be omitted, and then the repository name stands in for it |
| `LINEAR_API_KEY` | Linear credential. Environment-only: never persisted, logged or included in telemetry |
| `ISSUE_FLOW_LINEAR_ENABLED`, `ISSUE_FLOW_LINEAR_AUTO_CREATE`, `ISSUE_FLOW_LINEAR_WATCH_TEAMS` | Non-secret `linear` policy. Team keys are comma-separated |
| `ISSUE_FLOW_RUNTIME_PROFILE`, `ISSUE_FLOW_RUNTIME_MAX_CONCURRENT` | `runtime.profile` — the profile a run opens with — and `runtime.maxConcurrent`. Profiles and services themselves have no variable: they are too shaped for one, and they belong to the repository rather than to a shell |
| `ISSUE_FLOW_POLICY`, `ISSUE_FLOW_POLICY_CONTEXT_BUDGET`, `ISSUE_FLOW_POLICY_BASE_BRANCH`, `ISSUE_FLOW_POLICY_BRANCH_CONVENTION`, `ISSUE_FLOW_POLICY_COMMIT_CONVENTION`, `ISSUE_FLOW_POLICY_PR_TITLE_CONVENTION`, `ISSUE_FLOW_POLICY_ISSUE_TITLE_CONVENTION` | The `policy` key |
| `ISSUE_FLOW_TELEMETRY`, `ISSUE_FLOW_TELEMETRY_MAX_EXECUTIONS`, `ISSUE_FLOW_TELEMETRY_ESTIMATE` | The `telemetry` key |
| `ISSUE_FLOW_RESILIENCE_PROFILE`, `ISSUE_FLOW_RESILIENCE_FAILOVER`, `ISSUE_FLOW_RESILIENCE_FAILOVER_ON_AUTH`, `ISSUE_FLOW_RESILIENCE_PROVIDER_CHAIN`, `ISSUE_FLOW_RESILIENCE_PROVIDER_COOLDOWN_MS`, `ISSUE_FLOW_RESILIENCE_PROVIDER_MAX_COOLDOWN_MS`, `ISSUE_FLOW_RESILIENCE_PROVIDER_FAILURE_WINDOW_MS`, `ISSUE_FLOW_RESILIENCE_PROVIDER_FAILURES_TO_TRIP`, `ISSUE_FLOW_RESILIENCE_ON_ISSUE_FAILURE`, `ISSUE_FLOW_RESILIENCE_MAX_ISSUE_ATTEMPTS`, `ISSUE_FLOW_RESILIENCE_INACTIVITY_TIMEOUT_MS`, `ISSUE_FLOW_RESILIENCE_JOURNAL`, `ISSUE_FLOW_RESILIENCE_JOURNAL_MAX_BYTES`, `ISSUE_FLOW_RESILIENCE_AUTO_DECOMPOSE` | Scalar knobs of the `resilience` key |
| `ISSUE_FLOW_RESILIENCE_RETRY` | The whole per-kind `retry` table, as JSON — it is too shaped for one variable per field |

There are no environment variables for `verify` and `routing`: they resolve
**CLI > `.issue-flow.json` > `~/.issue-flow/config.json` > default**.

The provider chain is comma-separated
(`ISSUE_FLOW_RESILIENCE_PROVIDER_CHAIN=claude,codex`). Boolean variables read
`""`, `0`, `false`, `no` and `off` as false; anything else is true.

## Per-repository prompt overrides

A repository can adjust any packaged prompt without forking:

| File | Effect |
|------|--------|
| `.issue-flow/prompts/<name>.append.md` | Appended to the packaged prompt. **The recommended form** |
| `.issue-flow/prompts/<name>.md` | Replaces the packaged prompt entirely |

`append` is recommended because replacing a whole prompt makes the repository
inherit its maintenance: improvements shipped by later releases stop reaching it,
silently. With both present the replacement wins, with a warning. With neither,
the prompt is exactly the packaged one. Empty repository policy removes its
conditional sections without leaving headings or unresolved placeholders;
tests cover every packaged prompt. Shared contracts still evolve with releases.

The available `<name>` values are the packaged prompt files: `analyze`,
`execute`, `generate`, `plan`, `pr`, `pr-review`, `prd`, `review`.

These overrides apply to CLI prompts, not to installed Skills. Issue Flow
contributors edit `packages/issue-flow/prompts-src/` and synchronize packaged
prompts from the [canonical sources](skills.md#source-and-distribution).
