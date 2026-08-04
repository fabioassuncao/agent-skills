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
vi.mock('../core/headless.js', () => ({
  runHeadless: vi.fn(async (options: Record<string, unknown>) => {
    headlessOptions.last = options;
    return { success: true, result: headlessOutput.current };
  }),
}));

import type { Issue, ResolvedIssue } from '../issues/types.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import { resetStorageResolutionCache, resolveIssuePaths } from '../storage/resolve.js';
import { runPr } from './pr.js';

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
