# Sandbox images

These images support the `sandbox` runtime. The launch security model and
profile controls are documented in
[`docs/sandbox-security.md`](../../../docs/sandbox-security.md).

## Images

| File | Contents | Use |
|---|---|---|
| `Dockerfile.sandbox` | Shell, Git, GitHub CLI, Node.js 22, native build tools, Claude Code and Codex | Default pipeline work |
| `Dockerfile.sandbox.full` | Default tools plus Rust, Bun, Playwright/Chromium, AWS CLI, Mermaid CLI and recording tools | Repositories that explicitly need those tools |

The default image omits `sudo`; `no-new-privileges` makes setuid elevation
ineffective. Add required build tools to an image instead of installing them at
runtime.

## Build

```bash
cd packages/issue-flow/sandbox
docker build -f Dockerfile.sandbox -t issue-flow-sandbox:latest .
docker build -f Dockerfile.sandbox.full -t issue-flow-sandbox:full .
```

The full image downloads substantially more data and takes longer to build.
Set the resulting tag in the selected Docker runtime profile's `image` field.

## Runtime

The launcher starts the container detached with `sleep infinity`. Agent and
terminal panes enter it with `docker exec` in the selected worktree. The
worktree and any additional profile mounts are the only host paths exposed by
the launcher.

`entrypoint.sh` is available for explicit use by image consumers. It checks for
a Bun lockfile before attempting `bun install`, then executes the requested
command.
