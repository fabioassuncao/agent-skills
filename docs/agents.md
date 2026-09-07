# CLI agents

[CLI guide](cli.md) · [Project overview](../README.md)

The Issue Flow CLI runs the pipeline through a coding agent. The default is
**Claude Code**. **Codex CLI** (`codex exec`), **Cursor CLI**
(`cursor-agent`), **Antigravity CLI** (`agy`) and **OpenCode CLI**
(`opencode`) are the alternatives.
Selection is explicit and, when you want it, **per phase**. The same
repository on two machines behaves the same way: the agent is never
inferred from which binary happens to be installed.

This document describes *this project's* behaviour. Official references:

- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
- [Codex security / sandbox](https://developers.openai.com/codex/security)
- [Codex authentication](https://developers.openai.com/codex/auth)
- [GitHub Action `openai/codex-action`](https://github.com/openai/codex-action)
- [Antigravity CLI](https://antigravity.google/docs/cli/getting-started/)
- [OpenCode CLI](https://opencode.ai/docs/cli)
- [OpenCode permissions](https://opencode.ai/docs/permissions)
- [OpenCode configuration](https://opencode.ai/docs/config)

Minimum Codex CLI version exercised here: **0.149.1**.
Minimum Antigravity CLI version exercised here: **1.1.22**.
Minimum OpenCode CLI version exercised here: **1.15.0**.

## Prerequisites

| Agent | Binary | Auth check | Typical install |
|-------|--------|------------|-----------------|
| Claude Code (default) | `claude` | delegated to Claude | `npm install -g @anthropic-ai/claude-code` |
| Codex CLI (opt-in) | `codex` | `codex login status` (exit 0 when authenticated) | see the official docs |
| Cursor CLI (opt-in) | `cursor-agent` | `cursor-agent status` (exit 0 even when logged out — probe is textual) | `curl https://cursor.com/install -fsS \| bash` |
| Antigravity CLI (opt-in) | `agy` | none — `issue-flow agent` reports install only | see [Antigravity install](https://antigravity.google/docs/cli/install/) |
| OpenCode CLI (opt-in) | `opencode` | textual `opencode auth list` (empty / no credentials is not authenticated) | see [OpenCode CLI](https://opencode.ai/docs/cli) |

Cursor has no `--add-dir`. The first `issue-flow agent use cursor` grants
`Read`/`Write` on `~/.issue-flow/**` in `~/.cursor/cli-config.json`. Cursor
reports neither tokens nor USD; a mixed run's cost total is incomplete by
construction. `--force` is required on every writing phase — without it Cursor
exits 0 and writes nothing. Minimum version: **2026.01.23**.

Antigravity always receives `--add-dir <workspace>`, `--dangerously-skip-permissions`
and `--disable-slash-commands`. There is no setting that removes them: without
skip-permissions a denied tool finishes `SUCCESS` and writes nothing. `--mode`
is the real write containment (`plan` for `read-only`, `accept-edits` otherwise).
`--print-timeout` is always present; `timeout: 0` uses `agent.antigravity.executeTimeout`
(default `4h`). `authProbe` is `none`: Issue Flow never reads `GEMINI_API_KEY`
and never writes `~/.gemini/antigravity-cli/settings.json`. Tokens are reported;
USD is not. Minimum version: **1.1.22**.

OpenCode runs `opencode run --format json --dir <workspace> --auto`. `--auto`
is not a sandbox: it only approves permissions that the run's explicit
`OPENCODE_PERMISSION` policy did not deny. That policy always denies
`question` and a wildcard `external_directory`; `read-only` also denies
`edit` and mutating `bash` patterns. Requested `addDirs` become
`external_directory` allows limited to those paths. The runner never writes
the user's `opencode.json`. Model ids are `provider/model`
(`--agent-phase review=opencode:opencode-go/qwen3.8-flash`). Tokens are
reported only when `step_finish` includes them; USD is not. `authProbe` is
textual: a listed provider is confirmed, an empty list is not. Listing
credentials does not prove the configured model is usable. Minimum version:
**1.15.0**.

`issue-flow init` verifies only the **selected** agent. A first-run prompt
appears only on a TTY, outside CI, and only when no `agent` configuration
exists. Active routing also suppresses it: the router owns the harness/model
choice per phase, so asking for one default agent would be misleading.
`--no-agent-prompt` skips it explicitly. Non-interactive runs never ask and
never write a preference.

## Authentication

### Local

Claude: the usual `claude` login / `ANTHROPIC_API_KEY`.

Codex: `codex login` (browser) or `codex login --with-api-key` (key on stdin).
`codex login status` is the programmatic probe.

Antigravity: log in through `agy` itself. Issue Flow does not probe
authentication and does not read, log or persist `GEMINI_API_KEY`.

OpenCode: `opencode auth login`. `opencode auth list` is the textual probe.
A listed provider is confirmed; an empty list or "no credentials" is not.
That list does not prove the configured `provider/model` is usable.

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
  < ISSUE_FLOW_AGENT / ISSUE_FLOW_AGENT_MODEL / ISSUE_FLOW_CODEX_* / ISSUE_FLOW_ANTIGRAVITY_* / ISSUE_FLOW_OPENCODE_*
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
npx issue-flow agent use opencode --model opencode-go/qwen3.8-flash --global
```

`--json` is a published contract (`schemaVersion` in the payload).
Agent selection here configures the CLI runtime. Portable Skills run in the
current agent and do not consult this setting or default to another provider.
See [Skill compatibility](skills-compatibility.md) for their installation and
invocation conventions.

## Permission

The invocation carries a semantic `permission`. Each runner translates it.
Claude `workspace` and `autonomous` keep the historical flags (byte-identical
argv with no config). `read-only` adds `--permission-mode plan` and a
deny-list, because `--allowedTools` alone does not restrict a subagent.

| `permission` | Phases | Claude | Codex | Cursor | Antigravity | OpenCode |
|---|---|---|---|---|---|---|
| `read-only` | analyze, review, pr-review | `--permission-mode plan` + deny-list | `--sandbox read-only` | `--mode plan` | `--mode plan` (+ skip-permissions) | `edit` deny + mutating `bash` deny + `--auto` |
| `workspace` | generate, prd, plan, pr | historical `runHeadless` argv | `--sandbox workspace-write` | `--force` | `--mode accept-edits` (+ skip-permissions) | `edit`/`bash` allow + `--auto` |
| `autonomous` | execute | `--dangerously-skip-permissions` | `--sandbox workspace-write` | `--force` | `--mode accept-edits` (+ skip-permissions) | `edit`/`bash` allow + `--auto` |

Codex `--sandbox` is **always** explicit. Codex `autonomous` stays inside the
workspace. `danger-full-access` is opt-in only and prints a warning every time.
`--dangerously-bypass-approvals-and-sandbox` and
`--dangerously-bypass-hook-trust` are not exposed.

`--sandbox` is **not** authoritative while `$CODEX_HOME/config.toml` can
escalate it (`approvals_reviewer`, `sandbox_mode`,
`sandbox_workspace_write.*`). `issue-flow init` warns when those keys are
present. `ignoreUserConfig: true` is the CI recommendation.

## Lifecycle hooks

An agent's state comes from the agent's own hooks, never from parsing its
terminal output. A TUI changes between releases, and a parser over one produces
an answer that is plausible and wrong — so no workflow decision here reads a
byte of the agent's screen.

Before each invocation the pipeline writes a small helper into the repository's
**git directory** (`.git/issue-flow/issue-flow-agentctl.mjs` — execution state
is never committed) and registers it as a hook in `.claude/settings.local.json`
and `.codex/hooks.json`. The helper reports to a loopback endpoint bound by the
process running the agent, authenticated with a token that exists only for that
invocation.

| Reported | Claude hook | Codex hook | Becomes |
|---|---|---|---|
| The agent started working | `UserPromptSubmit`, `PostToolUse` | `UserPromptSubmit`, `PreToolUse` | `agent:busy` |
| **The agent is blocked on a human** | `Notification` (`permission_prompt`, `elicitation_dialog`) | `PermissionRequest`, `SessionStart` | `agent:awaiting-input` + a warning in the log |
| The agent opened a pull request | `PostToolUse` on `Bash` | `PostToolUse` on `Bash` | `pr:opened`, folded into the run's pull request list |
| The agent finished its turn | `Stop` | `Stop` | nothing new — the end of the invocation already reports it |

The second row is the one that changes what you can see: before it, an agent
waiting on a permission prompt was indistinguishable from an agent still
thinking, including in `headless`, where nobody is watching a terminal. It shows
up in the dashboard, in `session.json` under `agent`, and in the run's log.

Every event is also written to the `agent_events` table, so a block that
happened while nothing was watching can still be looked up afterwards.

**What is left behind:** nothing that runs. The hook groups are removed when the
invocation ends, and the credentials file is deleted first — without it the
helper exits immediately, so even a hook left behind by a crashed run costs the
next `claude` session nothing. Hook groups you wrote yourself are never touched:
the merge replaces only groups whose command is the generated helper.

Set `agent.hooks.enabled` to `false` (or `ISSUE_FLOW_AGENT_HOOKS=0`) to install
nothing at all. Runs then behave exactly as they did before this existed —
`headless` never depends on it.

## The conversation channel

The terminal and the structured conversation are **two independent channels**
onto the same agent. The terminal carries bytes — it is what you see when you
attach to a pane. The conversation carries *messages*: a prompt, the paragraphs
the model wrote, the tools it called and what they returned. The dashboard's
chat panel reads the second one; nothing about it parses the first.

The conversation itself belongs to the provider, on disk under `~/.claude` or in
`codex`'s own thread store. This project never copies it. What it keeps is the
conversation's id, in `agent_sessions`, which is what `--resume` takes — so
reopening a worktree continues the conversation instead of paying for its
context again.

Reading it works in two directions:

- **A finished conversation** is read back from the provider's transcript. For
  Claude that is `~/.claude/projects/<encoded cwd>/<session id>.jsonl`; for
  Codex it is `codex app-server`, a long-lived process this project talks to
  over JSON-RPC for `thread/read`, `thread/list` and `turn/interrupt`. That
  daemon is a control channel, not a second way to run a phase: phases still run
  through `headless` or `interactive`, unchanged.
- **A conversation in flight** is read from the agent's own stream, message by
  message, as it is produced. There is no polling.

Every message carries an id that is stable across both routes, which is what
stops a paragraph the panel already streamed from being drawn a second time when
the transcript is read back.

### Forking a conversation into worktree tabs

`issue-flow tab create <branch>` creates another `AgentSession` in the same
managed worktree. The tab id is the Issue Flow session id; it is deliberately
separate from the provider conversation id. Codex uses its structured
app-server `thread/fork` operation. Claude starts a new pinned session from the
root conversation. No operation scans a provider transcript directory or
guesses a conversation from the current working directory.

Only Claude and Codex advertise a safely resumable native fork. Cursor,
Antigravity, OpenCode and custom agents are refused instead of approximating a
fork with an unrelated fresh conversation. The same applies to `review` and
`pr-review`: their methodological independence takes precedence over the tab
control. Tabs currently require the host runtime; sandbox worktrees keep their
single agent session.

Switching a tab preserves the live provider process. If its pane is gone,
`issue-flow worktree refresh <branch>` or selecting that orphan resumes its
exact conversation in a newly authenticated pane; it never implements the
upstream's destructive kill-and-recreate refresh.

### Exporting a conversation, and handing it to the next agent

A conversation can be written out as a JSON file — the messages plus the branch
and base it belongs to — and read back later to seed a new session with what the
previous one learnt.

That reseed is fenced and labelled, always. A conversation is text a **model**
wrote; pasting it into another agent's prompt as if it were instruction would let
anything a previous agent was talked into writing become an order to the next
one. The injected block is preceded by a notice that names it as data and is
wrapped in a `<prior-conversation>` fence, the same way a phase handoff is. Your
own text — an objective, an issue body — goes outside the fence, because that
half really is an instruction.

## Headless examples

```bash
# Default: Claude on every phase, same argv as before
npx issue-flow run 42

# Everything on Codex
npx issue-flow run 42 --agent codex

# Cheap plan, strong review, execute on a named Codex model
npx issue-flow run 42 \
  --agent-phase plan=codex \
  --agent-phase review=claude:claude-sonnet-5 \
  --agent-phase execute=codex:gpt-5.6

# OpenCode with an explicit provider/model
npx issue-flow run 42 --agent opencode --agent-model opencode-go/qwen3.8-flash

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

This table is executable policy in `src/routing/policy.ts`, backed by the
versioned model catalog in `src/routing/models.ts`. Affinity per phase is a
soft prior — never a hard pin that eliminates other installed harnesses.

When the harness is OpenCode, the catalog is the [OpenCode Go](https://opencode.ai/docs/pt-br/go/)
subscription — not Anthropic. `--agent opencode` without `--agent-model`
fills a Go model per phase so the run does not inherit `opencode.json`'s
Anthropic default. Intra-OpenCode choice lives in `src/routing/opencode-go.ts`:

| Role | Model | Phases |
|------|--------|--------|
| Cheap | `opencode-go/mimo-v2.5` | `analyze`; simple `generate` / economy `plan` |
| Default | `opencode-go/qwen3.8-flash` | `generate`, `prd`, `plan`, `execute`, first `review` |
| Coding cheap | `opencode-go/deepseek-v4-flash` | small `execute` / `pr` (`bugfix`, `test`); review fixes |
| Escalate | `opencode-go/gpt-5.6-luna` | high-risk `prd` / `plan` / `execute`; `pr-review` |
| Specialist | `opencode-go/kimi-k2.7-code` | only after Qwen/Luna fail (escalation or 4th correction) |

An explicit `agent.model` / `--agent-model` still wins. Kimi K3, Qwen Max and
other high-quota Go models stay pin-only.
When `routing.mode` is `recommend` or `active`, the router receives a readiness
inventory from `src/agents/availability.ts` (installed vs authentication vs
model access, with confidence and TTL) and ranks only what this machine can
actually attempt. Providers with `authProbe: 'none'` (Claude, Antigravity) stay
`conditional` / `unverified`, not confirmed. OpenCode's `auth list` can
confirm a credential without proving the configured model. It remains opt-in:

```bash
issue-flow routing use recommended --global
issue-flow routing use recommended --global --active
issue-flow routing explain
issue-flow agent --json
```

Set `routing.mode` to `recommend` to print the target without applying it, or
to `active` to apply it where the phase has no explicit `agent` selection.
In `active`, if the top ranked target becomes unavailable between decision and
invocation, the next ranked candidate is tried before falling back to the
original selection. The `--active` shortcut above persists both the recommended
policy and active mode for future runs.
The factory default remains `shadow`.

A homogeneous run (every phase on the same agent) prints the same `Tokens:`
line as before. A mixed run prints **one line per agent**. Codex,
Antigravity and OpenCode do not report USD: `costUsd` stays absent ("not reported", never
zero). Do not treat a mixed-run total that only shows Claude's dollars as the
cost of the run. Antigravity lets one credential cover Gemini Flash on
`plan`/`analyze` and a stronger model on `review`.

## Claude × Codex × Cursor × Antigravity × OpenCode (what this project uses)

| | Claude Code | Codex CLI | Cursor CLI | Antigravity CLI | OpenCode CLI |
|---|---|---|---|---|---|
| Invocation | `claude -p` / `--print` | `codex exec --json -` | `cursor-agent -p` | `agy -p` | `opencode run --format json` |
| Prompt | argv (`-p`) or stdin (`execute`) | always stdin (`-`) | argv | argv (`promptChannel: argv`) | argv (`promptChannel: argv`) |
| Structured output | `stream-json` | `--json` JSONL + `--output-last-message` | `stream-json` | `stream-json` | `--format json` JSONL |
| Per-tool allowlist | `--allowedTools` | none — OS sandbox only | none | none | none |
| Sandbox | `--permission-mode` / skip-permissions | `--sandbox` (Seatbelt / bubblewrap) | `--sandbox` opt-in | `--sandbox` opt-in | `OPENCODE_PERMISSION` + `--auto` |
| Extra directories | `--add-dir` | `--add-dir` | permission file | `--add-dir` (workspace always) | `external_directory` (requested paths only) |
| Turn cap | `--max-turns` | none — timeout is the cap | none | `--print-timeout` (always) | none — timeout is the cap |
| USD cost | `total_cost_usd` | not reported | not reported | not reported | not reported |
| Tokens | yes | yes | no | yes (`num_turns: 0` → `usage: null`) | only when `step_finish` reports them |
| Transient exit | `75` or text | text only | text | text | text |
| Auth probe | delegated | `codex login status` | textual `status` | **none** | textual `auth list` |

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
| Cost line empty | Codex / Antigravity / Cursor / OpenCode do not report USD | expected |
| Phase config seems ignored | a higher layer won | `issue-flow agent` shows provenance |
| Codex not installed, `provider: 'codex'` | missing binary | fails **before** the run, naming the phase |
| `agy` not installed | missing binary | fails as `configuration`, names the install URL |
| Antigravity `status: WAITING` | the task asked for a human | `configuration` — not success |
| Antigravity SUCCESS but no files | a tool was denied | treated as `configuration`; skip-permissions is invariant |
| Execute loop dies at 5 minutes on `agy` | `--print-timeout` omitted | Issue Flow always passes it; `timeout: 0` uses `executeTimeout` (default 4h) |
| `opencode` not installed | missing binary | fails as `configuration`, names the install URL |
| OpenCode hung on a permission prompt | `--auto` missing or `question` not denied | Issue Flow always passes both |
| OpenCode model rejected | bare alias such as `sonnet` | use `provider/model` (`opencode-go/qwen3.8-flash`) |
| OpenCode writes outside the workspace | user `opencode.json` enlarged `external_directory` | the run policy denies `*`; report a bug if a write still lands |

`item.type === 'error'` in the Codex stream is a **warning**, not a failure.
Skill-context notices arrive that way on successful runs. Failure is
`turn.failed` or a top-level `error`.
