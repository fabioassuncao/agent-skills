# CLI configuration

[CLI guide](cli.md) · [Project overview](../README.md)

The Issue Flow CLI resolves configuration through the layers below. Nothing is mandatory: with no
configuration at all, every default reproduces the behaviour of a plain
`issue-flow run 42` against a GitHub issue on Claude Code.

These settings configure the CLI runtime. Agent Skills use their current host's
configuration and repository instructions; they do not require `.issue-flow.json`
or a global CLI configuration. See [optional CLI enrichment](../skills/README.md#optional-cli-enrichment).

- [The precedence ladder](#the-precedence-ladder)
- [`.issue-flow.json`](#issue-flowjson) — per project
- [`~/.issue-flow/config.json`](#issue-flowconfigjson) — per machine
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

Optional, at the project root. Nine keys, all independent:

```json
{
  "web":        { "enabled": true, "port": 3737, "host": "127.0.0.1" },
  "issues":     { "preferredProvider": "github", "conflictPolicy": "ask" },
  "prReview":   { "publisher": "local" },
  "agent":      { "provider": "claude", "phases": { "plan": { "provider": "codex" } } },
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
| `routing` | Machine-wide routing mode, profile, policy, escalation and ceilings |

There is no `verify`, `issues`, `prReview` or `policy` rung in this
file — those are per-project decisions and resolve from `.issue-flow.json`
upwards only.

## Environment variables

| Variable | Overrides |
|----------|-----------|
| `ISSUE_FLOW_HOME` | The whole storage root — see [Storage](storage.md#issue_flow_home) |
| `ISSUE_FLOW_WEB`, `ISSUE_FLOW_WEB_PORT`, `ISSUE_FLOW_WEB_HOST`, `ISSUE_FLOW_WEB_REFRESH`, `ISSUE_FLOW_WEB_LOG_LIMIT` | The `web` key |
| `ISSUE_FLOW_AGENT`, `ISSUE_FLOW_AGENT_MODEL` | The `agent` key. There are **no** per-phase variables |
| `ISSUE_FLOW_CODEX_SANDBOX`, `ISSUE_FLOW_CODEX_REASONING_EFFORT`, `ISSUE_FLOW_CODEX_IGNORE_USER_CONFIG` | Codex runner settings |
| `ISSUE_FLOW_CURSOR_SANDBOX`, `ISSUE_FLOW_CURSOR_PERMISSIONS_FILE` | Cursor runner settings |
| `ISSUE_FLOW_ANTIGRAVITY_SANDBOX`, `ISSUE_FLOW_ANTIGRAVITY_EFFORT`, `ISSUE_FLOW_ANTIGRAVITY_EXECUTE_TIMEOUT` | Antigravity runner settings |
| `ISSUE_FLOW_PR_REVIEW_PUBLISHER` | `prReview.publisher` |
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
