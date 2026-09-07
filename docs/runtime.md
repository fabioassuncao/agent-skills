# Runtime modes — headless, interactive, sandbox

One contract, three modes. The mode decides **where** an agent runs and **how**
it is observed. It never decides **what** runs: `AgentInvocation` and
`AgentRunResult` keep their shape in all three (ADR-02), which is what keeps
failover, the watchdog, the resilience layer, telemetry and the session reducer
valid whichever mode is in use.

| Mode | Isolation | Process | Observed through | Use |
|---|---|---|---|---|
| `headless` | branch in the repository | `execa`, stream-json | the runner's own event stream | CI, the default, everything that already worked |
| `interactive` | git worktree | a tmux pane (TTY) | the agent's lifecycle hooks | working with a human nearby |
| `sandbox` | worktree + container | the same pane, inside `docker exec` | the same hooks | untrusted code, conflicting dependencies |

`headless` is the default and is never removed (ADR-03). A repository with no
tmux, no docker and no worktree keeps behaving exactly as it always did.

## Choosing a mode

```ts
import { createRuntime } from './runtime/index.js';

const runtime = createRuntime('interactive');
const context = await runtime.prepare({ projectRoot, branch, runId });
const handle = await runtime.launch(context, invocation, settings);

for await (const event of runtime.observe(handle)) report(event);
const result = await handle.result();

await runtime.send(handle, 'also handle the empty case');
await runtime.interrupt(handle);
await runtime.dispose(context, { removeWorktree: true, keepBranch: true });
```

Building a runtime touches nothing: the worktree modes resolve their wiring on
the first `prepare()`, from the `projectRoot` it is given.

Ask a capability, never a mode name:

| Capability | `headless` | `interactive` | `sandbox` |
|---|---|---|---|
| `interactivePrompt` — `send()` reaches a live agent | `false` | `true` | `true` |
| `interrupt` — `interrupt()` reaches the process | `false` | `true` | `true` |
| `livesBeyondInvocation` — the agent outlives `result()` | `false` | `true` | `true` |
| `isolation` | `branch` | `worktree` | `worktree` |

## What each phase of the lifecycle does

### `prepare(input)`

| | `headless` | `interactive` | `sandbox` |
|---|---|---|---|
| working directory | the repository, untouched | a worktree, created or reused | the same |
| tmux | — | the project session (`if-<projectId>`) | the same |
| container | — | — | one per branch, started or joined |
| ports | — | allocated for the declared services, probed | the same, published on `127.0.0.1` |

Both worktree modes **require a branch and a run id**. The branch is what the
worktree, the tmux window and the container are all named after; the run id is
how the agent's lifecycle events are correlated back (ADR-05), so without one an
invocation could be started but never observed.

A missing tool is refused, never worked around. `prepare()` names what is
missing and how to get it, and creates nothing on the way out — a mode that
quietly fell back to `headless` would report an isolation it never provided, and
isolation is the only reason to ask for another mode.

### `launch(context, invocation, settings)`

The agent command is assembled as **argv** (ADR-04) and serialized to a shell
string exactly once, at the tmux boundary. The first prompt travels in that argv
— never through the terminal — and subsequent turns go through a tmux buffer
paste, which is the only delivery a TUI with slash commands and paste detection
survives.

In `sandbox`, every pane of the window is opened with
`docker exec -it -w <worktree> <container> /bin/sh -c …`, so the agent command
typed into it lands inside the container **without naming docker itself**.

`review` and `pr-review` never continue an existing session (ADR-07). The rule
lives in `agents/session/reuse.ts` and no mode works around it: a phase that may
not adopt the live session on a branch is refused rather than seated beside it.

### Multiple agent tabs in one worktree

Host-runtime managed worktrees may contain a Root agent pane and several
provider-native forks. A tab is another durable `AgentSession` for the same
exact `worktreeId`; it is neither a terminal viewer nor browser layout state.
Only Claude and Codex are forkable. Review and PR-review sessions remain
ineligible because forking their conversation would violate the same
independence rule as resume.

Fork panes are created in a private parking window on the dedicated Issue Flow
tmux socket. Selection swaps or moves a stable pane id into the visible agent
slot and parks the previous one; services stay in the main worktree window and
are never moved. Every physical operation proves the pane id, project-owner
tag, main/parking window and durable session token. A pane number reused after
a tmux restart is therefore foreign, not a session to adopt or kill.

Create, select, close and refresh hold the same cross-process branch lock over
tmux and persistence. Refresh is deliberately non-destructive: it reattaches a
live pane or resumes the same conversation when that pane is absent. Missing
panes become `orphaned` evidence; closing an orphan needs no kill, and closing a
present fork kills only after ownership is proved. The root tab cannot be
closed. Sandbox worktrees do not currently expose tab forking.

### `result()` and `observe()` in a pane

An agent running as a TUI produces no stream-json, and nothing here reads the
screen (ADR-05, ADR-06): a parser over a TUI produces output that is plausible
and wrong, and breaks on every harness release. The outcome comes from where the
agent itself reports it — its lifecycle hooks, persisted in `agent_events` and
correlated by `runId` + `phase`.

- `agent_stopped` ends the invocation, successfully when no error was reported;
- `runtime_error` ends it as a failure carrying the reported message;
- `agent_status_changed` and `pr_opened` are published on the stream on the way.

`AgentRunResult` keeps its shape, and the fields a pane genuinely does not have
are left empty rather than invented:

| Field | In a pane | Why |
|---|---|---|
| `result`, `rawOutput` | `''` | the agent's text is on the terminal, which this runtime may not read |
| `usage` | `null` | tokens and cost are reported on the stream-json channel a TUI does not have. A zero would be a measurement nobody took |
| `exitCode` | `0` / `1` | a projection of `success`: the pane's real exit code is the shell's, not the agent's |

An invocation with a `timeout` that reports nothing within it resolves as a
failure that says so — **and leaves the pane alone**. `livesBeyondInvocation` is
true, so a slow agent keeps its window, its conversation and its work; ending it
is `interrupt()` or `dispose()`, which are the caller's explicit acts.

### `dispose(context, options)`

In reverse order of `prepare`: the sessions this runtime started stop first (the
window is killed only when no other live session remains on the branch), then
the container this `prepare` **started** — never one it joined — and then, only
when `removeWorktree` is asked for and only when this `prepare` created it, the
worktree. `keepBranch` keeps the branch, which is the only thing still holding
the work once the directory is gone.

A worktree this runtime found rather than created is left in place, with a
warning saying so. Somebody else's checkout, and whatever is uncommitted in it,
is not ours to delete because a teardown asked politely (ADR-08).

## Where the behaviour actually lives

Both worktree modes are thin adapters. Nothing below is reimplemented in them:

| Responsibility | Module |
|---|---|
| the checkout, its binding and its rollback | [`src/runtime/worktree/`](../packages/issue-flow/src/runtime/worktree/AGENTS.md) |
| sessions, windows, panes, the reattach decision | [`src/runtime/tmux/`](../packages/issue-flow/src/runtime/tmux/AGENTS.md) |
| the container and its hardened `docker run` | [`src/runtime/sandbox/`](../packages/issue-flow/src/runtime/sandbox/AGENTS.md) |
| the agent argv and the pane commands | `src/agents/tty.ts` |
| worktree + window + agent, in one act | [`src/agents/session/`](../packages/issue-flow/src/agents/session/AGENTS.md) |
| getting a subsequent turn into a TUI | [`src/runtime/terminal/`](../packages/issue-flow/src/runtime/terminal/AGENTS.md) |
| profiles, panes, port allocation and health | `src/runtime/profiles.ts`, `src/runtime/services.ts` |
| lifecycle hooks and their event contract | `src/agents/hooks/` |

The security model of the `sandbox` mode — what the container protects against
and what it explicitly does not — is
[`docs/sandbox-security.md`](sandbox-security.md). Read it before changing any
container flag.
