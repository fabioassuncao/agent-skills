# src/runtime

One contract, three modes: `headless`, `interactive`, `sandbox`. The mode
decides **where** an agent runs and **how** it is observed. It never decides
**what** runs.

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
- **An unavailable mode fails loudly.** `createRuntime('interactive')` throws
  rather than falling back: a fallback would report an isolation it never
  provided, and isolation is the only reason to ask for another mode.

## Never

- Never make `headless` depend on tmux, docker or a worktree.
- Never declare a capability a mode cannot deliver. `headless` says
  `interrupt: false` because the runner owns the child process and its own
  timeout ends it; claiming otherwise would be worse than declaring it absent.
- Never leave `launch()`'s promise unobserved. Nobody is required to await
  `result()`, so an unattached rejection would become an unhandled one — the
  promise is caught internally and `result()` still rejects for the caller who
  does await.
