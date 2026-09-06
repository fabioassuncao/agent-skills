# src/runtime/sandbox

The container the `sandbox` mode runs an agent in: one container per branch,
started detached, driven by `docker exec` from a tmux pane.

Ported from WebMux `adapters/docker.ts` and `sandbox-image/`. The image itself
lives in [`packages/issue-flow/sandbox/`](../../../sandbox/README.md).

This is the **parity** half of the absorption (phase 12). Hardening — `--cap-drop`,
`no-new-privileges`, `--pids-limit`, `--memory`, a network policy and an opt-in
`SSH_AUTH_SOCK` — is phase 13, and ADR-12 forbids doing both in one change. A
test asserts that none of those flags is present, so adding one here fails
loudly rather than quietly changing what "parity" means.

## Invariants

- **`buildDockerRunArgs` is pure.** Every path check, environment read, uid,
  clock read and generated name is resolved by the caller and handed in through
  `DockerRunArgsContext`. That is what makes C7 (§34) a literal comparison of the
  argument list, and it is why the completion criterion of this phase can be
  verified on a machine with no docker installed. The upstream declares the same
  intent and then reads `Bun.env` from inside the function; `hostEnv` closes that
  leak.
- **The SSH socket is forwarded with `--mount type=bind`, never `-v`.** Docker's
  `-v` tries to `mkdir` the path it is given, and a socket path is not a
  directory, so the launch fails. This is the single most expensive line in the
  file to rediscover.
- **A socket is only forwarded when it is world-accessible.** The daemon is a
  separate process; a socket it cannot open produces a `docker run` that fails at
  mount time instead of an agent that cannot sign a commit.
- **`--user <hostUid>:<hostGid>`.** Files the agent creates in the mounted
  worktree and `.git` belong to the user, not to root. Dropping it leaves a
  worktree the user cannot clean up.
- **Published ports bind `127.0.0.1` only.** A dev server started inside a
  sandbox is never reachable from outside the machine. `0.0.0.0` appears nowhere
  and a test says so.
- **Reserved keys cannot be overridden.** `HOME`, `TERM`, `IS_SANDBOX`,
  `SSH_AUTH_SOCK` and the five `GIT_CONFIG_*` keys are written first and skipped
  by both passthrough loops. `SSH_AUTH_SOCK` is in the set because the variable
  is only meaningful together with the bind mount that backs it.
- **`GIT_CONFIG_COUNT=2` — `safe.directory` for *both* directories.** The
  worktree and the main repository. git refuses to operate on a checkout owned by
  another uid, and a worktree points at the main repository's `.git`, so one
  entry is not enough: with only the worktree registered every git command in the
  container fails on the object store.
- **A malformed key is dropped, never quoted around.** `isValidEnvKey` and
  `isValidPort` reject; the value is reported through `onWarn` and skipped. The
  container never receives a `-e` or `-p` this project could not validate.
- **`launchContainer` is idempotent per branch.** An already-running container
  for the branch is reused. Two containers on one worktree means two agents
  writing the same files.
- **Container names carry this project's prefix, `if-`.** Three characters, like
  the upstream's `wm-`, so the 46-character branch budget stays exact. It is
  deliberately *not* `wm-`: both listing paths select by prefix and force-remove
  what they find, so sharing the upstream's would let this project delete
  containers belonging to a real WebMux install on the same machine.
- **A listed name matches only when what follows the prefix is the timestamp.**
  Otherwise branch `main` adopts — and removes — the containers of `main-v2`.
- **Every `docker` call goes through `run()`** (`src/utils/shell.ts`), the only
  shell path of this project. Never `execa` directly, never a shell string.
- **"The daemon is down" is not "no container".** `findContainer` throws when
  `docker ps` fails, because answering `null` would make `launchContainer` start
  a second container for a branch that already has one.
- **A removal sweep does not stop at the first failure.** Each failure is
  reported; the rest still run. Aborting would strand every remaining container
  of that branch for good.

## The container does not know tmux exists

A pane runs `docker exec -it -w <worktree> <container> …`, and the web terminal
is the same path. Nothing in this directory knows about panes, and nothing about
panes knows about containers — which is what lets the same container be attached
from either.

## Never

- Never call `docker` outside `run()`.
- Never add a hardening flag here. It belongs to phase 13, where it arrives with
  its threat model and its own tests.
- Never publish a port on anything but `127.0.0.1`.
- Never mount the docker socket into the container. The upstream does not, and
  that is correct: it would hand the agent control of the host daemon.
- Never let `buildDockerRunArgs` read `process.env`, the clock, the filesystem or
  the uid. The moment it does, C7 stops being a literal comparison.
