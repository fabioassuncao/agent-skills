# src/runtime

One contract, three modes: `headless`, `interactive`, `sandbox`. The mode
decides **where** an agent runs and **how** it is observed. It never decides
**what** runs.

The user-facing description of the three — what each isolates, what a teardown
may remove, and what a pane's `AgentRunResult` does and does not carry — is
[`docs/runtime.md`](../../../../docs/runtime.md).

## Invariants

- **`headless` is the default and is never removed** (ADR-03). A repository
  with no tmux, no docker and no worktree must keep behaving exactly as it
  does today — that is also what keeps CI working. Any change here that makes
  the default path depend on an external multiplexer, a container or a second
  checkout is a regression, whatever the tests say.
- **`AgentInvocation` and `AgentRunResult` do not change shape** (ADR-02).
  They are what keeps failover, the watchdog, the resilience layer, telemetry
  and the session reducer valid across all three modes. New fields are
  additive and optional.
- **`headless.launch()` does not relocate the agent.** It passes the
  invocation to the runner untouched, `workingDirectory` included. Pinning it
  to `context.workdir` would put an explicit `cwd` on a spawn that never had
  one — equivalent in value, different in behaviour. Relocation belongs to the
  modes whose `prepare` actually created a different directory.
- **`headless.prepare()` and `headless.dispose()` touch nothing.** No git, no
  filesystem, no process. The pipeline already put the branch in place; a
  prepare that "helpfully" checked it would make the default mode depend on
  repository state it never depended on.
- **Capability, not mode name.** A caller asks `capabilities.interactivePrompt`
  or `capabilities.interrupt`, never "is this the headless one?". A fourth mode
  then adds a file rather than a set of conditionals — the same rule
  `AgentCapabilities` follows in `src/agents/`.
- **An unavailable mode fails loudly.** A worktree mode whose tools are missing
  is refused by `prepare()`, with a message naming what is missing and how to
  get it — and it creates nothing on the way out. A fallback to `headless`
  would report an isolation it never provided, and isolation is the only reason
  to ask for another mode.

## The two worktree modes

`interactive.ts` and `sandbox.ts` are **adapters**, not layers. They own the
shape of `Runtime` and nothing else: the checkout is `worktree/`, the window is
`tmux/`, the argv is `agents/tty.ts`, the whole worktree+window+agent act is
`agents/session/open.ts`, the container is `sandbox/docker.ts`, the ports are
`services.ts`. Rewriting any of those here is the duplication §25 forbids.

- **They are one implementation with two adapters.** `createPaneRuntime` is
  shared; `sandbox` differs by a container and by the worktree binding saying
  `runtime: 'docker'`. Two files that differ by a container must not become two
  implementations that differ by everything.
- **The outcome comes from hooks, never from the screen** (ADR-05, ADR-06).
  `result()` and `observe()` read `agent_events`, correlated by `runId` +
  `phase`; `launch()` starts the hook session because otherwise the table stays
  empty and there is nothing to wait for. Nothing here ever captures a pane.
- **What a pane does not know stays empty.** `result` and `rawOutput` are `''`
  and `usage` is `null`, because the text is on the terminal and the usage is on
  a stream-json channel a TUI does not have. A zero would be a measurement
  nobody took.
- **A timeout does not kill the pane.** `livesBeyondInvocation` is true: a slow
  agent keeps its window, its conversation and its work. Ending it is
  `interrupt()` or `dispose()`, which are the caller's explicit acts.
- **`dispose` never removes what it did not create.** The container is removed
  only when this `prepare` started it, the worktree only when this `prepare`
  created it *and* `removeWorktree` was asked for. `keepBranch` matters: once
  the directory is gone, the branch is the only thing still holding the work.
- **The window is killed by `stopAgentSession`, and only when the branch has no
  other live session.** One window holds every session on a branch; the rule
  lives there and is not restated here.
- **`prepare()` requires a branch and a run id.** The branch names the worktree,
  the window and the container; the run id is the only correlation the lifecycle
  events have. An invocation that could be started but never observed is worse
  than one that refuses to start.

## Never

- Never make `headless` depend on tmux, docker or a worktree.
- Never declare a capability a mode cannot deliver. `headless` says
  `interrupt: false` because the runner owns the child process and its own
  timeout ends it; claiming otherwise would be worse than declaring it absent.
- Never leave `launch()`'s promise unobserved. Nobody is required to await
  `result()`, so an unattached rejection would become an unhandled one — the
  promise is caught internally and `result()` still rejects for the caller who
  does await.
- Never read a pane to decide anything. No `capture-pane`, no scrollback
  parsing, no "the prompt looks idle". If a fact is not in the lifecycle events,
  it is not known.
- Never build a shell string for an agent. Argv, serialized once at the tmux
  boundary by `renderShellCommand` — and in the sandbox, the *shell* enters the
  container so the agent command never names docker.
- Never remove a worktree, a branch or a container this runtime did not create.
- Never let a worktree mode reimplement a worktree, a layout, an argv, a port
  allocation or a `docker run` argument list. If the module that owns it does
  not expose what is needed, add the smallest export there, with a test.
