# Sandbox runtime rules

This module owns Docker container creation, execution, inspection, and teardown
for worktree-bound agent sessions.

- Build arguments through the gateway; do not assemble `docker run` commands
  at call sites.
- Mount only the selected worktree and explicit profile mounts.
- Never mount host credentials implicitly.
- Keep `--cap-drop=ALL`, PID/memory limits, and
  `no-new-privileges` defaults aligned with `docs/sandbox-security.md`.
- `network: none` disables published ports.
- SSH agent forwarding is explicit and uses a bind mount.
- Container names are scoped to Issue Flow and validated before stop/remove.
- Teardown removes only a container whose exact project/worktree binding is
  proven.
- Docker errors include the command context without exposing credentials.

Validate argument construction, profile parsing, ownership guards, and both
sandbox image builds when these files change.
