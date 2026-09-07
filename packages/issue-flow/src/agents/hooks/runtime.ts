import { loadAgentHooksConfig } from '../../config/agent-hooks.js';
import { writeDiagnostic } from '../../storage/diagnostics.js';
import { run } from '../../utils/shell.js';
import { applyAgentRuntimeEvent } from './apply.js';
import { type AgentControlServerHandle, startAgentControlServer } from './control-server.js';
import {
  type AgentRuntimeArtifacts,
  clearControlEnv,
  ensureAgentRuntimeArtifacts,
  removeAgentRuntimeArtifacts,
  writeControlEnv,
} from './install.js';

/**
 * One invocation's worth of agent lifecycle reporting: hooks installed, control
 * endpoint bound, credentials published — and all three retracted afterwards.
 *
 * The lifetime is the invocation, not the process, because the hook files live
 * in the user's working tree. Leaving them behind would mean the user's own
 * later `claude` session runs our hooks against an endpoint that no longer
 * exists. Retracting `control.env` alone already makes a leftover hook a no-op
 * (the helper exits immediately without it); removing the hook groups as well
 * is what keeps the user's configuration the way we found it.
 */

export interface AgentHookSession {
  /** URL the helper posts to. Diagnostics and tests. */
  url: string;
  /** Events accepted so far. Diagnostics and tests. */
  accepted(): number;
  /** Idempotent, never rejects. */
  close(): Promise<void>;
}

export interface StartAgentHookSessionInput {
  /** Phase the invocation belongs to; carried on every event. */
  phase: string;
  /** Session id of the run. `null` disables reporting: nothing to correlate to. */
  runId: string | null;
  /** Directory the agent will run in. */
  workingDirectory: string;
  env?: NodeJS.ProcessEnv;
  onWarn?: (message: string) => void;
}

/** `git rev-parse` output, or `null` outside a repository. */
async function gitPaths(cwd: string): Promise<{ gitDir: string; worktreePath: string } | null> {
  const [gitDir, toplevel] = await Promise.all([
    run('git', ['rev-parse', '--absolute-git-dir'], { cwd, diagnostics: false }),
    run('git', ['rev-parse', '--show-toplevel'], { cwd, diagnostics: false }),
  ]);
  if (gitDir.exitCode !== 0 || toplevel.exitCode !== 0) return null;
  const dir = gitDir.stdout.trim();
  const root = toplevel.stdout.trim();
  return dir === '' || root === '' ? null : { gitDir: dir, worktreePath: root };
}

/**
 * Returns `null` whenever reporting cannot be set up — disabled by
 * configuration, no session id, not a git repository, the endpoint would not
 * bind. That is never an error: it is the behaviour every release before this
 * one had, and observability may not be able to stop an invocation (ADR-03).
 */
export async function startAgentHookSession(
  input: StartAgentHookSessionInput,
): Promise<AgentHookSession | null> {
  if (input.runId === null) return null;

  const warn = input.onWarn;
  const config = await loadAgentHooksConfig({
    ...(input.env === undefined ? {} : { env: input.env }),
    warn: () => {},
  });
  if (!config.enabled) return null;

  const paths = await gitPaths(input.workingDirectory);
  if (paths === null) return null;

  let artifacts: AgentRuntimeArtifacts;
  let server: AgentControlServerHandle | null;
  try {
    artifacts = await ensureAgentRuntimeArtifacts(paths);
    server = await startAgentControlServer({
      onEvent: (event) => applyAgentRuntimeEvent(event, { ...(warn ? { onWarn: warn } : {}) }),
      ...(warn ? { onWarn: warn } : {}),
    });
    if (server === null) {
      await removeAgentRuntimeArtifacts(artifacts);
      return null;
    }
    await writeControlEnv(artifacts, {
      controlUrl: server.url,
      token: server.token,
      runId: input.runId,
      phase: input.phase,
    });
  } catch (error) {
    writeDiagnostic({
      level: 'warning',
      message: `Agent lifecycle hooks could not be installed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return null;
  }

  let closed = false;
  const boundServer = server;
  return {
    url: boundServer.url,
    accepted: () => boundServer.accepted(),
    close: async () => {
      if (closed) return;
      closed = true;
      // Order matters: retract the credentials first, so a hook that fires
      // while the rest is being torn down finds nothing to post to instead of
      // an endpoint that is halfway closed.
      try {
        await clearControlEnv(artifacts);
        await removeAgentRuntimeArtifacts(artifacts);
      } catch (error) {
        writeDiagnostic({
          level: 'warning',
          message: `Agent lifecycle hooks could not be removed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
      await boundServer.close();
    },
  };
}
