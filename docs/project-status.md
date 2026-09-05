# Project status — experimental

> [!WARNING]
> **Issue Flow is experimental and under active development.** It works, and it
> is not finished. Read this page before pointing it at a repository you care
> about.

This document is the canonical notice for the **whole project**, including
Agent Skills and the CLI. [Agent Skills](../skills/README.md) are the recommended
starting point among the available interfaces. That recommendation does not
declare them stable or production-ready. The [CLI](cli.md) is an experimental
alternative for persistent, unattended orchestration.

## How it was built

Issue Flow was developed **mostly with the help of AI coding agents** — Claude
Code and Codex among them — under human review. That is also, deliberately, what
the tool itself does. It shapes what you should expect from it:

- **Bugs, unexpected behaviour, incomplete implementations and regressions are
  likely.** Areas that look finished may only be finished for the paths that were
  exercised. A feature described in the documentation may behave differently at
  an edge the tests never reached.
- **There is a real possibility of undiscovered vulnerabilities or security
  flaws.** No independent security audit has been performed. This matters more
  than usual here: an agent using the workflow may have **write access to your
  working tree**, run repository commands and access GitHub using **your
  credentials**. Skills use the current host's tools and permissions; the CLI
  invokes agent processes, repository acceptance checks and `gh`. A defect in
  either path can affect the repository.

## Where not to use it yet

At this stage we **do not recommend** running Issue Flow on:

- real projects and codebases you depend on;
- production environments;
- critical systems;
- repositories that contain sensitive information — credentials, customer data,
  private keys, anything you would not want an autonomous agent to read, commit
  or push.

## Where it is a good fit today

- Testing, experimentation and evaluating whether the approach fits your work.
- Disposable projects, sandboxes, scratch repositories and forks.
- Anything you can throw away or restore in a minute.

## Using it with a safety net

If you do run it, the usual precautions are not optional here:

- **Keep backups**, and prefer a repository you can restore from a remote.
- **Implement on a dedicated branch**, never directly on `main`. Inspect the
  branch selected by the workflow before execution.
- **Review every change it produces** before merging: the diff, the commits, the
  Pull Request. Repository checks and automated reviews do not replace you
  reading the code.
- **Watch the first runs.** With Skills, inspect the plan and the host's actions.
  For CLI experiments, use the [monitoring guide](cli.md#monitor-and-resume-a-run)
  before evaluating unattended execution.
- **Check out repositories without secrets** where you can, and assume anything
  in the working tree is visible to the agent.

## Token consumption

**Token efficiency is still being improved.** Depending on the task, the model,
the harness and the flow being executed, a run can consume significantly more
tokens than it needs to.

Cost optimization, model selection, context usage and the balance between
quality, speed and token consumption are part of the roadmap, not of the current
guarantees. Monitor usage in your host when using Skills. For the CLI, use its
[usage reporting](storage.md#tokens-and-cost) and [web monitor](web-monitor.md).
Treat the numbers from your first runs as the real cost estimate for your
repository; Skill use does not provide the CLI's telemetry.

CLI-specific controls include [agent selection per phase](agents.md), the
token economy notes in that document, and the
[shadow router](verification.md#shadow-routing), which reports a harness/model
target without acting on it.

## What this notice is not

None of this means the tool is unusable — it is used to develop itself, and the
pipeline it describes is real. It means the project is early: the limitations
above describe the **current stage of maturity**, and they are what the roadmap
is aimed at. Expect them to shrink, and expect this page to be updated when they
do.

Known behavioural limits that are not about maturity — design decisions and
sharp edges worth knowing — are documented separately for
[Skills](../skills/README.md#artifacts-resumption-and-limits) and
[the CLI](cli.md#known-limitations).
