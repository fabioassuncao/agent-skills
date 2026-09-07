import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialSnapshot, type SessionEvent } from '../core/session-state.js';
import { loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { getPlanRepository, saveSessionEvent } from '../storage/db/repository.js';
import { GLOBAL_ROOT_ENV, getUnitRunLockPath } from '../storage/paths.js';
import type { TaskPlan } from '../types.js';

vi.mock('../issues/context.js', () => ({
  resolveCommandIssue: vi.fn(async () => ({ ok: true, resolved: { source: 'local' } })),
}));
vi.mock('../issues/registry.js', () => ({
  getProvider: vi.fn(() => ({ get: async () => ({ state: 'closed' }) })),
}));

vi.mock('./run.js', () => ({ runPipeline: vi.fn(async () => 0) }));

const mockProjectRoot = vi.hoisted(() => ({ current: '' }));
/** What `git symbolic-ref -q HEAD` answers; the branch the repository is on. */
const mockHead = vi.hoisted(() => ({ current: 'issue/42-work', detached: false }));
/** Extra git answers a test needs, keyed by argv. */
const mockGit = vi.hoisted(() => ({
  answers: {} as Record<string, { out: string; code: number }>,
}));

vi.mock('execa', () => ({
  execa: vi.fn(async (file: string, args: string[] = []) => {
    const key = args.join(' ');
    const preset = mockGit.answers[key];
    if (preset !== undefined) return { stdout: preset.out, exitCode: preset.code };

    if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { stdout: mockProjectRoot.current, exitCode: 0 };
    }
    if (file === 'git' && args[0] === 'symbolic-ref') {
      return mockHead.detached
        ? { stdout: '', exitCode: 1 }
        : { stdout: `refs/heads/${mockHead.current}\n`, exitCode: 0 };
    }
    // Everything else — the sequencer probes, the conflict list, the status —
    // answers "clean".
    return { stdout: '', exitCode: 1 };
  }),
}));

const { runPipeline } = await import('./run.js');
const { runResume } = await import('./resume.js');
const { resetStorageResolutionCache, resolveIssuePaths, resolveProjectPaths } = await import(
  '../storage/resolve.js'
);

const mockRunPipeline = vi.mocked(runPipeline);

let globalHome: string;
let previousHome: string | undefined;
let repo: string;
let originalCwd: string;

beforeEach(async () => {
  globalHome = await mkdtemp(join(tmpdir(), 'issue-flow-resume-home-'));
  previousHome = process.env[GLOBAL_ROOT_ENV];
  process.env[GLOBAL_ROOT_ENV] = globalHome;

  originalCwd = process.cwd();
  repo = await mkdtemp(join(tmpdir(), 'issue-flow-resume-repo-'));
  mockProjectRoot.current = repo;
  process.chdir(repo);

  mockHead.current = 'issue/42-work';
  mockHead.detached = false;
  mockGit.answers = {};
  resetStorageResolutionCache();
  mockRunPipeline.mockClear();
  mockRunPipeline.mockResolvedValue(0);
});

afterEach(async () => {
  process.chdir(originalCwd);
  resetStorageResolutionCache();
  if (previousHome === undefined) delete process.env[GLOBAL_ROOT_ENV];
  else process.env[GLOBAL_ROOT_ENV] = previousHome;
  await rm(globalHome, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

/** A live lock held by another process. pid 1 exists everywhere and is never us. */
async function writeForeignLock(lockFile: string, target: string): Promise<void> {
  await mkdir(dirname(lockFile), { recursive: true });
  const now = new Date().toISOString();
  await writeFile(
    lockFile,
    JSON.stringify({ pid: 1, host: hostname(), target, startedAt: now, lastHeartbeatAt: now }),
    'utf-8',
  );
}

function plan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    project: 'widgets',
    issueNumber: 42,
    issueUrl: '',
    branchName: 'issue/42-work',
    description: 'Work',
    issueStatus: 'in_progress',
    completedAt: null,
    lastAttemptAt: '2026-08-30T03:00:00.000Z',
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
    userStories: [],
    ...overrides,
  } as TaskPlan;
}

/** Write a plan (and optionally a journal) for `issue` in the global storage. */
async function writeIssue(
  issue: string,
  taskPlan: TaskPlan,
  journalLines: string[] = [],
): Promise<void> {
  const paths = await resolveIssuePaths(issue);
  await saveTaskPlan(paths.tasksFile, taskPlan);
  const repository = getPlanRepository(paths.tasksFile);
  if (repository !== undefined && journalLines.length > 0) {
    const now = new Date().toISOString();
    const initial = createInitialSnapshot();
    const snapshot = {
      ...initial,
      sessionId: `resume-${issue}`,
      status: 'running' as const,
      startedAt: now,
      updatedAt: now,
      issue: { ...initial.issue, number: Number(issue) },
    };
    for (const line of journalLines) {
      const parsed = JSON.parse(line) as { seq: number; event: SessionEvent };
      await saveSessionEvent(repository, {
        sessionId: snapshot.sessionId,
        sequence: parsed.seq,
        event: parsed.event,
        snapshot,
      });
    }
  }
}

/** One journal line, in the shape `JournalPublisher` writes. */
function entry(seq: number, event: Record<string, unknown>): string {
  return JSON.stringify({ seq, event });
}

describe('resume picks the phase up where it stopped', () => {
  it('resumes from the first incomplete phase and never redoes the earlier ones', async () => {
    await writeIssue('42', plan(), [
      entry(1, { type: 'phase:start', at: 'a', phase: 'prd' }),
      entry(2, { type: 'phase:end', at: 'b', phase: 'prd', success: true }),
      entry(3, { type: 'phase:start', at: 'c', phase: 'plan' }),
      entry(4, { type: 'phase:end', at: 'd', phase: 'plan', success: true }),
      // Started and never ended: the process died here.
      entry(5, { type: 'phase:start', at: 'e', phase: 'execute' }),
    ]);

    await expect(runResume('42')).resolves.toBe(0);

    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    const [issue, mode, from] = mockRunPipeline.mock.calls[0] ?? [];
    expect(issue).toBe('42');
    expect(mode).toBe('auto');
    // `prd` and `plan` are marked complete in the plan, so the pipeline is
    // handed `execute` — the phases before it are not run again.
    expect(from).toBe('execute');
  });

  it('finishes an authorized pending closure without invoking pipeline agents', async () => {
    await writeIssue(
      '42',
      plan({
        closeIssue: true,
        lastError: { category: 'issue_closure', message: 'lost response', at: '2026-09-05' },
        pipeline: {
          prdCompleted: true,
          jsonCompleted: true,
          executionCompleted: true,
          reviewCompleted: true,
          prCreated: true,
        },
        userStories: [
          {
            id: 'A',
            title: 'A',
            description: '',
            acceptanceCriteria: [],
            priority: 1,
            passes: true,
            notes: '',
          },
        ],
      }),
    );
    expect(await runResume('42')).toBe(0);
    expect(mockRunPipeline).not.toHaveBeenCalled();
    expect(await loadTaskPlan((await resolveIssuePaths('42')).tasksFile)).toMatchObject({
      issueClosedAt: expect.any(String),
      lastError: null,
      issueStatus: 'completed',
    });
  });

  it('does nothing when every phase is already complete', async () => {
    await writeIssue(
      '42',
      plan({
        pipeline: {
          prdCompleted: true,
          jsonCompleted: true,
          executionCompleted: true,
          reviewCompleted: true,
          prCreated: true,
        },
      }),
    );

    await expect(runResume('42')).resolves.toBe(0);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('reports that there is nothing to resume for an unknown issue', async () => {
    await expect(runResume('999')).resolves.toBe(0);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('honours a plan that opted into pr-review', async () => {
    await writeIssue(
      '42',
      plan({
        pipeline: {
          prdCompleted: true,
          jsonCompleted: true,
          executionCompleted: true,
          reviewCompleted: true,
          prCreated: true,
          prReviewCompleted: false,
        },
        prReview: { enabled: true, rounds: 0 },
      }),
    );

    await expect(runResume('42')).resolves.toBe(0);
    expect(mockRunPipeline.mock.calls[0]?.[2]).toBe('pr-review');
  });

  it('skips the pr phase for a --no-branch plan', async () => {
    await writeIssue(
      '42',
      plan({
        noBranch: true,
        pipeline: {
          prdCompleted: true,
          jsonCompleted: true,
          executionCompleted: true,
          reviewCompleted: true,
          prCreated: false,
        },
      }),
    );

    await expect(runResume('42')).resolves.toBe(0);
    // Every phase of the no-branch set is complete: `pr` is not one of them.
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });
});

describe('resume without an issue', () => {
  it('picks the most recently attempted unfinished issue', async () => {
    await writeIssue('41', plan({ lastAttemptAt: '2026-08-29T00:00:00.000Z' }));
    await writeIssue('42', plan({ lastAttemptAt: '2026-08-30T00:00:00.000Z' }));

    await expect(runResume()).resolves.toBe(0);

    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    expect(mockRunPipeline.mock.calls[0]?.[0]).toBe('42');
  });

  it('resumes every unfinished issue with --all', async () => {
    await writeIssue('41', plan({ lastAttemptAt: '2026-08-29T00:00:00.000Z' }));
    await writeIssue('42', plan({ lastAttemptAt: '2026-08-30T00:00:00.000Z' }));

    await expect(runResume(undefined, { all: true })).resolves.toBe(0);

    expect(mockRunPipeline.mock.calls.map((call) => call[0])).toEqual(['42', '41']);
  });

  it('says so when nothing is unfinished', async () => {
    await expect(runResume()).resolves.toBe(0);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });
});

describe('the repository is checked before anything runs', () => {
  it('refuses on a merge in progress, without repairing it', async () => {
    mockGit.answers['rev-parse --verify --quiet MERGE_HEAD'] = { out: 'abc123', code: 0 };
    await writeIssue('42', plan());

    await expect(runResume('42')).resolves.toBe(1);

    expect(mockRunPipeline).not.toHaveBeenCalled();
    const { execa } = await import('execa');
    for (const [, args] of vi.mocked(execa).mock.calls) {
      const argv = (args ?? []).join(' ');
      expect(argv).not.toContain('--abort');
      expect(argv).not.toContain('reset');
      expect(argv).not.toContain('stash');
    }
  });

  it('refuses when the repository is on another branch, naming both', async () => {
    mockHead.current = 'main';
    await writeIssue('42', plan());

    await expect(runResume('42')).resolves.toBe(1);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  it('continues with a dirty tree when resuming the very phase that dirtied it', async () => {
    mockGit.answers['status --porcelain'] = { out: ' M src/a.ts\n', code: 0 };
    await writeIssue('42', plan(), [entry(1, { type: 'phase:start', at: 'a', phase: 'execute' })]);

    await expect(runResume('42')).resolves.toBe(0);
    expect(mockRunPipeline.mock.calls[0]?.[2]).toBe('execute');
  });

  it('refuses a dirty tree when the next phase is not the interrupted one', async () => {
    mockGit.answers['status --porcelain'] = { out: ' M src/a.ts\n', code: 0 };
    // The journal says `prd` was interrupted, but the plan says `prd` finished:
    // the changes in the tree belong to work the resume is not continuing.
    await writeIssue('42', plan(), [entry(1, { type: 'phase:start', at: 'a', phase: 'prd' })]);

    await expect(runResume('42')).resolves.toBe(1);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });
});

describe('run ownership', () => {
  it('refuses while a live owner holds the project lock', async () => {
    const { runLockFile } = await resolveProjectPaths();
    await mkdir(dirname(runLockFile), { recursive: true });
    await writeFile(
      runLockFile,
      JSON.stringify({
        pid: 1,
        host: hostname(),
        target: '42',
        startedAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
      }),
      'utf-8',
    );
    await writeIssue('42', plan());

    await expect(runResume('42')).resolves.toBe(1);
    expect(mockRunPipeline).not.toHaveBeenCalled();
  });

  // §31.3: `run` and `resume` have to contend for the *same* thing. Above the
  // default ceiling a run holds a lock on its unit, so a resume still taking the
  // project lock would exclude nothing — and two processes would work one issue.
  describe('above the default ceiling', () => {
    const previous = process.env.ISSUE_FLOW_RUNTIME_MAX_CONCURRENT;

    beforeEach(() => {
      process.env.ISSUE_FLOW_RUNTIME_MAX_CONCURRENT = '3';
    });

    afterEach(() => {
      if (previous === undefined) delete process.env.ISSUE_FLOW_RUNTIME_MAX_CONCURRENT;
      else process.env.ISSUE_FLOW_RUNTIME_MAX_CONCURRENT = previous;
    });

    // Asserted as exclusion rather than as a file: the lock is released when the
    // resume finishes, so what matters is *what it contends with*.
    it('stops contending for the project lock', async () => {
      const { runLockFile } = await resolveProjectPaths();
      await writeForeignLock(runLockFile, 'somebody else');
      await writeIssue('42', plan());

      await expect(runResume('42')).resolves.toBe(0);
      expect(mockRunPipeline).toHaveBeenCalledTimes(1);
    });

    it('refuses when another process already holds that issue', async () => {
      const { projectDir } = await resolveProjectPaths();
      await writeForeignLock(getUnitRunLockPath(projectDir, '42'), '42');
      await writeIssue('42', plan());

      await expect(runResume('42')).resolves.toBe(1);
      expect(mockRunPipeline).not.toHaveBeenCalled();
    });

    // A bare `resume` may touch several issues and every pending queue. There is
    // no single unit it could name, so it excludes everything rather than
    // guessing at its own scope.
    it('falls back to the project lock when no issue is named', async () => {
      const { runLockFile } = await resolveProjectPaths();
      await writeForeignLock(runLockFile, 'somebody else');
      await writeIssue('42', plan());

      await expect(runResume()).resolves.toBe(1);
      expect(mockRunPipeline).not.toHaveBeenCalled();
    });
  });

  it('takes over a lock whose owner is gone', async () => {
    const { runLockFile } = await resolveProjectPaths();
    await mkdir(dirname(runLockFile), { recursive: true });
    await writeFile(
      runLockFile,
      JSON.stringify({
        pid: 0x7ffffffe,
        host: hostname(),
        target: '42',
        startedAt: '2026-08-30T03:00:00.000Z',
        lastHeartbeatAt: '2026-08-30T03:00:00.000Z',
      }),
      'utf-8',
    );
    await writeIssue('42', plan());

    await expect(runResume('42')).resolves.toBe(0);
    expect(mockRunPipeline).toHaveBeenCalledTimes(1);
  });
});
