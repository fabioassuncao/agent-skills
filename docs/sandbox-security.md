# The sandbox security model

What the `sandbox` runtime mode protects against, what it does not, and every
flag that makes the difference.

This is the security half of [`packages/issue-flow/sandbox/`](../packages/issue-flow/sandbox/README.md)
(the image) and [`src/runtime/sandbox/`](../packages/issue-flow/src/runtime/sandbox/AGENTS.md)
(the launcher). Read those for how the container is built and started; read this
for why the launch looks the way it does.

## What the sandbox is for

The container confines **dependencies and the blast radius of a mistake**. An
agent installing a package, running a test suite, or deleting the wrong
directory does it inside a container, against one worktree, with a bounded
process table and a bounded amount of memory.

## What the sandbox is not

**It is not a boundary against deliberately malicious code.** The container runs
as the host user (`--user <uid>:<gid>`) with the worktree and the repository's
`.git` bind-mounted read-write. Anything executing in it already has the host
user's access to those directories, by design — that is what lets the agent
commit work the user can then push, and what keeps the files it creates owned by
the user rather than by root.

If the threat you have in mind is code that is actively trying to get out, this
is the wrong tool, and no combination of the flags below changes that. Use a VM.

Everything on this page hardens the *inside* of that boundary: it shrinks what a
compromised or runaway process can do to the machine, without pretending the
boundary is somewhere it is not.

## The launch flags

Every container the sandbox starts carries these, whether or not a profile says
anything.

| Flag | Value | What it stops |
|---|---|---|
| `--user` | host uid:gid | Files in the mounted worktree owned by root, which the user then cannot clean up |
| `--cap-drop` | `ALL` | Every Linux capability. Nothing the sandbox does needs one — the container already runs unprivileged |
| `--security-opt` | `no-new-privileges:true` | A setuid binary in the image raising privileges back out of the empty capability set |
| `--pids-limit` | `2048` | A fork bomb reaching the host's process table |
| `--memory` | 75% of host RAM | A runaway process taking the machine down with it |
| `--network` | `bridge` | Nothing by itself — it is written explicitly so the sandbox's reach does not depend on how the host's daemon is configured |
| `-p` | `127.0.0.1:<port>:<port>` | A dev server started in a sandbox being reachable from outside the machine. `0.0.0.0` appears nowhere |

And one flag that is **never** present:

| Never | Why |
|---|---|
| `-v /var/run/docker.sock` | It would hand the agent the host daemon, and every other row of this table becomes decorative. A profile that asks for it is refused with a warning — `containerd.sock` and `podman.sock` too |

### Why `--memory` is a fraction and not a number

A fixed default is wrong on every machine but one: `4g` starves a browser test
run on a workstation and overcommits a laptop. A share of the host is never
below what a build that fits the machine needs, and still leaves the host enough
to stay responsive. The threat is *the container takes the machine down*, not
*the container uses a lot of memory*.

### Why `--read-only` is not here

§14's threat model names it in the problem column and leaves it out of the
proposed hardening, correctly. An agent writes to `/tmp`, to package-manager
caches and to its own configuration; a read-only root filesystem would need a
`tmpfs` for each, and the first one missed turns into a failure that looks like
a broken agent rather than a policy.

### What `no-new-privileges` costs

`sudo` and every other setuid binary stop working **inside** the container. The
default image therefore ships no `sudo` at all — a sudoers entry that cannot
work turns a clear failure into a confusing one.

The consequence: an agent cannot `apt-get install` a missing tool at runtime.
Bake it into the image instead, or use the `full` image.

## Credentials

### `envPassthrough`

Reported, never refused. The profile's list is an allowlist a human wrote, and a
sandbox that silently loses `ANTHROPIC_API_KEY` is a broken sandbox. So every
launch says which host variables it forwarded, and says separately which of them
have credential-shaped names:

```text
[docker] forwarding host environment into the sandbox: ANTHROPIC_API_KEY, CI
[docker] envPassthrough carries credential-shaped keys, readable by anything in
         the container: ANTHROPIC_API_KEY
```

Names only. A value never reaches a log line.

Nine keys cannot be forwarded at all, because the container defines them itself:
`HOME`, `TERM`, `IS_SANDBOX`, `SSH_AUTH_SOCK` and the five `GIT_CONFIG_*`.

### `SSH_AUTH_SOCK` — opt-in

The agent socket is not a file the container reads. It is the user's key
answering signature requests for as long as the container lives, for every
repository and host that key reaches — including ones the sandbox has nothing to
do with. So it is **not forwarded unless a profile asks for it**, which is a
change from the absorbed upstream, where it was forwarded whenever it existed.

When it is asked for, it is forwarded with `--mount type=bind`, never `-v`:
docker's `-v` tries to `mkdir` the path it is given, and a socket path is not a
directory.

### Implicit mounts — deprecated

`~/.claude`, `~/.claude.json`, `~/.codex`, `~/.gitconfig`, `~/.ssh` and
`~/.config/gh` are mounted into the container because agents inside it stop
authenticating without them.

They still are, by default — turning them off silently would break every
sandbox launch. What is deprecated is the *implicitness*: each launch now names
the host directories it reached into, and a profile can decline them and declare
what it wants instead.

## The two images

The default image holds what an agent needs to take an issue to a Pull Request:
a shell, git, the GitHub CLI, Node.js, a C toolchain for native npm modules, and
the agent CLIs. Every extra runtime, package manager and download endpoint in an
image is another thing whose compromise reaches the mounted worktree.

The upstream's larger image — Rust, asciinema, Bun, Playwright with Chromium,
the AWS CLI and the Mermaid CLI on top — is kept verbatim as
`Dockerfile.sandbox.full` for the repositories that need it.

Build instructions for both are in
[`packages/issue-flow/sandbox/README.md`](../packages/issue-flow/sandbox/README.md).

## Configuring it

The defaults above are the hardened set and apply with no configuration. The
per-profile knobs live on the docker profile's `security` object:

| Key | Values | Default |
|---|---|---|
| `network` | `bridge` \| `none` | `bridge` |
| `pidsLimit` | Integer; `0` omits the flag | `2048` |
| `memory` | Docker size string (`"4g"`); `"0"` omits the flag | 75% of host RAM |
| `capAdd` | List of capability names, with or without the `CAP_` prefix | `[]` |
| `noNewPrivileges` | boolean | `true` |
| `sshAgent` | boolean | `false` |
| `implicitMounts` | boolean | `true` (deprecated) |

`network: "none"` also drops published ports, because docker refuses
`--network none` together with `-p` and an isolated profile that declared a
service would otherwise fail to launch at all.

> **Not yet readable from `.issue-flow.json`.** `runtime.profiles.*.security` is
> understood by the sandbox launcher but not yet by the profile parser
> (`src/runtime/profiles.ts`), which drops keys it does not know. Until that
> parser passes the object through, every launch gets the defaults column and
> nothing else. The defaults are the hardened set, so this affects the escape
> hatches, not the protection.

## Where this is enforced

`buildDockerRunArgs` in
[`src/runtime/sandbox/docker.ts`](../packages/issue-flow/src/runtime/sandbox/docker.ts)
— a pure function, which is why the whole model above is testable on a machine
with no docker installed. Its complete argument list is compared literally by
the C7 characterization test, and each hardening has a case asserting both that
the flag is there and that the legitimate operation it could break still works.
