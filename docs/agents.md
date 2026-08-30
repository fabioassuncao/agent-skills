# Agents

Issue Flow runs the pipeline through a coding agent. The default is
**Claude Code**. **Codex CLI** (`codex exec`) is the alternative. Selection is
explicit and, when you want it, **per phase**. The same repository on two
machines behaves the same way: the agent is never inferred from which binary
happens to be installed.

This document describes *this project's* behaviour. Official references:

- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
- [Codex security / sandbox](https://developers.openai.com/codex/security)
- [Codex authentication](https://developers.openai.com/codex/auth)
- [GitHub Action `openai/codex-action`](https://github.com/openai/codex-action)

Minimum Codex CLI version exercised here: **0.149.1**.

## Prerequisites

| Agent | Binary | Auth check | Typical install |
|-------|--------|------------|-----------------|
| Claude Code (default) | `claude` | delegated to Claude | `npm install -g @anthropic-ai/claude-code` |
| Codex CLI (opt-in) | `codex` | `codex login status` (exit 0 when authenticated) | see the official docs |

`issue-flow init` verifies only the **selected** agent. A first-run prompt
appears only on a TTY, outside CI, and only when no `agent` configuration
exists. `--no-agent-prompt` skips it. Non-interactive runs never ask and never
write a preference.

## Authentication

### Local

Claude: the usual `claude` login / `ANTHROPIC_API_KEY`.

Codex: `codex login` (browser) or `codex login --with-api-key` (key on stdin).
`codex login status` is the programmatic probe.

### CI / Docker / GitHub Actions

Do **not** rely on the browser OAuth callback (`localhost:1455`). Use an API
key or access token:

```bash
export CODEX_API_KEY=...          # recommended for CI
# or: printf '%s' "$CODEX_API_KEY" | codex login --with-api-key
```

On GitHub Actions, [`openai/codex-action`](https://github.com/openai/codex-action)
is the supported path. Tokens from a ChatGPT plan can expire mid-run; an API
key does not.

Isolate user config so a local `config.toml` cannot escalate the sandbox:

```json
{
  "agent": {
    "codex": { "ignoreUserConfig": true },
    "claude": { "ignoreUserConfig": true }
  }
}
```

Claude's equivalent of `--ignore-user-config` is `--setting-sources project`.
Both are off by default (so a machine-wide model/MCP setup still applies) and
recommended on for CI.

## Selection

```text
default (claude)
  < ~/.issue-flow/config.json
  < .issue-flow.json
  < ISSUE_FLOW_AGENT / ISSUE_FLOW_AGENT_MODEL / ISSUE_FLOW_CODEX_*
  < --agent-phase (repeatable)
  < --agent / --agent-model   ← emergency: overwrites phases too
```

There are no per-phase environment variables. Fine-grained CI uses
`.issue-flow.json`.

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

A phase override is **partial**: only `model` keeps the provider. `phases` merge
key by key, so a project's `phases.plan` does not erase a global
`phases.execute`. `issue-flow agent` prints the provenance of each value.

```bash
npx issue-flow agent
npx issue-flow agent --json
npx issue-flow agent use codex --model gpt-5.6 --global
npx issue-flow agent use claude --project
npx issue-flow agent use codex --phase execute --project
```

`--json` is a published contract (`schemaVersion` in the payload). Skills read
it via [`skills/_shared/agent-config.md`](../skills/_shared/agent-config.md).

## Permission

The invocation carries a semantic `permission`. Each runner translates it.
Claude `workspace` and `autonomous` keep the historical flags (byte-identical
argv with no config). `read-only` adds `--permission-mode plan` and a
deny-list, because `--allowedTools` alone does not restrict a subagent.

| `permission` | Phases | Claude | Codex |
|---|---|---|---|
| `read-only` | analyze, review, pr-review | `--permission-mode plan` + deny-list | `--sandbox read-only` |
| `workspace` | generate, prd, plan, pr | historical `runHeadless` argv | `--sandbox workspace-write` |
| `autonomous` | execute | `--dangerously-skip-permissions` | `--sandbox workspace-write` |

Codex `--sandbox` is **always** explicit. Codex `autonomous` stays inside the
workspace. `danger-full-access` is opt-in only and prints a warning every time.
`--dangerously-bypass-approvals-and-sandbox` and
`--dangerously-bypass-hook-trust` are not exposed.

`--sandbox` is **not** authoritative while `$CODEX_HOME/config.toml` can
escalate it (`approvals_reviewer`, `sandbox_mode`,
`sandbox_workspace_write.*`). `issue-flow init` warns when those keys are
present. `ignoreUserConfig: true` is the CI recommendation.

## Headless examples

```bash
# Default: Claude, eight phases, same argv as before
npx issue-flow run 42

# Everything on Codex
npx issue-flow run 42 --agent codex

# Cheap plan, strong review, execute on a named Codex model
npx issue-flow run 42 \
  --agent-phase plan=codex \
  --agent-phase review=claude:claude-sonnet-5 \
  --agent-phase execute=codex:gpt-5.6

# CI: isolate user config
ISSUE_FLOW_CODEX_IGNORE_USER_CONFIG=1 npx issue-flow run 42 --agent codex
```

No TTY, no prompt, no approval dialog. Codex reads the prompt on stdin (`-`)
so a large PRD cannot hit `ARG_MAX`.

### GitHub Actions sketch

```yaml
- uses: openai/codex-action@v1
  with:
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
- run: npx issue-flow run ${{ github.event.issue.number }} --agent codex
  env:
    ISSUE_FLOW_CODEX_IGNORE_USER_CONFIG: "1"
```

## Token economy

| Phase | Nature | Suggestion |
|-------|--------|------------|
| `plan` | mechanical PRD → JSON | cheapest model / lowest effort — best gain, lowest risk |
| `analyze` | read and classify | smaller model; Codex `--sandbox read-only` |
| `review`, `pr-review` | judgement on finished code | stronger model; read-only |
| `execute` | the only iterative loop; most of the spend | the phase worth configuring first |
| `prd`, `generate`, `pr` | structured writing | mid-tier model |

A homogeneous run (every phase on the same agent) prints the same `Tokens:`
line as before. A mixed run prints **one line per agent**. Codex does not
report USD: `costUsd` stays absent ("not reported", never zero). Do not treat
a mixed-run total that only shows Claude's dollars as the cost of the run.

## Claude × Codex (what this project uses)

| | Claude Code | Codex CLI |
|---|---|---|
| Invocation | `claude -p` / `--print` | `codex exec --json -` |
| Prompt | argv (`-p`) or stdin (`execute`) | always stdin (`-`) |
| Structured output | `stream-json` | `--json` JSONL + `--output-last-message` |
| Per-tool allowlist | `--allowedTools` | none — OS sandbox only |
| Sandbox | `--permission-mode` / skip-permissions | `--sandbox` (Seatbelt / bubblewrap) |
| Turn cap | `--max-turns` | none — timeout is the cap |
| USD cost | `total_cost_usd` | not reported |
| Transient exit | `75` or text | text only |
| Auth probe | delegated | `codex login status` |

Where there is no equivalent, nothing is invented: `allowedTools` / `maxTurns`
are ignored by Codex; `--sandbox` is ignored by Claude.

## Troubleshooting

| Symptom | Cause | What to do |
|---------|-------|------------|
| `Not inside a trusted directory` | outside a Git repo | run inside the repo, or `skipGitRepoCheck` |
| Hang with no output | stdin left open | the runners always pass `input:` or `stdin: 'ignore'` — file a bug if you see this |
| Writes under `read-only` | `$CODEX_HOME/config.toml` escalating | `ignoreUserConfig: true` |
| Auth error in CI | browser OAuth | `CODEX_API_KEY` or `codex login --with-api-key` |
| Network command fails in a container | sandbox network | `codex.configOverrides` → `sandbox_workspace_write.network_access` |
| Cost line empty | Codex does not report USD | expected |
| Phase config seems ignored | a higher layer won | `issue-flow agent` shows provenance |
| Codex not installed, `provider: 'codex'` | missing binary | fails **before** the run, naming the phase |

`item.type === 'error'` in the Codex stream is a **warning**, not a failure.
Skill-context notices arrive that way on successful runs. Failure is
`turn.failed` or a top-level `error`.
