import {
  createInteractiveRuntimeAdapter,
  createPaneRuntime,
  type PaneRuntimeDeps,
  RuntimeUnavailableError,
  resolvePaneRuntimeDeps,
} from './interactive.js';
import { isDockerProfile, type RuntimeProfile } from './profiles.js';
import {
  createDockerGateway,
  type DockerGateway,
  type SandboxProfileConfig,
} from './sandbox/docker.js';
import type { Runtime } from './types.js';

/**
 * The `sandbox` mode: everything `interactive` does, inside a container.
 *
 * It is the thinnest adapter in this directory on purpose. The container
 * lifecycle is `runtime/sandbox/docker.ts` — including the whole hardened
 * argument list of phase 13 — the pane commands are `agents/tty.ts`, and the
 * worktree, window, argv, prompt delivery and outcome are the same code
 * `interactive` runs (`createPaneRuntime`). Two modes that differ by a container
 * must not become two implementations that differ by everything (§25).
 *
 * What the container changes is exactly two things:
 *
 * 1. **the pane's shell.** Every pane is opened with `docker exec -it -w
 *    <worktree> <container> …`, so the agent command typed into it lands inside
 *    the container without ever naming docker itself. `agents/session/open.ts`
 *    does that when it is given a `container`;
 * 2. **the worktree binding says `runtime: 'docker'`**, which is what a later
 *    teardown and the reconciler dispatch on.
 *
 * The security model of the container — what it protects against and what it
 * explicitly does not — is `docs/sandbox-security.md`. Nothing here weakens it:
 * every flag is decided by `buildDockerRunArgs`, and this file passes the
 * profile through untouched.
 */

export interface SandboxRuntimeDeps extends PaneRuntimeDeps {
  /** The docker profile the worktree runs under: image, mounts, security. */
  profile: SandboxProfileConfig;
  docker?: DockerGateway;
}

/**
 * Narrow a runtime profile to one that can actually be launched.
 *
 * A profile that says `runtime: docker` without an image is a configuration
 * error, not a reason to fall back to the host: falling back would run
 * untrusted code on the machine the sandbox exists to protect.
 *
 * Everything the profile declares travels through, `security` included. Its
 * absence is the case that hides: every hardening default is the safe one, so a
 * dropped `security` looks like nothing is wrong while `sshAgent`, `network`
 * and `capAdd` — documented as configurable in `docs/sandbox-security.md` —
 * silently never reach `docker run`. `ProfileSecurity` is structurally
 * assignable to `SandboxSecurityConfig` on purpose, so that `profiles.ts` never
 * has to import a value from `sandbox/` and drag the docker gateway (and
 * `execa` behind it) into every CLI boot.
 */
export function requireDockerProfile(
  profile: RuntimeProfile | undefined,
  profileName: string,
): SandboxProfileConfig {
  if (!isDockerProfile(profile)) {
    throw new RuntimeUnavailableError(
      `The '${profileName}' profile cannot run in the sandbox: it declares no image. Add \`"image": "<tag>"\` to it, or run the 'interactive' mode, which needs no container.`,
    );
  }
  return {
    runtime: 'docker',
    image: profile.image,
    ...(profile.envPassthrough.length === 0 ? {} : { envPassthrough: profile.envPassthrough }),
    ...(profile.mounts === undefined ? {} : { mounts: profile.mounts }),
    ...(profile.security === undefined ? {} : { security: profile.security }),
  };
}

/** The `sandbox` mode: worktree + tmux + a container per branch. */
export function createSandboxRuntime(deps?: SandboxRuntimeDeps): Runtime {
  const gateway = (runtimeDeps: PaneRuntimeDeps): DockerGateway => {
    const sandboxDeps = runtimeDeps as SandboxRuntimeDeps;
    return (
      sandboxDeps.docker ??
      createDockerGateway({
        ...(runtimeDeps.warn === undefined ? {} : { onWarn: runtimeDeps.warn }),
      })
    );
  };

  const profileOf = (runtimeDeps: PaneRuntimeDeps): SandboxProfileConfig => {
    const profile = (runtimeDeps as SandboxRuntimeDeps).profile;
    if (profile === undefined) {
      throw new RuntimeUnavailableError(
        "The 'sandbox' runtime needs a docker profile. Declare one in `runtime.profiles` (a profile named `sandbox` defaults to `runtime: docker`) and give it an image.",
      );
    }
    return profile;
  };

  return createPaneRuntime(
    {
      ...createInteractiveRuntimeAdapter(),
      mode: 'sandbox',
      resolveDeps: (projectRoot) => resolveSandboxRuntimeDeps(projectRoot),
      // What the binding records, and what a teardown dispatches on: a worktree
      // whose runtime is `docker` has a container to remove, one whose runtime
      // is `host` does not.
      worktreeRuntime: 'docker',

      assertAvailable: async (runtimeDeps) => {
        // tmux first: the sandbox is the interactive mode plus a container, so
        // the interactive requirement is still the first one to fail.
        await createInteractiveRuntimeAdapter().assertAvailable(runtimeDeps);
        profileOf(runtimeDeps);
        if (await gateway(runtimeDeps).isAvailable()) return;
        throw new RuntimeUnavailableError(
          "The 'sandbox' runtime needs a running Docker daemon, which did not answer. Start Docker (Docker Desktop, `colima start`, `systemctl start docker`), or run the 'interactive' mode, which needs no container.",
        );
      },

      /**
       * Start the branch's container, or join the one already running.
       *
       * `launchContainer` is idempotent per branch and reports which of the two
       * happened only by returning a name, so the running set is read first:
       * `release()` may remove a container this prepare started, and may not
       * remove one it merely joined.
       */
      provision: async ({ deps: runtimeDeps, branch, worktreePath, runtimeEnv }) => {
        const docker = gateway(runtimeDeps);
        const existing = await docker.findContainer(branch);
        const container = await docker.launchContainer({
          branch,
          wtDir: worktreePath,
          mainRepoDir: runtimeDeps.session.projectRoot,
          sandboxConfig: profileOf(runtimeDeps),
          services: (runtimeDeps.services ?? []).map((service) => ({
            name: service.name,
            portEnv: service.portEnv,
          })),
          runtimeEnv,
        });
        return { container, launched: existing === null };
      },

      release: async ({ deps: runtimeDeps, session }) => {
        // Never the container of a run that is still using it, and never one
        // this prepare found already running.
        if (session.container === null || !session.containerLaunched) return;
        await gateway(runtimeDeps).removeContainer(session.branch);
      },
    },
    deps,
  );
}

/**
 * The default wiring for the sandbox, resolved from a repository on disk.
 *
 * Same wiring as the interactive mode plus the profile, which is the only extra
 * input a container needs.
 */
export async function resolveSandboxRuntimeDeps(
  projectRoot: string,
  options: { profile?: string } = {},
): Promise<SandboxRuntimeDeps> {
  const { loadRuntimeConfig } = await import('../config/runtime.js');
  const base = await resolvePaneRuntimeDeps(projectRoot, options);
  const runtime = await loadRuntimeConfig({ projectRoot });
  const profileName = base.session.profileName;
  return { ...base, profile: requireDockerProfile(runtime.profiles[profileName], profileName) };
}
