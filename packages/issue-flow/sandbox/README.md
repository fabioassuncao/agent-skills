# The sandbox image

The container image the `sandbox` runtime mode runs agents in. Ported from
WebMux `sandbox-image/` @ d8c9d5f.

## Build

```bash
cd packages/issue-flow/sandbox
docker build -f Dockerfile.sandbox -t issue-flow-sandbox:latest .
```

The build context is this directory, because `Dockerfile.sandbox` copies
`entrypoint.sh` out of it. The build pulls a Rust toolchain, Chromium and the
AWS CLI, so budget several minutes and a few gigabytes.

Name the resulting tag in the docker profile's `image`; nothing here assumes a
default, exactly as upstream.

## What is inside

`debian:bookworm-slim` plus Node.js 22, the GitHub CLI, a Rust toolchain,
`asciinema`, Bun, Playwright with Chromium, the AWS CLI, Claude Code, Codex and
the Mermaid CLI.

Bun is a tool available **inside** the sandbox, for the repositories an agent
works on. It is not this project's runtime — ADR-01 discards it as such.

## How the container is used

The container is started detached, running `sleep infinity`, and never learns
that tmux exists. A tmux pane runs:

```text
docker exec -it -w <worktree> <container> /bin/sh -c '<command>'
```

The web terminal is exactly the same path. `entrypoint.sh` is copied in but
**not** set as the image entrypoint: it is invoked explicitly, runs
`bun install` when the working directory has a `bun.lock`, and then `exec "$@"`.

## Deliberate non-goals, for now

This is the parity port (phase 12). The image is deliberately the upstream's,
including its size: a minimal default image with the current one kept as `full`
is part of the hardening step (§14, stage 2), together with `--cap-drop`,
`no-new-privileges`, resource limits and a network policy on the container
itself.

The container runs as the host user with the worktree mounted. That is by
design, and it is **not** isolation against malicious code — it isolates
dependencies and the filesystem blast radius, not privileges.

## Divergence from the upstream

| What | Why |
|---|---|
| The AWS CLI archive name is derived from `dpkg --print-architecture` instead of being hardcoded to `x86_64` | The upstream line fails the whole build on an arm64 host, which is most development machines this project runs on. Smallest change that makes the port buildable |

`entrypoint.sh` installs dependencies only for `bun.lock`. Recognising
`package-lock.json` and `pnpm-lock.yaml` is an obvious improvement for this
project's target repositories, and is deliberately **not** in this phase: parity
first (ADR-12). It is recorded in `docs/absorption-trace.md`.
