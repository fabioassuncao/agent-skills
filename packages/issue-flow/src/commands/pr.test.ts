import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskPlan } from '../types.js';

// resolveIssuePaths() shells out to `git rev-parse --show-toplevel` and
// `git remote get-url origin`, and runPr reads the branch from
// `git branch --show-current`; all three go through execa, so the mock answers
// with the temporary repo root, a stable remote and a fixed branch name.
const mockRepo = vi.hoisted(() => ({ root: '', remote: 'https://github.com/acme/widgets.git' }));
vi.mock('execa', () => ({
  execa: vi.fn(async (file: string, args: string[] = []) => {
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { stdout: mockRepo.root, exitCode: 0 };
    }
    if (file === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
      return { stdout: mockRepo.remote, exitCode: 0 };
    }
    if (file === 'git' && args[0] === 'branch' && args[1] === '--show-current') {
      return { stdout: 'issue/42-sample', exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  }),
}));

const headlessOutput = vi.hoisted(() => ({ current: '' }));
const headlessOptions = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));
vi.mock('../core/headless.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/headless.js')>()),
  runHeadless: vi.fn(async (options: Record<string, unknown>) => {
    headlessOptions.last = options;
    return { success: true, result: headlessOutput.current };
  }),
}));

import type { Issue, ResolvedIssue } from '../issues/types.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import { resetStorageResolutionCache, resolveIssuePaths } from '../storage/resolve.js';
import { issueClosesLines, multiIssueContext, runPr } from './pr.js';

function makeResolved(): ResolvedIssue {
  const issue: Issue = {
    id: '42',
    number: 42,
    title: 'Sample issue',
    body: 'Body',
    labels: [],
    state: 'open',
    source: 'github',
    remoteRef: 'https://github.com/acme/repo/issues/42',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    contentHash: 'sha256:abc',
  };
  return { issue, source: 'github', local: null, github: issue, divergent: false };
}

function makePlan(): TaskPlan {
  return {
    project: 'test',
    issueNumber: 42,
    issueUrl: 'https://github.com/acme/repo/issues/42',
    branchName: 'issue/42-sample',
    description: 'Test plan',
    issueStatus: 'in_progress',
    completedAt: null,
    lastAttemptAt: null,
    lastError: null,
    correctionCycle: 0,
    maxCorrectionCycles: 3,
    pipeline: {
      prdCompleted: true,
      jsonCompleted: true,
      executionCompleted: true,
      reviewCompleted: true,
      prCreated: false,
    },
    userStories: [
      {
        id: 'US-001',
        title: 'First story',
        description: 'Test story',
        acceptanceCriteria: ['Criterion 1'],
        priority: 1,
        passes: true,
        notes: '',
      },
    ],
  };
}

describe('runPr — persisted Pull Request', () => {
  let tmpDir: string;
  let globalHome: string;
  let previousHome: string | undefined;
  let issueDir: string;
  let tasksPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'issue-flow-pr-'));
    globalHome = await mkdtemp(join(tmpdir(), 'issue-flow-home-'));
    mockRepo.root = tmpDir;

    // runPr calls resolveIssuePaths() with no options, so the override has to
    // reach it through the real process environment.
    previousHome = process.env[GLOBAL_ROOT_ENV];
    process.env[GLOBAL_ROOT_ENV] = globalHome;
    resetStorageResolutionCache();
    headlessOptions.last = null;

    const paths = await resolveIssuePaths('42');
    issueDir = paths.issueDir;
    tasksPath = paths.tasksFile;
    await mkdir(issueDir, { recursive: true });
    await writeFile(tasksPath, JSON.stringify(makePlan(), null, 2), 'utf-8');
  });

  afterEach(async () => {
    resetStorageResolutionCache();
    if (previousHome === undefined) delete process.env[GLOBAL_ROOT_ENV];
    else process.env[GLOBAL_ROOT_ENV] = previousHome;

    await rm(tmpDir, { recursive: true, force: true });
    await rm(globalHome, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function readPlan(): Promise<TaskPlan> {
    return JSON.parse(await readFile(tasksPath, 'utf-8'));
  }

  it('persists pullRequest when the headless output carries a PR URL', async () => {
    headlessOutput.current = 'Done!\nPR created: https://github.com/acme/repo/pull/128\n';

    const code = await runPr('42', makeResolved());

    expect(code).toBe(0);
    const plan = await readPlan();
    expect(plan.pipeline.prCreated).toBe(true);
    expect(plan.pullRequest).toEqual({
      number: 128,
      url: 'https://github.com/acme/repo/pull/128',
      headBranch: 'issue/42-sample',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it('leaves pullRequest absent when no URL can be parsed', async () => {
    headlessOutput.current = 'Pull request opened, but I forgot to print the link.';

    const code = await runPr('42', makeResolved());

    expect(code).toBe(0);
    const plan = await readPlan();
    expect(plan.pipeline.prCreated).toBe(true);
    expect(plan.pullRequest).toBeUndefined();
    expect(Object.hasOwn(plan, 'pullRequest')).toBe(false);
  });

  it('does not fail the phase when tasks.json is missing', async () => {
    await rm(tasksPath);
    headlessOutput.current = 'https://github.com/acme/repo/pull/7';

    await expect(runPr('42', makeResolved())).resolves.toBe(0);
  });

  it('keeps the single-issue prompt free of any multi-issue section', async () => {
    headlessOutput.current = 'https://github.com/acme/repo/pull/128';

    await runPr('42', makeResolved());

    const prompt = String(headlessOptions.last?.prompt);
    expect(prompt).toContain('Closes #42');
    expect(prompt).not.toContain('consolidates several issues');
    expect(prompt).not.toContain('Issues implemented');
    expect(prompt).not.toContain('__MULTI_ISSUE_CONTEXT__');
  });

  it('lists every issue of a queue in the consolidated prompt', async () => {
    headlessOutput.current = 'https://github.com/acme/repo/pull/128';

    await runPr('42', makeResolved(), {
      queue: {
        issues: [
          {
            id: '42',
            number: 42,
            title: 'First',
            url: 'https://github.com/acme/repo/issues/42',
            source: 'github',
          },
          {
            id: '43',
            number: 43,
            title: 'Second',
            url: 'https://github.com/acme/repo/issues/43',
            source: 'github',
          },
        ],
        excluded: [],
        pending: [],
      },
    });

    const prompt = String(headlessOptions.last?.prompt);
    expect(prompt).toContain('Closes #42\nCloses #43');
    expect(prompt).toContain('consolidates several issues');
    expect(prompt).toContain('1. #42 — First');
  });

  it('points the prompt and the headless session at the global issue directory', async () => {
    headlessOutput.current = 'https://github.com/acme/repo/pull/128';

    await runPr('42', makeResolved());

    expect(tasksPath.startsWith(globalHome)).toBe(true);
    expect(String(headlessOptions.last?.prompt)).toContain(tasksPath);
    expect(headlessOptions.last?.addDirs).toEqual([issueDir]);
    // Nothing was written under the legacy tree.
    await expect(readFile(join(tmpDir, 'issues', '42', 'tasks.json'), 'utf-8')).rejects.toThrow();
  });
});

describe('issueClosesLines', () => {
  it('produces one line per issue hosted on GitHub', () => {
    expect(
      issueClosesLines([
        {
          id: '50',
          number: 50,
          title: 'A',
          url: 'https://github.com/acme/repo/issues/50',
          source: 'github',
        },
        {
          id: '51',
          number: 51,
          title: 'B',
          url: 'https://github.com/acme/repo/issues/51',
          source: 'github',
        },
      ]),
    ).toBe('Closes #50\nCloses #51');
  });

  it('skips a local issue, exactly like the single-issue path', () => {
    expect(
      issueClosesLines([
        {
          id: '50',
          number: 50,
          title: 'A',
          url: 'https://github.com/acme/repo/issues/50',
          source: 'github',
        },
        { id: 'auth-refactor', number: null, title: 'B', url: null, source: 'local' },
      ]),
    ).toBe('Closes #50');
  });

  it('still closes a GitHub issue whose read failed during discovery', () => {
    // Discovery swallows a failed `fetchIssue`, leaving the entry with no
    // title and no url — but the queue still runs and closes it, so the body
    // has to reference it.
    expect(
      issueClosesLines([{ id: '52', number: 52, title: '', url: null, source: 'github' }]),
    ).toBe('Closes #52');
  });

  it('is empty when no issue of the queue is hosted on GitHub', () => {
    expect(
      issueClosesLines([{ id: 'a', number: null, title: '', url: null, source: 'local' }]),
    ).toBe('');
  });
});

describe('multiIssueContext', () => {
  const queue = {
    issues: [
      { id: '50', number: 50, title: 'Discovery', url: 'u' },
      { id: '51', number: 51, title: 'Ordering', url: 'u' },
    ],
    excluded: [{ id: '53', number: 53, title: 'Consolidated PR', reason: 'not selected' }],
    pending: ['Issue #51 has unresolved review findings'],
  };

  it('is empty for a standalone run, so the prompt renders as before', () => {
    expect(multiIssueContext(undefined)).toBe('');
    expect(multiIssueContext({ ...queue, issues: [queue.issues[0]] })).toBe('');
  });

  it('lists the execution order and the pending items', () => {
    const context = multiIssueContext(queue);

    expect(context).toContain('1. #50 — Discovery');
    expect(context).toContain('2. #51 — Ordering');
    expect(context).toContain('Issues implemented');
    expect(context).toContain('- #53 — Consolidated PR: not selected');
    expect(context).toContain('- Issue #51 has unresolved review findings');
  });

  it('says so when nothing is pending', () => {
    expect(multiIssueContext({ ...queue, excluded: [], pending: [] })).toContain(
      '(no known pending items)',
    );
  });
});
