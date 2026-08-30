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
- **`readonly capabilities` is the extension point** for a third runner
  (#76). Claude and Codex declare theirs; the core must not grow
  `if (provider === …)` chains.
- **`harnessVersion` is captured at invocation time** and cached per
  process. After the process exits it is unrecoverable.
- **`--fallback-model` is not exposed.** A native fallback the pipeline
  cannot observe would compete with the failover of #69.

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
