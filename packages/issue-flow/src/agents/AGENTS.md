# src/agents

The swappable piece inside `runHeadless` and `executeClaude`. The facades stay;
only argv and stream parsing move here.

## Invariants

- **Default is `claude`.** An unconfigured run produces the same argv the
  project has always used. Never auto-detect the agent from which binary is
  installed — the same repository must behave the same on every machine.
- **`permission` is semantic.** Each runner translates it. Claude `workspace`
  and `autonomous` keep the historical flags; `read-only` adds
  `--permission-mode plan` and a deny-list, because `--allowedTools` alone
  does not restrict (a subagent inherits the full toolset). Codex never emits
  `--dangerously-bypass-*`. Codex `autonomous` stays `workspace-write`.
- **`phases` merge key by key.** `mergeConfigLayers()` is shallow and would
  let a project's `phases` map erase the global one. `loadAgentConfig()`
  flattens per phase, the same way `loadPolicyConfig()` flattens
  `discovery` / `issues` / `pullRequests` / `git`.
- **`--agent` without a phase overwrites everything**, including `phases`.
  That is the emergency button. Fine-grained overrides use `--agent-phase`.
- **`AgentRunResult.agent` is who actually ran.** Header, snapshot and
  metrics read it. Nothing infers the provider afterwards.
- **`readonly capabilities` is the extension point.** Claude, Codex,
  Cursor, Antigravity and OpenCode declare theirs; the core never asks which
  provider it is. Extra directories are a capability: `flag` translates
  (`--add-dir`, or OpenCode `external_directory` via `OPENCODE_PERMISSION`),
  `permission-file` compensates (Cursor grant of `~/.issue-flow/**`),
  `none` fails as `configuration` when `addDirs` are required.
  `allowedTools` is a restriction and may be ignored. `promptChannel`
  tells the core how the prompt arrives (`argv` is subject to ARG_MAX).
  `nativeTimeout: true` obliges the runner to translate
  `AgentInvocation.timeout` — including `timeout: 0` — into argv; omitting
  it lets the provider's own default win.
- **Cursor `--force` is an invariant** on `workspace`/`autonomous`.
  `agent.cursor.force: false` is rejected: without it the phase exits 0
  and writes nothing. `read-only` uses `--mode plan` and never `--force`.
- **Cursor reports no tokens and no cost.** `usage` is always `null`,
  never zeros. A mixed run's totals are structurally incomplete.
- **Antigravity `--add-dir <workspace>` is an invariant.** Without it
  writes land in the provider's scratch directory. `--dangerously-skip-permissions`
  and `--disable-slash-commands` are also invariants: there is no setting
  that removes them. `--mode` is the real write containment (`plan` vs
  `accept-edits`). A tool step denied by permission with `status: SUCCESS`
  is still a `configuration` failure. `status: WAITING` is `configuration`
  — the run ended waiting for a human.
- **OpenCode `--auto` is not a sandbox.** The runner always sends an
  explicit `OPENCODE_PERMISSION` policy with denials (`question`, wildcard
  `external_directory`, and `edit` / mutating `bash` in `read-only`). `--auto`
  only approves what that policy did not deny. Extra dirs become
  `external_directory` allows limited to the requested paths. `--auto` is
  never used without those denials. Auth is `opencode auth list` (textual);
  tokens are reported only when `step_finish` includes them; cost stays
  absent. Model ids are `provider/model`. An omitted model is filled from the
  OpenCode Go policy (`opencode-go/qwen3.8-flash` and siblings), never from
  Anthropic aliases or the user's `opencode.json` default. An explicit
  `--agent-model` / `agent.phases.*.model` still wins. Minimum version: **1.15.0**.
- **`harnessVersion` is captured at invocation time** and cached per
  process. After the process exits it is unrecoverable.
- **`--fallback-model` is not exposed.** A native fallback the pipeline
  cannot observe would compete with the failover of #69.
- **Provider health is durable.** `health.ts` persists it in the project-level
  `providers.json`; a restart during cooldown must not relearn the outage.
- **Failover is keyed by `FailureKind`, never by provider name.** `select.ts`
  applies `resolvePolicy()` to the primary's recorded failure, skips an open
  circuit, and hands exactly one invocation through `half_open`.
- **No provider available means waiting.** Selection waits for the shortest
  cooldown through the process abort signal; it does not turn cooldown into a
  failed invocation. Authentication stays blocked unless explicit policy
  permits failover.

## Gotchas

- Codex `item.type === 'error'` is a warning, not a failure. Skill-context
  notices arrive that way on successful runs. Failure is `turn.failed` or a
  top-level `error`.
- `$CODEX_HOME/config.toml` can escalate `--sandbox`. `ignoreUserConfig`
  is the CI recommendation; `init` warns when the escalating keys are present.
- `--setting-sources project` is the Claude equivalent of
  `--ignore-user-config`.
- A test that mocks `execa` wholesale must not trigger `probeAgent` or
  `ensureHarnessVersion` — those spawn `claude --version` / `codex --version`
  and steal the first mock call from the invocation under test.
  Antigravity's probe is `agy --version`; `authProbe: 'none'` means
  authentication is `unverified` and readiness is `conditional` — never
  reported as confirmed. Issue Flow may still attempt it when it is the only
  usable harness; the first real run confirms or the structured failover
  reacts.

## `hooks/`: agent state comes from the agent, not from its screen

The agent reports its own lifecycle through its harness's hook system
(ADR-05). Nothing in this repository parses a TUI to decide what an agent is
doing: a parser over a terminal produces a plausible, wrong answer, and it
breaks on every harness release.

- **`contract.ts`** is the four-type taxonomy and its parser. Four, not five:
  it is the complete set a harness hook can report, and inventing a fifth
  would mean inventing a producer for it. Correlation is `runId` + `phase`
  (the upstream this was ported from uses `worktreeId` + `branch`).
- **`agentctl.ts`** generates the helper the hooks invoke. It is a file rather
  than a call into the CLI because it runs on the hot path of every prompt and
  every tool call — a hook that costs a CLI boot is a hook the user feels.
- **`install.ts`** merges the hook groups. Two details carry the whole module:
  the merge **keeps groups that are not ours** (identified by command prefix,
  not by a marker key), and `resolveGitCommonDir()` puts `info/exclude` in the
  common git dir, which is the only place git reads it from inside a worktree.
- **`control-server.ts`** binds the endpoint in the process running the agent,
  not in the monitor. That is what makes lifecycle events work in `headless`
  with no server up (ADR-03). Loopback, bearer token, token never persisted.
- **`runtime.ts`** owns the lifetime: install, bind, publish credentials — and
  retract all three when the invocation ends, in that order, because the hook
  files live in the user's working tree.

### Never

- Never leave `control.env` behind. It is what makes a leftover hook a no-op:
  without it the helper exits immediately instead of waiting two seconds for
  an endpoint that is gone.
- Never let the helper exit non-zero. A non-zero `UserPromptSubmit` hook blocks
  the prompt in Claude Code, which would turn a monitoring hiccup into a broken
  run. Reporting on a turn may never be the reason one fails.
- Never apply an event whose `runId` is not the session in flight. Hooks
  outlive an invocation, and a stale one would move a live run's state on
  evidence from a dead one.
- Never make an invocation depend on any of this. Every failure path here
  returns "no reporting" and the run proceeds exactly as it did before phase 2
  of the WebMux absorption.

## `tty.ts` / `custom.ts`: the same agents, in a pane

`headless` spawns an agent and reads its structured stream. `interactive` runs
the same agent as the TUI a person would run, in a tmux pane. The invocation is
built the same way in both: **argv** (ADR-04).

- **The argv is serialized to a shell string exactly once**, at the tmux
  boundary, because `send-keys` accepts nothing else. That is not the same thing
  as assembling a command from strings: there is one quoting function, it is
  applied to every element without exception, and no caller ever hands it a
  pre-joined fragment. `tty.integration.test.ts` proves the round trip through a
  real `/bin/sh` for nine shapes of hostile prompt.
- **The prompt goes after `--`.** Not for quoting — it means the TUI takes it as
  its first turn, before its input loop starts, which is what avoids the
  paste/Enter race against a TUI that is not ready yet.
- **`codex` always gets `--enable hooks`.** Without it the lifecycle hooks never
  fire and the agent's state becomes unknowable (ADR-05).
- **Permission stays semantic.** The upstream has a `yolo` boolean; only
  `autonomous` maps to skipping permission here, and `read-only` still gets
  `--permission-mode plan`. Collapsing three levels into a boolean is on the
  §45.3 list of regressions to avoid.
- **A custom agent receives its context through exported environment
  variables**, never by substituting the values into the command. A prompt
  containing `'`, `$(…)` or a newline is then data the shell expands, not a
  fragment of the command line.

### Never

- Never build an agent command by concatenating strings.
- Never put the prompt anywhere but after `--` in a TTY invocation.
- Never reduce the three permission levels to a boolean.
