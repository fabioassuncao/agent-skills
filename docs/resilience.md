# CLI resilience

[CLI guide](cli.md) · [Project overview](../README.md)

Everything that decides *whether to try again, and after how long*. A six-hour
unattended run fails for a dozen reasons that have nothing to do with the code
being written; this layer is what tells those apart from the code actually being
wrong.

- [The failure taxonomy](#the-failure-taxonomy)
- [The retry table](#the-retry-table)
- [The `continuous` profile](#the-continuous-profile)
- [Provider failover](#provider-failover)
- [The inactivity watchdog](#the-inactivity-watchdog)
- [Queue behaviour](#queue-behaviour)
- [The event journal](#the-event-journal)
- [When an issue is too large](#when-an-issue-is-too-large)

Configured through the [`resilience` key](configuration.md#resilience) of
`.issue-flow.json` or `~/.issue-flow/config.json`.

## The failure taxonomy

Every failure is classified into exactly one kind. Classification decides by
evidence — exit code, signal, `errno`, HTTP status — and falls back to text only
when nothing structured is available.

| Kind | What it means |
|------|---------------|
| `network` | The connection failed: DNS, TCP, TLS, a dropped socket |
| `timeout` | The invocation exceeded its wall-clock budget |
| `stalled` | The agent produced no output for longer than the watchdog allows |
| `rate_limit` | The provider asked us to slow down |
| `provider_down` | The provider answered, and the answer was "unavailable" |
| `provider_crash` | The agent process died abnormally |
| `authentication` | A missing, expired or rejected credential |
| `configuration` | A flag, a binary or a setting that is wrong |
| `repository_state` | The repository is mid-rebase, mid-merge, or otherwise stuck |
| `task_execution` | The agent's own work failed: a failing test, a type error, a lint violation |
| `internal` | A defect in Issue Flow itself |
| `unknown` | Nothing matched |

### The golden rule

**`task_execution` is never retried by this layer.** A failing test is the
agent's work being wrong, not the infrastructure being unavailable — the same
prompt against the same tree produces the same failure. It already has its own
loop, and it is a different one: the `review` correction cycle, bounded by
`maxCorrectionCycles`.

The same veto covers `authentication`, `configuration` and `repository_state`:
waiting cannot fix a missing credential, a mistyped flag or a repository stuck
mid-merge. Those four kinds **escalate to a human; they do not retry**.

This is not a convention to remember. `resolvePolicy()` clamps those four kinds
to `maxAttempts: 0, retryForever: false` **after** the configuration layer has
been merged in, so no profile, no configuration file and no flag — `--retry-forever`
included — can buy them an attempt.

## The retry table

The defaults, per kind. Delays are jittered (`full` jitter) and grow by a factor
of 2 up to the maximum.

| Kind | Attempts | Initial delay | Max delay | Failover | On exhausted |
|------|----------|---------------|-----------|----------|--------------|
| `network` | 8 | 2s | 120s | never | fail |
| `timeout` | 2 | 30s | 120s | after attempts | fail |
| `stalled` | 2 | 15s | 15s | after attempts | fail |
| `rate_limit` | 6 | 60s | 900s | after attempts | fail |
| `provider_down` | 4 | 10s | 300s | after attempts | fail |
| `provider_crash` | 3 | 5s | 60s | after attempts | fail |
| `internal` | 2 | 5s | 5s | never | fail |
| `unknown` | 2 | 5s | 5s | never | fail |
| `authentication` | **0** | — | — | never | **block** |
| `configuration` | **0** | — | — | never | fail |
| `repository_state` | **0** | — | — | never | **block** |
| `task_execution` | **0** | — | — | never | fail |

A rate limit that carries a `Retry-After` waits exactly what the server asked
for rather than the computed backoff.

Override per kind through `resilience.retry`, whose keys are the camelCase form
of the kind: `network`, `timeout`, `stalled`, `rateLimit`, `providerDown`,
`providerCrash`, `authentication`, `configuration`, `repositoryState`,
`taskExecution`, `internal`, `unknown`.

```json
{
  "resilience": {
    "retry": {
      "network": { "retryForever": true, "maxDelayMs": 120000 },
      "providerDown": { "maxAttempts": 6, "failover": "after_attempts" }
    }
  }
}
```

Every `gh` invocation goes through the same policy: a DNS blip during a long run
is retried on the `network` budget, a rate limit waits what `Retry-After` asked,
and an expired credential is **not** retried — it stops immediately and prints
the action to take (`gh auth login`). The availability probes (`gh --version`,
`gh auth status`) use a smaller budget of their own, so an unreachable GitHub
never stalls a run on a local issue.

## The `continuous` profile

Unattended work needs about six behaviours turned on at once, and asking for six
flags is asking for five of them to be forgotten. `--continuous` (alias
`--resilient`, or `resilience.profile: "continuous"`) names the intent — *keep
going without me* — and expands to what that intent implies:

| Behaviour | What the profile sets |
|-----------|-----------------------|
| Network and rate limits | retried **forever**, with the backoff ceiling still in force |
| `timeout` / `stalled` | 3 attempts each |
| `provider_down` | retried forever, with failover after attempts |
| `provider_crash` | 5 attempts |
| Provider failover | on |
| A failing issue in a queue | `--on-issue-failure skip` |
| The event journal | on (`events.jsonl`) |
| The inactivity watchdog | on (10 minutes of silence) |

Two properties keep it honest:

- **It only ever widens.** What is not retryable under the default profile is not
  retryable here either — the profile is applied *before* the golden-rule clamp,
  never after it. A failing test is not retried into passing, and a missing
  credential is not waited out.
- **Anything it sets stays settable.** An explicit flag always beats the profile:
  `--continuous --no-failover`, `--continuous --on-issue-failure stop` and
  `--continuous --inactivity-timeout 0` are all coherent requests that mean
  exactly what they say.

## Provider failover

With failover enabled, provider health is learned from real invocations and
persisted transactionally in SQLite; `providers.json` is retained as a legacy
JSON fallback for existing installations.

- `provider_down`, `provider_crash`, `rate_limit`, `timeout` and `stalled` can
  move the next attempt through the configured chain.
- `network` stays on the same provider: changing a remote service does not
  repair the user's connection.
- `task_execution` never fails over.
- `authentication` blocks by default; opting into it requires **both**
  `failoverOnAuth: true` **and** an authentication retry policy whose `failover`
  is not `never`.

An unavailable provider enters exponential cooldown (60s, 120s, 240s, up to 30
minutes) and admits exactly one `half_open` probe when the cooldown expires. A
cooldown also marks the provider `unavailable` in the routing readiness
inventory (`PROVIDER_COOLDOWN`), so opinionated routing will not select it
while the circuit is open. A
provider trips after `failuresToTrip` failures (default 3) inside
`failureWindowMs` (default 5 minutes). **If every provider is cooling down, the
run waits for the shortest remaining cooldown instead of failing.**

```json
{
  "resilience": {
    "providers": {
      "failover": true,
      "chain": ["claude", "codex"],
      "cooldownMs": 60000,
      "maxCooldownMs": 1800000,
      "failureWindowMs": 300000,
      "failuresToTrip": 3
    }
  }
}
```

The order tried is: the configured primary for the phase, then `chain`, then
every other registered provider. A model name belongs to the configured primary:
a fallback provider uses its own default rather than being handed an alias it
does not understand.

`--no-failover` disables the whole mechanism for a run.

## The inactivity watchdog

`--timeout` bounds how long an invocation may take. The watchdog bounds how long
it may say **nothing** — a second, tighter instrument that tells a long task from
a stuck one.

Default **600 seconds** (10 minutes) of complete silence. `0` turns it off.
Configure it with `--inactivity-timeout <seconds>`,
`resilience.watchdog.inactivityTimeoutMs` or
`ISSUE_FLOW_RESILIENCE_INACTIVITY_TIMEOUT_MS`. A tripped watchdog classifies the
failure as `stalled`.

### While a person is in control

The watchdog **never** trips on a run somebody has taken over. That is not a
tolerance setting: a held run is silent because a person is reading it, and
killing the agent at exactly that moment is the failure the hold exists to
prevent.

Releasing the hold gives the agent the **whole** silence budget again, rather
than counting the minutes the person spent thinking. See
[human takeover](web-monitor.md#human-takeover).

## Queue behaviour

In a [multi-issue queue](issues.md#hierarchies-and-queues),
`--on-issue-failure` decides what a failing issue does to the rest:

| Mode | Effect |
|------|--------|
| `stop` (default) | The queue ends where the failure happened |
| `skip` | The issue is set aside, the independent issues run, and the queue comes back to it at the end |
| `block` | The issue is set aside for a human and never retried in this run |

`resilience.queue.maxIssueAttempts` (default 3) bounds how many times one issue
may be attempted inside a queue.

## The event journal

`session.json` is a *projection*: the reducer folds every event into one snapshot
and the events themselves are discarded. That is the right shape for a dashboard
and the wrong one for an audit — after a six-hour run, "what happened at 3am" has
no answer.

The journal writes the **events** instead of the state: one JSON line each, in
order, with a monotonic `seq`. It sits beside `session.json`, never in its place,
and replaying it through the reducer reproduces the snapshot.

```json
{"seq":41,"event":{"type":"failover","at":"…","from":"claude","to":"codex","reason":"provider_down"}}
```

It is **opt-in** (`resilience.journal.enabled`, implied by `--continuous`), and
rotates at `maxFileBytes` (10 MB by default) into `events.1.jsonl`. Nothing is
throttled: dropping or coalescing events is exactly what the snapshot already
does, and the point of the journal is that it does not.

Read it with [`issue-flow logs`](commands.md#operating-a-run), or through the
*"Histórico"* tab of the [web monitor](web-monitor.md). It is also what
[`resume`](commands.md#resume--continue-an-interrupted-pipeline) uses to name the
phase that was interrupted.

## When an issue is too large

A phase that keeps timing out, a plan with thirty stories, five iterations in a
row that finish nothing: each is ambiguous alone and any one of them can be a
slow afternoon. Two or more of them agreeing is the same thing said twice, and
what it is saying is that the demand was never one issue.

Before proposing a split, Issue Flow tries the cheaper remedy: after the journal
records the **second** timeout in the same phase, its next attempt gets **2×**
the configured/default timeout. The widening is capped at 2× and never compounds;
`--timeout 0` remains unlimited.

When a **failed** run carries at least two of these signals, Issue Flow writes
`decomposition.md` in the issue directory and marks the issue `blocked` with a
pointer to it:

| Signal | Threshold |
|--------|-----------|
| Timeouts on the same phase | 2 |
| User stories in the plan | more than 15 |
| Iterations in a row completing no story | 5 |
| Files touched on the branch | more than 40 |
| Characters in the issue body | more than 20 000 |
| The execute loop ran out of iterations | — |

The report names every signal **with the number that crossed the line**, proposes
a cut of the pending stories in priority order, and stops there: splitting an
issue is a product decision, and the default is a report rather than an act.

A run that failed because the network went down is **not** decomposed. Network
and rate-limit retries are not size signals, and reacting to an outage with "have
you considered splitting this issue?" would be worse than silence.

`--auto-decompose` (or `resilience.decompose.auto`) creates the proposed
sub-issues through `issue-flow generate`, so the repository's label and template
policy applies to each of them. It refuses to run when the branch already carries
committed stories: splitting on top of half-finished work leaves commits
belonging to no issue, and that needs a person.

## Recovery and reconciliation

A pipeline is not the only thing that can be interrupted. The process can be
restarted, the machine can reboot, a container can die, and someone can remove a
worktree by hand. `src/runtime/reconcile.ts` is what makes the answer to all of
those the same answer.

**One rule decides every case: who is the authority.**

| Data | Authority | What the database holds |
|------|-----------|-------------------------|
| Which worktrees exist; branch, dirty, ahead | **git** | a projection |
| A live window and its panes | **tmux** (`list-windows -a`) | the last liveness seen |
| A live container | **docker** | a projection |
| Whether a conversation still exists | **the provider** | its id |
| Whether the agent is working or waiting | **the agent's hooks** | the current state |
| What a session is bound to — run, phase, story | **SQLite** | the authority |
| Workflow progress | **SQLite** (`runs`/`phases`/`stories`) | the authority |
| Allocated ports | **SQLite** + `runtime.env` | the authority |

The outside world is the authority on **existence and life**; the database is
the authority on **binding and intent**. A disagreement always resolves in
favour of the outside world, and the row is marked `orphaned` — never recreated
out of optimism, and never deleted because a directory is gone. Closing a
session that way writes an `audit_log` entry, so a status that changed has a
reason attached to it.

That asymmetry is what keeps the two failure modes apart. Recreating a worktree
because a row mentions one would resurrect work nobody asked for; deleting a row
because a directory vanished would destroy the record of what was attempted. The
projection is rebuilt from scratch on every pass and so never accumulates
rubbish; the bindings are never rebuilt and so never lose history.

**How a session comes back** depends only on what is actually alive:

| What survived | What happens | What it costs |
|---|---|---|
| The tmux window | **reattach** — the window is not touched | nothing; the agent never noticed |
| Only the conversation | **resume** (`--resume <id>`) | startup, not context |
| Neither | **fresh** | a new conversation |

A live window always wins. An agent whose window is intact kept working while
nobody was watching, and rebuilding that window to "restore" it would kill the
process it was restoring.

**Reconciliation reads the world in aggregate.** `tmux list-windows -a` runs
once per pass and the container listing runs once per pass, never once per
entity — measured flat from 1 to 21 worktrees, inside the 50 ms budget. That is
what makes a 500 ms freshness window affordable: a pass that grew with the
number of worktrees could not be repeated at that rate. Calls that arrive during
a pass join it rather than starting a second one, so a dashboard refreshing four
panels costs one pass.

**Reconciliation never invents agent state.** `starting`, `running` and `idle`
are reported by the agent's hooks; a pane existing is not evidence for any of
them. The only move this layer makes is the demotion of a live row whose window
is gone. A silent agent is the [watchdog](#the-inactivity-watchdog)'s problem,
not a reconciliation problem.
