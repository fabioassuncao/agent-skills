import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentSessionDeps } from '../agents/session/open.js';
import type { AgentInvocation, ResolvedAgentSettings } from '../agents/types.js';
import { type PlanRepositoryContext, resetPlanRepositories } from '../storage/db/repository.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import { localBranchExists } from '../utils/git.js';
import { DEFAULT_PANES } from './profiles.js';
import { containerNamePrefix } from './sandbox/docker.js';
import { createSandboxRuntime, type SandboxRuntimeDeps } from './sandbox.js';
import { createTmuxGateway, type TmuxGateway } from './tmux/gateway.js';
import { createGitWorktreeGateway } from './worktree/git.js';
import { createWorktreeManager } from './worktree/lifecycle.js';

/**
 * The `sandbox` runtime against a real daemon, a real tmux server and a real
 * `git worktree add`.
 *
 * The pure suites already prove the two things that matter most and do not need
 * a machine: the argument list (`sandbox/docker.test.ts`, C7) and the adapter's
 * decisions (`sandbox.test.ts`). What only a daemon can show is that the three
 * really compose — a container that starts for a branch this worktree owns, a
 * pane that enters it, and a teardown that removes it again.
 *
 * Every probe runs **synchronously at module load**: `it.runIf` is evaluated
 * while the file is being collected, so a flag assigned in `beforeAll` would
 * still be false and every case would skip in silence.
 */

const TEST_IMAGE = process.env.ISSUE_FLOW_SANDBOX_TEST_IMAGE ?? 'alpine:latest';

function probeDocker(): boolean {
  if (spawnSync('docker', ['version', '--format', '{{.Server.Version}}']).status !== 0) {
    return false;
  }
  if (spawnSync('docker', ['image', 'inspect', TEST_IMAGE]).status === 0) return true;
  return spawnSync('docker', ['pull', TEST_IMAGE], { timeout: 120_000 }).status === 0;
}

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;
const ready = gitAvailable && tmuxAvailable && probeDocker();

const socketName = `issue-flow-test-${randomUUID().slice(0, 8)}`;

const SETTINGS: ResolvedAgentSettings = {
  provider: 'claude',
  model: null,
  claude: {},
  codex: {},
  cursor: {},
  antigravity: {},
  opencode: {},
  origin: { provider: 'default', model: 'default' },
};

const INVOCATION: AgentInvocation = {
  prompt: 'look at the parser',
  phase: 'execute',
  timeout: 0,
  permission: 'workspace',
};

/** Force-remove every container of a branch, whatever state a test left it in. */
function purge(branch: string): void {
  const listed = spawnSync('docker', [
    'ps',
    '-a',
    '--filter',
    `name=${containerNamePrefix(branch)}`,
    '--format',
    '{{.Names}}',
  ]);
  for (const name of String(listed.stdout ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)) {
    spawnSync('docker', ['rm', '-f', name]);
  }
}

function runningContainers(branch: string): string[] {
  const listed = spawnSync('docker', [
    'ps',
    '--filter',
    `name=${containerNamePrefix(branch)}`,
    '--format',
    '{{.Names}}',
  ]);
  return String(listed.stdout ?? '')
    .trim()
    .split('\n')
    .filter(Boolean);
}

async function killTestServer(): Promise<void> {
  await execa('tmux', ['-L', socketName, 'kill-server'], { reject: false });
}

async function initRepository(root: string): Promise<void> {
  await execa('git', ['init', '--initial-branch=main'], { cwd: root });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  await execa('git', ['config', 'user.name', 'Test'], { cwd: root });
  await writeFile(join(root, 'README.md'), '# fixture\n', 'utf-8');
  await execa('git', ['add', '.'], { cwd: root });
  await execa('git', ['commit', '-m', 'initial'], { cwd: root });
}

describe('the sandbox runtime against a real daemon', () => {
  const dirs: string[] = [];
  const branches: string[] = [];
  let home: string;

  afterAll(async () => {
    if (tmuxAvailable) await killTestServer();
  });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-sandbox-home-'));
    dirs.push(home);
  });

  afterEach(async () => {
    for (const branch of branches.splice(0)) purge(branch);
    if (tmuxAvailable) await killTestServer();
    resetPlanRepositories();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /**
   * The real gateway, recording the command every pane is opened with.
   *
   * The command is asserted *as it is issued* rather than read back out of
   * tmux afterwards. A pane whose `docker exec` cannot start — a daemon under
   * load is enough — takes its window down with it, and what this case is
   * about is which command the runtime asked tmux to run, not how healthy the
   * daemon was while it ran.
   */
  function recordingTmux(gateway: TmuxGateway): TmuxGateway & { paneShells: string[] } {
    const paneShells: string[] = [];
    return {
      ...gateway,
      paneShells,
      createWindow: async (options) => {
        if (options.command !== undefined) paneShells.push(options.command);
        await gateway.createWindow(options);
      },
      splitWindow: async (options) => {
        if (options.command !== undefined) paneShells.push(options.command);
        await gateway.splitWindow(options);
      },
    };
  }

  async function fixture(projectId: string): Promise<{
    deps: SandboxRuntimeDeps;
    root: string;
    tmux: ReturnType<typeof recordingTmux>;
  }> {
    const workspace = await mkdtemp(join(tmpdir(), 'issue-flow-sandbox-repo-'));
    dirs.push(workspace);
    const root = join(workspace, 'repo');
    await mkdir(root, { recursive: true });
    await initRepository(root);

    const storage: PlanRepositoryContext = {
      tasksPath: '',
      projectId,
      issueId: '',
      projectRoot: root,
      databaseOptions: { env: { [GLOBAL_ROOT_ENV]: home } },
    };
    const git = createGitWorktreeGateway();
    const tmux = recordingTmux(createTmuxGateway({ socketName }));
    const session: AgentSessionDeps = {
      projectId,
      projectRoot: root,
      storage,
      worktrees: createWorktreeManager({ projectRoot: root, storage, mainBranch: 'main', git }),
      tmux,
      git,
      branchExists: (branch) => localBranchExists(branch, root),
      panes: DEFAULT_PANES,
      profileName: 'sandbox',
    };

    return {
      root,
      tmux,
      deps: {
        session,
        provider: 'claude',
        profile: { runtime: 'docker', image: TEST_IMAGE },
        startHooks: async () => null,
        lifecycle: { list: async () => [] },
        scheduler: { scheduleEvery: () => 1, cancelSchedule: () => {} },
      },
    };
  }

  it.runIf(ready)(
    'starts a container for the branch, opens the pane in it and removes it again',
    async () => {
      const branch = 'feat/sandboxed';
      branches.push(branch);
      const { deps, root, tmux } = await fixture('proj-sandbox-1');
      const runtime = createSandboxRuntime(deps);

      const prepared = await runtime.prepare({ projectRoot: root, branch, runId: 'run-1' });

      expect(prepared.session?.container).toBeTruthy();
      expect(prepared.session?.containerLaunched).toBe(true);
      expect(runningContainers(branch)).toEqual([prepared.session?.container]);

      // A pane whose command cannot start takes its window with it, and the
      // layout then reports a window that is already gone. That is the
      // daemon's health rather than this adapter's behaviour, so the failure is
      // not what the case is about — the command tmux was handed is.
      await runtime.launch(prepared, INVOCATION, SETTINGS).catch(() => {});

      // Every pane of the window enters the container, which is what puts the
      // agent inside it without the agent command ever naming docker.
      expect(tmux.paneShells.length).toBeGreaterThan(0);
      for (const shell of tmux.paneShells) {
        expect(shell).toContain(`docker exec -it -w '${prepared.workdir}'`);
        expect(shell).toContain(String(prepared.session?.container));
      }

      await runtime.dispose(prepared);
      expect(runningContainers(branch)).toEqual([]);
    },
    180_000,
  );

  it.runIf(ready)(
    'joins a container that is already running and leaves it alone',
    async () => {
      const branch = 'feat/rejoined';
      branches.push(branch);
      const { deps, root } = await fixture('proj-sandbox-2');
      const runtime = createSandboxRuntime(deps);

      const first = await runtime.prepare({ projectRoot: root, branch, runId: 'run-1' });
      const second = await runtime.prepare({ projectRoot: root, branch, runId: 'run-2' });

      expect(second.session?.container).toBe(first.session?.container);
      expect(second.session?.containerLaunched).toBe(false);

      // The second prepare joined it, so its dispose may not take it down: the
      // run that started it is still using it.
      await runtime.dispose(second);
      expect(runningContainers(branch)).toEqual([first.session?.container]);
    },
    180_000,
  );
});
