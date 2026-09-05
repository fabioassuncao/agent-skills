# issue-flow

**Turn an issue into a reviewed Pull Request, without sitting in front of it.**

> ⚠️ **Experimental — under active development.** This project was built mostly
> with the help of AI coding agents and has not been audited. Expect bugs,
> incomplete implementations, regressions and possibly undiscovered security
> flaws. **Not recommended for real projects, production environments, critical
> systems or repositories with sensitive information** — today it is meant for
> testing, evaluation and disposable repositories. Keep backups, run it on a
> dedicated branch and review every change it produces. Token consumption is not
> optimized yet: a run may use significantly more tokens than necessary.
> Full notice:
> [**Project status**](https://github.com/fabioassuncao/issue-flow/blob/main/docs/project-status.md).

A CLI that orchestrates the whole path — analyse, plan, implement, verify,
review, deliver — by driving a coding agent in headless mode:
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) (the default),
[Codex CLI](https://developers.openai.com/codex/noninteractive), Cursor CLI or
[Antigravity CLI](https://antigravity.google/docs/cli/getting-started/), one
agent per phase if you want.

The CLI is one of Issue Flow's two independent surfaces. Eleven portable
[Agent Skills](https://github.com/fabioassuncao/issue-flow/blob/main/docs/skills-and-agents.md),
including the complete `resolve-issue` workflow, can be installed separately
and used directly in a compatible coding agent without this npm package.

```bash
npx issue-flow init           # check prerequisites and repository conventions
npx issue-flow run 42         # prd → plan → execute → review → pr
npx issue-flow run 42 --web   # …and watch it live at http://localhost:3737
```

> **Full documentation lives in the repository:**
> [README](https://github.com/fabioassuncao/issue-flow#readme) ·
> [Commands](https://github.com/fabioassuncao/issue-flow/blob/main/docs/commands.md) ·
> [Configuration](https://github.com/fabioassuncao/issue-flow/blob/main/docs/configuration.md) ·
> [Agents](https://github.com/fabioassuncao/issue-flow/blob/main/docs/agents.md) ·
> [Agent Skills](https://github.com/fabioassuncao/issue-flow/blob/main/docs/skills-and-agents.md) ·
> [Skill compatibility](https://github.com/fabioassuncao/issue-flow/blob/main/docs/skills-compatibility.md) ·
> [Storage](https://github.com/fabioassuncao/issue-flow/blob/main/docs/storage.md) ·
> [Web monitoring](https://github.com/fabioassuncao/issue-flow/blob/main/docs/web-monitor.md) ·
> [Resilience](https://github.com/fabioassuncao/issue-flow/blob/main/docs/resilience.md) ·
> [Project status](https://github.com/fabioassuncao/issue-flow/blob/main/docs/project-status.md)

## Requirements

For this CLI package:

- **Node.js** ≥ 22.13.0
- **Git**, available in `PATH`, inside a repository
- **A coding agent** — `npm install -g @anthropic-ai/claude-code` for the default
- **GitHub CLI** (`gh`), authenticated — only for GitHub issues; a run on local
  issues does not need it

## Agent Skills

Install from the consumer project using Vercel Skills:

```bash
npx skills add fabioassuncao/issue-flow --list
npx skills add fabioassuncao/issue-flow --skill resolve-issue -a codex
```

The selected Skill includes its references and bundled helpers. Installing the
CLI does not install Skills, and neither surface needs the other. Skills may
optionally use an installed CLI for repository policy discovery. See the
[installation and usage guide](https://github.com/fabioassuncao/issue-flow/blob/main/docs/skills-and-agents.md)
for individual/set/global installation, requirements, updates and local checkout
testing before a revision is published to GitHub.

## What the CLI does

- The full pipeline `prd` → `plan` → `execute` → `review` → `pr`, plus an
  optional whole-PR review. Every phase is also a standalone command.
- An iterative execute loop: each iteration is a fresh agent instance that picks
  the highest-priority pending user story, implements it, runs quality checks and
  commits.
- An objective acceptance contract (typecheck, lint, tests) before the LLM
  judges. An empty contract finishes `unverified`, never green.
- Per-phase agent selection, resolved explicitly and never inferred from which
  binary happens to be installed.
- Resilience for long unattended runs: a failure taxonomy, per-kind retry
  budgets, provider failover with circuit breakers, an inactivity watchdog and an
  append-only event journal.
- Multi-issue queues discovered from sub-issues and dependencies: one branch, one
  Pull Request.
- A read-only live web monitor, one card per active run across every project.
- Issues from GitHub or from plain files — the local provider needs nothing
  beyond git.
- Repository conventions (templates, labels, base branch, commit and branch
  format) discovered rather than imposed.

## Commands

| Command | What it does |
|---------|--------------|
| `run <issues...>` | The full pipeline, for one issue or a queue |
| `resume [issue]` | Continue an interrupted pipeline, explicitly |
| `generate` | Draft and create an issue on GitHub, locally, or both |
| `init` | Check prerequisites and report (or create) missing conventions |
| `analyze`, `prd`, `plan`, `execute`, `review`, `pr`, `pr-review` | The phases, standalone |
| `status`, `ps`, `runs`, `history`, `logs`, `usage`, `pause`, `cancel` | Operate a running pipeline |
| `agent`, `policy`, `conventions`, `routing` | Inspect what was resolved, and why |
| `web serve`, `web stop` | The monitoring server |

Run `issue-flow <command> --help` for the flags, or read the
[command reference](https://github.com/fabioassuncao/issue-flow/blob/main/docs/commands.md).

## Where things are written

CLI pipeline artifacts live in a machine-wide tree keyed by a deterministic
project id; implementation changes are still written to your repository:

```
~/.issue-flow/projects/<project-id>/issues/42/
  prd.md   tasks.json   progress.txt   session.json   events.jsonl   pr-review/
```

`ISSUE_FLOW_HOME` relocates the whole tree. A legacy `<projectRoot>/issues/`
directory from an earlier release is copied in automatically on first use and
then left read-only.

Skills default to `<projectRoot>/issues/<id>/` and have separate execution state.
A run cannot be resumed across the CLI and Skill surfaces.

## Configuration

Everything resolves through **CLI flag > environment variable >
`.issue-flow.json` > `~/.issue-flow/config.json` > default**. Nothing is
mandatory. See the
[configuration reference](https://github.com/fabioassuncao/issue-flow/blob/main/docs/configuration.md).

## Development

```bash
npm install
npm run skills:check # check committed Skills and prompts against their sources
npm run build       # tsup → dist/
npm run typecheck
npm test
npm run smoke       # end-to-end, against deterministic stand-ins for claude and gh
npm run check       # biome + typecheck
```

See [CONTRIBUTING.md](https://github.com/fabioassuncao/issue-flow/blob/main/packages/issue-flow/CONTRIBUTING.md) for the full setup and the release
process. These development commands require a repository checkout. For Skill
and prompt changes, follow the
[source, sync and validation guide](https://github.com/fabioassuncao/issue-flow/blob/main/docs/skills.md).

## Credits

Based on [Geoffrey Huntley's Ralph pattern](https://ghuntley.com/ralph/) and the
[snarktank/ralph](https://github.com/snarktank/ralph) repository.

## License

[MIT](LICENSE)
