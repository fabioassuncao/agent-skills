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
  absent. Model ids are `provider/model`. Minimum version: **1.15.0**.
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
