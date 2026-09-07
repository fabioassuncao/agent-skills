# The sandbox image

The container image the `sandbox` runtime mode runs agents in. Ported from
WebMux `sandbox-image/` @ d8c9d5f and split in two by phase 13.

The security model of the launch — what the container is and is not protected
against, and every flag that makes the difference — is
[`docs/sandbox-security.md`](../../../docs/sandbox-security.md).

## The two images

| File | What it holds | When |
|---|---|---|
| `Dockerfile.sandbox` | The **default**. A shell, git, the GitHub CLI, Node.js 22, a C toolchain for native npm modules, Claude Code and Codex | Everything the pipeline does |
| `Dockerfile.sandbox.full` | The upstream's image, verbatim: the above plus Rust, `asciinema`, Bun, Playwright with Chromium, the AWS CLI and the Mermaid CLI | Repositories that need one of those |

§14 asks for "a minimal image as the default, the current one as `full`". The
threat is surface, not privilege: every extra runtime, package manager and
download endpoint in an image is another thing whose compromise reaches the
mounted worktree. `build-essential` stays in both, because dropping it would
break `npm ci` on any repository with a native dependency — that is a
regression, not a hardening.

Bun is a tool available **inside** the full image, for the repositories an agent
works on. It is not this project's runtime — ADR-01 discards it as such.

## Build

```bash
cd packages/issue-flow/sandbox

# the default
docker build -f Dockerfile.sandbox -t issue-flow-sandbox:latest .

# the full one, when a repository needs Rust, Chromium or the AWS CLI
docker build -f Dockerfile.sandbox.full -t issue-flow-sandbox:full .
```

The build context is this directory, because both files copy `entrypoint.sh` out
of it. The full image pulls a Rust toolchain, Chromium and the AWS CLI, so budget
several minutes and a few gigabytes; the default is a fraction of that.

Name the resulting tag in the docker profile's `image`; nothing here assumes a
default, exactly as upstream.

## No sudo in the default image

The container is launched with `--security-opt no-new-privileges`, which makes
every setuid binary inert — `sudo` included. A sudoers entry that cannot work
turns a clear failure into a confusing one, so the default image has neither.

The consequence is deliberate: an agent cannot install a missing tool at
runtime. Add it to the image, or use the full one. The full image keeps the
upstream's sudo grant because parity is what that file is for, and it is inert
there too.

## How the container is used

The container is started detached, running `sleep infinity`, and never learns
that tmux exists. A tmux pane runs:

```text
docker exec -it -w <worktree> <container> /bin/sh -c '<command>'
```

The web terminal is exactly the same path. `entrypoint.sh` is copied in but
**not** set as the image entrypoint: it is invoked explicitly, runs
`bun install` when the working directory has a `bun.lock`, and then `exec "$@"`.
In the default image there is no Bun, so the guarded install is a no-op — which
is why it was already written as `|| true`.

## Divergence from the upstream

| What | Why |
|---|---|
| The default image is minimal; the upstream's is `Dockerfile.sandbox.full` | §14 stage 2, phase 13 |
| The default image installs no `sudo` | `no-new-privileges` makes it inert; a sudoers entry that cannot work is worse than none |
| The AWS CLI archive name is derived from `dpkg --print-architecture` instead of being hardcoded to `x86_64` | The upstream line fails the whole build on an arm64 host, which is most development machines this project runs on. Smallest change that makes the port buildable (phase 12) |

`entrypoint.sh` installs dependencies only for `bun.lock`. Recognising
`package-lock.json` and `pnpm-lock.yaml` is an obvious improvement for this
project's target repositories, and remains deliberately out of scope: phase 12
was parity (ADR-12) and phase 13 is the §14 threat model, which this is not part
of. It is recorded in `docs/absorption-trace.md`.
