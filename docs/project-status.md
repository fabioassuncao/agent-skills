# Project status — experimental

> [!WARNING]
> **Issue Flow is experimental and under active development.** It works, and it
> is not finished. Read this page before pointing it at a repository you care
> about.

This document is the canonical version of the notice; the README and the CLI
link back to it.

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
  than usual here, because of what the tool is allowed to do: it drives a coding
  agent with **write access to your working tree**, runs commands declared by the
  repository (the [acceptance contract](verification.md#the-acceptance-contract)
  and your quality checks), and talks to GitHub through `gh` using **your
  credentials**. A defect in that path is a defect with reach.

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
- **Run it on a dedicated branch**, never directly on `main`. Issue Flow creates
  its own branch by default — keep it that way.
- **Review every change it produces** before merging: the diff, the commits, the
  Pull Request. The acceptance contract and the review phase raise the floor;
  they do not replace you reading the code.
- **Watch the first runs.** `--web` gives you a live view; `--background` and
  `--continuous` are for when you already trust a given setup.
- **Check out repositories without secrets** where you can, and assume anything
  in the working tree is visible to the agent.

## Token consumption

**Token efficiency is still being improved.** Depending on the task, the model,
the harness and the flow being executed, a run can consume significantly more
tokens than it needs to.

Cost optimization, model selection, context usage and the balance between
quality, speed and token consumption are part of the roadmap, not of the current
guarantees. Today, the honest advice is to watch the reported usage — per phase
and per story, in the terminal summary and in the
[web monitor](web-monitor.md) — and to treat the numbers from your first runs as
the real cost estimate for your repository.

Related knobs that already exist: [agent selection per phase](agents.md), the
token economy notes in that same document, and the
[shadow router](verification.md#shadow-routing), which reports a harness/model
target without acting on it.

## What this notice is not

None of this means the tool is unusable — it is used to develop itself, and the
pipeline it describes is real. It means the project is early: the limitations
above describe the **current stage of maturity**, and they are what the roadmap
is aimed at. Expect them to shrink, and expect this page to be updated when they
do.

Known behavioural limits that are not about maturity — design decisions and
sharp edges worth knowing — are listed under
[Limitations and things worth knowing](../README.md#limitations-and-things-worth-knowing).
