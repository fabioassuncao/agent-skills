# src/runtime/sandbox

The container the `sandbox` mode runs an agent in: one container per branch,
started detached, driven by `docker exec` from a tmux pane.

Ported from WebMux `adapters/docker.ts` and `sandbox-image/`. The image itself
lives in [`packages/issue-flow/sandbox/`](../../../sandbox/README.md).

Phase 12 ported it for parity; phase 13 hardened it against the threat model of
§14. Both are done, and the security model they produced is documented in
[`docs/sandbox-security.md`](../../../../../docs/sandbox-security.md) — read that
before changing any flag below.

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

## Security invariants (phase 13)

These are additions. Nothing above them was relaxed to make room.

- **The container is not a boundary against malicious code, and no flag here
  makes it one.** It runs as the host user with the worktree and `.git` mounted
  read-write; anything inside already has the user's access to them. What the
  flags below shrink is what a *runaway or compromised* process can do to the
  machine. Never describe this directory as isolation from the host.
- **Every launch carries the hardening, whether or not a profile asks.**
  `--cap-drop=ALL`, `--security-opt no-new-privileges:true`, `--pids-limit`,
  `--memory` and an explicit `--network`, emitted as one block right after
  `--user`. A profile can widen a specific one; nothing turns the block off.
- **`--cap-drop=ALL` costs the sandbox nothing.** The container is already an
  unprivileged uid, so the capability set was never what made writes to the
  worktree work — `--user` is. Anything claiming to need a capability names it
  in `security.capAdd`, and the name is validated before it becomes a flag.
- **`no-new-privileges` is what makes `--cap-drop` hold**, and it is why the
  default image ships no `sudo`. An agent cannot install a tool at runtime; the
  tool goes in the image. Do not "fix" this by re-adding sudo.
- **`--memory` is a share of the host, never a fixed number.** A constant is
  wrong on every machine but one, and a limit below what a legitimate build
  needs is a regression wearing a security flag.
- **`--network none` drops published ports.** Docker refuses `--network none`
  together with `-p`, so an isolated profile that declared a service would fail
  to launch at all. The ports go, with a warning; the isolation stays.
- **`SSH_AUTH_SOCK` is opt-in.** The socket signs for every repository and host
  the key reaches, not just this worktree. The upstream forwards it whenever it
  exists; this project requires `security.sshAgent: true`.
- **The implicit credential mounts are deprecated, not removed.** They still
  happen by default — without them agents in the sandbox stop authenticating —
  but every launch names the host directories it reached into, and a profile can
  decline them. Do not delete them; do not make them quiet again.
- **A profile mount of a container runtime socket is refused**, whatever guest
  path it asks for. `docker.sock`, `containerd.sock`, `podman.sock`.
- **`envPassthrough` is reported, never refused.** The list is an allowlist a
  human wrote, and dropping an entry breaks the launch it exists for. Names go
  to `onWarn`, with the credential-shaped ones called out separately. **A value
  never goes into a message** — that is the redaction guarantee of §45.3.
- **Every hardening has two tests: the flag is there, and the operation it could
  break still works.** A `cap-drop` that stopped the agent writing to its
  worktree would be a regression, not a hardening. `docker.test.ts` proves the
  first half purely; `docker.integration.test.ts` proves the second against a
  real daemon, down to `NoNewPrivs` in `/proc/self/status`.

## C7 no longer matches the upstream, deliberately

Through phase 12, C7 compared the argument list literally against
`.references/webmux-main/backend/src/adapters/docker.ts`. Phase 13 is a list of
things the upstream does not do, so the baseline is now this project's. The test
was not weakened — it is still a literal `toEqual` of the whole list — and the
case `docker run args differ from the upstream in exactly the §14 hardenings`
enumerates every difference. Anything not on that list is still literally the
upstream's, and a new divergence that does not appear there is a bug.

## The container does not know tmux exists

A pane runs `docker exec -it -w <worktree> <container> …`, and the web terminal
is the same path. Nothing in this directory knows about panes, and nothing about
panes knows about containers — which is what lets the same container be attached
from either.

## Never

- Never call `docker` outside `run()`.
- Never add a flag here without both halves of its test: that it is in the
  argument list, and that the legitimate operation it could break still works.
- Never publish a port on anything but `127.0.0.1`.
- Never mount the docker socket into the container — not from here, and not from
  a profile. It would hand the agent control of the host daemon and make every
  other flag in this file decorative.
- Never let `buildDockerRunArgs` read `process.env`, `os.totalmem()`, the clock,
  the filesystem or the uid. The moment it does, C7 stops being a literal
  comparison and the hardened baseline stops being reproducible.
- Never put an environment *value* in a warning. Names only.
- Never describe this directory as isolation from the host.
