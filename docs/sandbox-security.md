# Sandbox security

The `sandbox` runtime isolates an agent in Docker while keeping the selected
worktree available for implementation. It reduces host exposure; it is not a
security boundary against the Docker daemon, kernel vulnerabilities, malicious
dependencies, or credentials explicitly mounted into the container.

## Launch posture

Every container starts with:

- `--cap-drop=ALL`;
- `--security-opt no-new-privileges` unless the profile explicitly disables it;
- a PID limit of `2048` by default;
- a memory limit derived from 75% of host memory by default;
- `--network bridge` by default, or `none` when selected;
- only the selected worktree and explicit profile mounts;
- no implicit agent, SSH, Git, or GitHub credential directories.

The container runs as the image user and stays detached while tmux panes enter
it through `docker exec`. Teardown is scoped to the container created for the
bound worktree.

## Credentials and mounts

Profile mounts are explicit:

```json
{
  "runtime": {
    "profiles": {
      "sandbox": {
        "runtime": "docker",
        "image": "issue-flow-sandbox:latest",
        "mounts": [
          {
            "hostPath": "/absolute/host/path",
            "guestPath": "/workspace/data",
            "writable": false
          }
        ]
      }
    }
  }
}
```

Read-only is the default for additional mounts. Relative paths and unresolved
environment variables must not be used for security-sensitive mounts.

`SSH_AUTH_SOCK` is opt-in through `security.sshAgent`. The socket grants access
to the host agent for the lifetime of the container, so enable it only for a
profile that requires authenticated Git operations.

## Profile controls

`runtime.profiles.<name>.security` accepts:

| Key | Values | Default |
|---|---|---|
| `network` | `bridge` or `none` | `bridge` |
| `pidsLimit` | non-negative integer; `0` omits the flag | `2048` |
| `memory` | Docker size string; `0` omits the flag | 75% of host RAM |
| `capAdd` | capability names | `[]` |
| `noNewPrivileges` | boolean | `true` |
| `sshAgent` | boolean | `false` |

`network: "none"` also disables published ports. Unknown or malformed fields
are ignored and retain the hardened defaults.

## Images

`packages/issue-flow/sandbox/Dockerfile.sandbox` is the default image and
contains the shell, Git, GitHub CLI, Node.js, native build tools, Claude Code,
and Codex. `Dockerfile.sandbox.full` additionally contains Rust, Bun,
Playwright/Chromium, AWS CLI, Mermaid CLI, and recording utilities for
repositories that explicitly need them.

Build commands are documented in
[`packages/issue-flow/sandbox/README.md`](../packages/issue-flow/sandbox/README.md).

## Operational limits

- `network: none` prevents normal package downloads and remote Git operations.
- `no-new-privileges` makes setuid tools such as `sudo` ineffective.
- Additional writable mounts expand the data an agent can modify.
- The full image has a larger dependency and attack surface than the default.
- Docker socket mounts are outside the supported profile and would defeat the
  intended isolation.
