import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setIssuesCliOverrides, setWebCliOverrides } from '../config.js';
import { loadExecutionPlan } from '../execution/plan.js';
import type { IssueProvider } from '../issues/provider.js';
import { emptyRelations } from '../issues/relations.js';
import type { Issue, IssueRelations, ResolvedIssue } from '../issues/types.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import {
  resetStorageResolutionCache,
  resolveIssuePaths,
  resolveQueuePaths,
} from '../storage/resolve.js';
import type { TaskPlan } from '../types.js';

/**
 * The multi-issue queue, end to end: discovery decides the run is a queue, the
 * confirmation settles the scope, and every issue goes through the same phases
 * inside one process, on one branch.
 *
 * The phase commands are doubles — what is under test is the *orchestration*:
 * order, shared branch, commit scope, per-issue state and resume.
 */

vi.mock('./init.js', () => ({ runInit: vi.fn(async () => 0) }));
vi.mock('./prd.js', () => ({ runPrd: vi.fn(async () => 0) }));
vi.mock('./execute.js', () => ({ runExecute: vi.fn(async () => 0) }));
vi.mock('./review.js', () => ({ runReview: vi.fn(async () => 0) }));
vi.mock('./pr.js', () => ({ runPr: vi.fn(async () => 0) }));
vi.mock('./pr-review.js', () => ({ runPrReview: vi.fn(async () => 0) }));

/** The `plan` phase is the one that writes tasks.json, so it is a real double. */
const planned = vi.hoisted(() => ({ branchOf: (issue: string) => `issue/${issue}-work` }));
vi.mock('./plan.js', () => ({ runPlan: vi.fn(async () => 0) }));

const mockProjectRoot = vi.hoisted(() => ({ current: '' }));
vi.mock('execa', () => ({
  execa: vi.fn(async (file: string, args: string[] = []) => {
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { stdout: mockProjectRoot.current, exitCode: 0 };
    }
    if (file === 'git' && args[0] === 'branch' && args[1] === '--show-current') {
      return { stdout: 'issue/50-work', exitCode: 0 };
    }
    return { stdout: '', exitCode: 1 };
  }),
}));

vi.mock('../core/session-git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/session-git.js')>();
  return {
    ...actual,
    publishGitState: vi.fn(async () => {}),
    listPullRequests: vi.fn(async () => []),
  };
});

vi.mock('../issues/resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../issues/resolver.js')>();
  return { ...actual, resolveIssue: vi.fn() };
});
vi.mock('../issues/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../issues/registry.js')>();
  return { ...actual, getProvider: vi.fn() };
});

/** Deterministic renderer: runs each phase runner in order, no listr2 output. */
vi.mock('../ui/pipeline-renderer.js', () => ({
  runPipelineWithRenderer: vi.fn(
    async (options: {
      phases: string[];
      startIndex: number;
      runners: Record<string, () => Promise<void>>;
    }) => {
      for (let i = options.startIndex; i < options.phases.length; i++) {
        const phase = options.phases[i] as string;
        try {
          await options.runners[phase]?.();
        } catch {
          return { success: false, failedPhase: phase, overallElapsedSeconds: 1 };
        }
      }
      return { success: true, overallElapsedSeconds: 1 };
    },
  ),
}));

const { resolveIssue } = await import('../issues/resolver.js');
const { getProvider } = await import('../issues/registry.js');
const { runExecute } = await import('./execute.js');
const { runPlan } = await import('./plan.js');
const { runInit } = await import('./init.js');
const { runPr } = await import('./pr.js');
const { runPipeline } = await import('./run.js');

let globalHome = '';
let previousGlobalHome: string | undefined;
let repoRoot = '';
let originalCwd = '';

/** Relations answered by the provider double, keyed by issue id. */
const relations = new Map<string, IssueRelations>();
/** Issues answered by `get`, keyed by id. */
const issues = new Map<string, Issue>();
const closed: string[] = [];

function makeIssue(id: string, labels: string[] = []): Issue {
  return {
    id,
    number: Number(id),
    title: `Issue ${id}`,
    body: '',
    labels,
    state: 'open',
    source: 'github',
    remoteRef: `https://github.com/acme/repo/issues/${id}`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    contentHash: `sha256:${id}`,
  };
}

function makeResolved(id: string): ResolvedIssue {
  const issue = issues.get(id) ?? makeIssue(id);
  return { issue, source: 'github', local: null, github: issue, divergent: false };
}

function makeProvider(): IssueProvider {
  return {
    name: 'github',
    isAvailable: async () => true,
    get: async (id: string) => issues.get(id) ?? makeIssue(id),
    create: async () => {
      throw new Error('not implemented');
    },
    close: async (id: string) => {
      closed.push(id);
    },
    fetchRelations: async (id: string) => relations.get(id) ?? emptyRelations(id),
  };
}

/** Task plan the `plan` phase double writes for an issue. */
function taskPlan(issue: string, branchName: string): TaskPlan {
  return {
    project: 'widgets',
    issueNumber: Number(issue),
    issueUrl: `https://github.com/acme/repo/issues/${issue}`,
    branchName,
    description: `Issue ${issue}`,
    issueStatus: 'pending',
    completedAt: null,
    lastAttemptAt: null,
    lastError: null,
    correctionCycle: 0,
    maxCorrectionCycles: 3,
    lastReviewFindings: null,
    pipeline: {
      prdCompleted: true,
      jsonCompleted: true,
      executionCompleted: false,
      reviewCompleted: false,
      prCreated: false,
    },
    userStories: [
      {
        id: 'US-001',
        title: 'Story',
        description: 'As a…',
        acceptanceCriteria: [],
        priority: 1,
        passes: true,
        notes: '',
      },
    ],
  };
}

/** Write the plan the way the real `plan` phase would, branch slug included. */
async function writePlan(issue: string): Promise<void> {
  const paths = await resolveIssuePaths(issue);
  await mkdir(paths.issueDir, { recursive: true });
  await writeFile(
    paths.tasksFile,
    JSON.stringify(taskPlan(issue, planned.branchOf(issue)), null, 2),
    'utf-8',
  );
}

beforeEach(async () => {
  globalHome = await mkdtemp(join(tmpdir(), 'issue-flow-home-'));
  previousGlobalHome = process.env[GLOBAL_ROOT_ENV];
  process.env[GLOBAL_ROOT_ENV] = globalHome;

  originalCwd = process.cwd();
  repoRoot = await mkdtemp(join(tmpdir(), 'issue-flow-queue-repo-'));
  mockProjectRoot.current = repoRoot;
  process.chdir(repoRoot);

  resetStorageResolutionCache();
  relations.clear();
  issues.clear();
  closed.length = 0;
  setWebCliOverrides({});
  setIssuesCliOverrides({});
  vi.clearAllMocks();

  vi.mocked(resolveIssue).mockImplementation(async (id: string) => makeResolved(id));
  vi.mocked(getProvider).mockReturnValue(makeProvider());
  vi.mocked(runPlan).mockImplementation(async (issue: string) => {
    await writePlan(issue);
    return 0;
  });
});

afterEach(async () => {
  process.chdir(originalCwd);
  resetStorageResolutionCache();
  if (previousGlobalHome === undefined) delete process.env[GLOBAL_ROOT_ENV];
  else process.env[GLOBAL_ROOT_ENV] = previousGlobalHome;
  await rm(globalHome, { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
});

/** Silence the terminal output while still returning the exit code. */
async function run(
  issues: string | string[],
  options: { yes?: boolean; only?: boolean } = { yes: true },
): Promise<number> {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    return await runPipeline(issues, 'auto', undefined, undefined, undefined, options);
  } finally {
    spy.mockRestore();
  }
}

describe('single issue — no behaviour change', () => {
  it('creates no queue artifact when the issue relates to nothing', async () => {
    expect(await run('42')).toBe(0);

    const queue = await resolveQueuePaths('42');
    expect(existsSync(queue.planFile)).toBe(false);
    // The pr phase still runs for a standalone issue.
    expect(vi.mocked(runPr)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runExecute)).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ issue: '42', commitScope: undefined }),
    );
    expect(closed).toEqual(['42']);
  });

  it('skips discovery entirely with --only', async () => {
    relations.set('42', { ...emptyRelations('42'), children: ['43'] });

    expect(await run('42', { only: true })).toBe(0);
    const queue = await resolveQueuePaths('42');
    expect(existsSync(queue.planFile)).toBe(false);
  });
});

describe('queue of several issues', () => {
  beforeEach(() => {
    // 50 is the umbrella; 51 depends on it; 52 is a plain sub-issue.
    relations.set('50', { ...emptyRelations('50'), children: ['51', '52'], blocking: ['51'] });
    relations.set('51', { ...emptyRelations('51'), parent: '50', blockedBy: ['50'] });
    relations.set('52', { ...emptyRelations('52'), parent: '50' });
    issues.set('50', makeIssue('50'));
    issues.set('51', makeIssue('51'));
    issues.set('52', makeIssue('52', ['high']));
  });

  it('runs every discovered issue in dependency order, in one process', async () => {
    expect(await run('50')).toBe(0);

    const executed = vi
      .mocked(runExecute)
      .mock.calls.map(([, options]) => (options as { issue?: string }).issue);
    expect(executed).toEqual(['50', '52', '51']);
    // Prerequisites are checked once for the whole queue, not per issue.
    expect(vi.mocked(runInit)).toHaveBeenCalledTimes(1);
  });

  it('shares one branch and scopes the commits per issue', async () => {
    await run('50');

    const branches = await Promise.all(
      ['50', '51', '52'].map(async (id) => {
        const paths = await resolveIssuePaths(id);
        const plan = JSON.parse(
          await import('node:fs/promises').then((fs) => fs.readFile(paths.tasksFile, 'utf-8')),
        );
        return plan.branchName;
      }),
    );
    expect(branches).toEqual(['issue/50-work', 'issue/50-work', 'issue/50-work']);

    const scopes = vi
      .mocked(runExecute)
      .mock.calls.map(([, options]) => (options as { commitScope?: string }).commitScope);
    expect(scopes).toEqual(['issue-50', 'issue-52', 'issue-51']);
  });

  it('opens exactly one Pull Request, covering every issue of the queue', async () => {
    await run('50');

    expect(vi.mocked(runPr)).toHaveBeenCalledTimes(1);
    const [issue, , options] = vi.mocked(runPr).mock.calls[0] as [
      string,
      unknown,
      { queue?: { issues: { id: string }[] } },
    ];
    // Opened for the primary issue, listing the queue in execution order.
    expect(issue).toBe('50');
    expect(options.queue?.issues.map((entry) => entry.id)).toEqual(['50', '52', '51']);
  });

  it('records the consolidated Pull Request on the queue and on every task plan', async () => {
    const pullRequest = {
      number: 7,
      url: 'https://github.com/acme/repo/pull/7',
      headBranch: 'issue/50-work',
      createdAt: '2026-08-05T10:00:00Z',
    };
    // The real `pr` phase writes the reference on the primary issue's plan.
    vi.mocked(runPr).mockImplementation(async (issue: string) => {
      const paths = await resolveIssuePaths(issue);
      const plan = JSON.parse(await readFile(paths.tasksFile, 'utf-8'));
      plan.pullRequest = pullRequest;
      plan.pipeline.prCreated = true;
      await writeFile(paths.tasksFile, JSON.stringify(plan, null, 2), 'utf-8');
      return 0;
    });

    await run('50');

    const queue = await loadExecutionPlan((await resolveQueuePaths('50')).planFile);
    expect(queue.pullRequest).toEqual(pullRequest);

    // pr-review discovers the PR from tasks.json, so every issue of the queue
    // has to carry the same reference.
    for (const id of ['51', '52']) {
      const paths = await resolveIssuePaths(id);
      const plan = JSON.parse(await readFile(paths.tasksFile, 'utf-8'));
      expect(plan.pullRequest).toEqual(pullRequest);
      expect(plan.pipeline.prCreated).toBe(true);
    }
  });

  it('does not reopen a Pull Request when the queue already has one', async () => {
    await run('50');
    vi.mocked(runPr).mockClear();
    resetStorageResolutionCache();

    // Nothing left to do: every issue is completed and the PR was recorded.
    await run('50', {});
    expect(vi.mocked(runPr)).not.toHaveBeenCalled();
  });

  it('persists the queue with every issue completed', async () => {
    await run('50');

    const plan = await loadExecutionPlan((await resolveQueuePaths('50')).planFile);
    expect(plan.status).toBe('completed');
    expect(plan.branchName).toBe('issue/50-work');
    expect(plan.issues.map((entry) => [entry.id, entry.status])).toEqual([
      ['50', 'completed'],
      ['52', 'completed'],
      ['51', 'completed'],
    ]);
  });

  it('closes every issue of the queue once it is done', async () => {
    await run('50');
    expect(closed.sort()).toEqual(['50', '51', '52']);
  });

  it('runs only the informed issues with --only', async () => {
    expect(await run(['50', '51'], { only: true })).toBe(0);

    const executed = vi
      .mocked(runExecute)
      .mock.calls.map(([, options]) => (options as { issue?: string }).issue);
    expect(executed).toEqual(['50', '51']);

    const plan = await loadExecutionPlan((await resolveQueuePaths('50')).planFile);
    expect(plan.excluded.map((entry) => entry.id)).toEqual(['52']);
  });

  it('accepts the comma form and the space form alike', async () => {
    expect(await run('50,51', { only: true })).toBe(0);
    const first = vi
      .mocked(runExecute)
      .mock.calls.map(([, options]) => (options as { issue?: string }).issue);

    vi.mocked(runExecute).mockClear();
    resetStorageResolutionCache();
    await rm((await resolveQueuePaths('50')).queueDir, { recursive: true, force: true });

    expect(await run(['50', '51'], { only: true })).toBe(0);
    const second = vi
      .mocked(runExecute)
      .mock.calls.map(([, options]) => (options as { issue?: string }).issue);

    expect(second).toEqual(first);
  });
});

describe('failure and resume', () => {
  beforeEach(() => {
    relations.set('50', { ...emptyRelations('50'), blocking: ['51'] });
    relations.set('51', { ...emptyRelations('51'), blockedBy: ['50'] });
  });

  it('stops at the failing issue, recording where it happened', async () => {
    vi.mocked(runExecute).mockImplementation(async (_max, options) =>
      (options as { issue?: string }).issue === '51' ? 1 : 0,
    );

    expect(await run('50')).not.toBe(0);

    const plan = await loadExecutionPlan((await resolveQueuePaths('50')).planFile);
    expect(plan.status).toBe('failed');
    expect(plan.issues[0]).toMatchObject({ id: '50', status: 'completed' });
    expect(plan.issues[1]).toMatchObject({ id: '51', status: 'failed', failedPhase: 'execute' });
    // The issues are not closed when the queue did not finish.
    expect(closed).toEqual([]);
  });

  it('resumes from the failed issue without redoing the completed ones', async () => {
    vi.mocked(runExecute).mockImplementation(async (_max, options) =>
      (options as { issue?: string }).issue === '51' ? 1 : 0,
    );
    await run('50');

    vi.mocked(runExecute).mockClear();
    vi.mocked(runExecute).mockImplementation(async () => 0);
    resetStorageResolutionCache();

    // No confirmation flag: a resumed queue must not ask again.
    expect(await run('50', {})).toBe(0);

    const executed = vi
      .mocked(runExecute)
      .mock.calls.map(([, options]) => (options as { issue?: string }).issue);
    expect(executed).toEqual(['51']);

    const plan = await loadExecutionPlan((await resolveQueuePaths('50')).planFile);
    expect(plan.status).toBe('completed');
  });
});

describe('scope confirmation', () => {
  beforeEach(() => {
    relations.set('50', { ...emptyRelations('50'), children: ['51'] });
    relations.set('51', { ...emptyRelations('51'), parent: '50' });
  });

  it('fails explicitly when it cannot ask and no flag was given', async () => {
    const code = await run('50', {});
    expect(code).toBe(1);
    expect(vi.mocked(runExecute)).not.toHaveBeenCalled();
  });
});

describe('dependency cycles', () => {
  it('refuses to run and explains, instead of picking an order', async () => {
    relations.set('50', { ...emptyRelations('50'), blockedBy: ['51'] });
    relations.set('51', { ...emptyRelations('51'), blockedBy: ['50'] });

    expect(await run('50')).toBe(1);
    expect(vi.mocked(runExecute)).not.toHaveBeenCalled();
  });
});
