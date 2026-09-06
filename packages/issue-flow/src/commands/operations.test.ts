import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInitialSnapshot, type SessionEvent } from '../core/session-state.js';
import { saveTaskPlan } from '../core/state-manager.js';
import { getPlanRepository, saveSessionEvent } from '../storage/db/repository.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import type { TaskPlan } from '../types.js';

const mockProjectRoot = vi.hoisted(() => ({ current: '' }));
vi.mock('execa', () => ({
  execa: vi.fn(async (file: string, args: string[] = []) => {
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { stdout: mockProjectRoot.current, exitCode: 0 };
    }
    return { stdout: '', exitCode: 1 };
  }),
}));

// The five commands print; the assertions are about what they say.
const printed = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../ui/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/logger.js')>();
  const record = (message: string) => void printed.lines.push(message);
  return { ...actual, printInfo: record, printWarning: record, printError: record };
});

const { runCancel, runLogs, runPause, runRuns, runStatus } = await import('./operations.js');
const { resetStorageResolutionCache, resolveIssuePaths, resolveProjectPaths } = await import(
  '../storage/resolve.js'
);
const { getIssuePaths } = await import('../storage/paths.js');

let globalHome: string;
let previousHome: string | undefined;
let repo: string;
let originalCwd: string;

beforeEach(async () => {
  globalHome = await mkdtemp(join(tmpdir(), 'issue-flow-ops-home-'));
  previousHome = process.env[GLOBAL_ROOT_ENV];
  process.env[GLOBAL_ROOT_ENV] = globalHome;

  originalCwd = process.cwd();
  repo = await mkdtemp(join(tmpdir(), 'issue-flow-ops-repo-'));
  mockProjectRoot.current = repo;
  process.chdir(repo);

  printed.lines = [];
  resetStorageResolutionCache();
});

afterEach(async () => {
  process.chdir(originalCwd);
  resetStorageResolutionCache();
  if (previousHome === undefined) delete process.env[GLOBAL_ROOT_ENV];
  else process.env[GLOBAL_ROOT_ENV] = previousHome;
  await rm(globalHome, { recursive: true, force: true });
  await rm(repo, { recursive: true, force: true });
});

const output = (): string => printed.lines.join('\n');

function plan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    project: 'widgets',
    issueNumber: 42,
    issueUrl: '',
    branchName: 'issue/42-work',
    description: 'Work',
    issueStatus: 'in_progress',
    completedAt: null,
    lastAttemptAt: new Date().toISOString(),
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

async function writeIssue(
  issue: string,
  taskPlan: TaskPlan,
  extras: { journal?: string[]; session?: Record<string, unknown> } = {},
): Promise<void> {
  const paths = await resolveIssuePaths(issue);
  await saveTaskPlan(paths.tasksFile, taskPlan);
  const repository = getPlanRepository(paths.tasksFile);
  if (repository !== undefined && (extras.journal !== undefined || extras.session !== undefined)) {
    const now = new Date().toISOString();
    const initial = createInitialSnapshot();
    const execution = extras.session?.execution as Partial<typeof initial.execution> | undefined;
    const snapshot = {
      ...initial,
      sessionId: `operations-${issue}`,
      status: 'running' as const,
      startedAt: now,
      updatedAt: now,
      elapsedSeconds: (extras.session?.elapsedSeconds as number | undefined) ?? null,
      execution: { ...initial.execution, ...execution },
      issue: { ...initial.issue, number: Number(issue) },
    };
    const journal = extras.journal ?? [entry(1, { type: 'session:start', at: now })];
    for (const line of journal) {
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

async function writeLock(overrides: Record<string, unknown> = {}): Promise<void> {
  const { runLockFile } = await resolveProjectPaths();
  await mkdir(dirname(runLockFile), { recursive: true });
  await writeFile(
    runLockFile,
    JSON.stringify({
      pid: process.pid,
      host: hostname(),
      target: '42',
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      ...overrides,
    }),
    'utf-8',
  );
}

function entry(seq: number, event: Record<string, unknown>): string {
  return JSON.stringify({ seq, event });
}

describe('status', () => {
  it('says nothing is running when there is no lock', async () => {
    await expect(runStatus()).resolves.toBe(0);
    expect(output()).toContain('Nothing is running');
  });

  it('names the owner and how long since it said anything', async () => {
    await writeLock();
    await writeIssue('42', plan());

    await expect(runStatus()).resolves.toBe(0);

    expect(output()).toContain(`pid ${process.pid}`);
    expect(output()).toContain('Last heartbeat');
  });

  it('reports a stale lock as stale instead of as a running job', async () => {
    await writeLock({ pid: 0x7ffffffe, lastHeartbeatAt: '2026-08-30T03:00:00.000Z' });

    await expect(runStatus()).resolves.toBe(0);

    expect(output()).toContain('stale lock');
  });

  it('answers the phase, the attempt and the last activity for an issue', async () => {
    await writeIssue(
      '42',
      plan({
        runState: {
          status: 'retrying',
          currentPhase: 'execute',
          attempt: 3,
          lastHeartbeatAt: null,
          blockedReason: null,
          owner: null,
        },
      }),
    );

    await expect(runStatus('42')).resolves.toBe(0);

    expect(output()).toContain('#42');
    expect(output()).toContain('retrying');
    expect(output()).toContain('phase execute');
    expect(output()).toContain('attempt 3');
    expect(output()).toContain('last activity');
  });

  it('surfaces a blocked reason instead of burying it', async () => {
    await writeIssue(
      '42',
      plan({
        runState: {
          status: 'blocked',
          currentPhase: null,
          attempt: 1,
          lastHeartbeatAt: null,
          blockedReason: 'gh auth login required',
          owner: null,
        },
      }),
    );

    await runStatus('42');

    expect(output()).toContain('gh auth login required');
  });

  it('emits the assembled state as JSON on --json', async () => {
    await writeLock();
    await writeIssue('42', plan());

    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(runStatus(undefined, { json: true })).resolves.toBe(0);
    const payload = JSON.parse(stdout.mock.calls.map(([line]) => line).join('\n'));
    stdout.mockRestore();
    expect(payload.owner.pid).toBe(process.pid);
    expect(payload.issues[0]).toMatchObject({ id: '42', issueStatus: 'in_progress' });
  });
});

describe('runs', () => {
  it('says so when the project has no history', async () => {
    await expect(runRuns()).resolves.toBe(0);
    expect(output()).toContain('No runs recorded');
  });

  it('lists each issue with its status, duration and failure cause', async () => {
    await writeIssue(
      '42',
      plan({
        issueStatus: 'in_progress',
        lastError: { category: 'phase_failed', message: 'Tests failed', at: 'x' },
      }),
      { session: { elapsedSeconds: 125, execution: { retries: 2 } } },
    );

    await expect(runRuns()).resolves.toBe(0);

    expect(output()).toContain('#42');
    expect(output()).toContain('in_progress');
    expect(output()).toContain('2m 5s');
    expect(output()).toContain('Tests failed');
  });
});

describe('logs', () => {
  it('explains how to get a journal when there is none', async () => {
    await writeIssue('42', plan());

    await expect(runLogs('42')).resolves.toBe(0);

    expect(output()).toContain('no journal');
    expect(output()).toContain('--continuous');
  });

  it('prints the journal in order, with the detail of each event', async () => {
    await writeIssue('42', plan(), {
      journal: [
        entry(1, { type: 'phase:start', at: '2026-08-30T03:00:00Z', phase: 'prd' }),
        entry(2, {
          type: 'retry',
          at: '2026-08-30T03:02:00Z',
          attempt: 1,
          delaySeconds: 15,
          reason: 'claude exited with code 143',
        }),
        entry(3, { type: 'phase:end', at: '2026-08-30T03:05:00Z', phase: 'prd', success: true }),
      ],
    });

    await expect(runLogs('42')).resolves.toBe(0);

    const lines = printed.lines;
    expect(lines[0]).toContain('phase:start');
    expect(lines[1]).toContain('retry');
    expect(lines[1]).toContain('claude exited with code 143');
    expect(lines[2]).toContain('phase:end');
  });

  it('filters by kind, which is what makes six hours readable', async () => {
    await writeIssue('42', plan(), {
      journal: [
        entry(1, { type: 'phase:start', at: 'a', phase: 'prd' }),
        entry(2, { type: 'retry', at: 'b', attempt: 1, delaySeconds: 15, reason: 'network' }),
        entry(3, { type: 'log', at: 'c', level: 'info', message: 'noise' }),
        entry(4, { type: 'retry', at: 'd', attempt: 2, delaySeconds: 30, reason: 'network' }),
      ],
    });

    await runLogs('42', { kind: ['retry'] });

    expect(printed.lines).toHaveLength(2);
    expect(output()).not.toContain('noise');
  });

  it('shows only the tail by default', async () => {
    await writeIssue('42', plan(), {
      journal: Array.from({ length: 20 }, (_, index) =>
        entry(index + 1, { type: 'log', at: 'x', level: 'info', message: `line ${index}` }),
      ),
    });

    await runLogs('42', { tail: 5 });

    expect(printed.lines).toHaveLength(5);
    expect(output()).toContain('line 19');
    expect(output()).not.toContain('line 14');
  });
});

describe('pause and cancel', () => {
  it('pause says there is nothing to stop when nothing is running', async () => {
    await expect(runPause()).resolves.toBe(0);
    expect(output()).toContain('Nothing is running');
  });

  it('pause asks the owner to stop, and lets the owner do the stopping', async () => {
    // A live pid, because a stale lock is deliberately never signalled.
    await writeLock({ pid: process.pid });
    const signalled: [number, string][] = [];

    await expect(
      runPause({ signalProcess: (pid, signal) => void signalled.push([pid, signal]) }),
    ).resolves.toBe(0);

    // SIGTERM is the whole implementation: the owner already knows how to stop
    // well, and reimplementing that from outside would be a worse version.
    expect(signalled).toEqual([[process.pid, 'SIGTERM']]);
    expect(output()).toContain('checkpoint');
  });

  it('pause refuses to signal a stale owner', async () => {
    await writeLock({ pid: 0x7ffffffe, lastHeartbeatAt: '2026-08-30T03:00:00.000Z' });
    const signalled: number[] = [];

    await runPause({ signalProcess: (pid) => void signalled.push(pid) });

    expect(signalled).toEqual([]);
    expect(output()).toContain('stale');
  });

  it('cancel stops the owner and marks the issue so a resume reports it', async () => {
    await writeLock({ pid: process.pid });
    await writeIssue('42', plan());

    await expect(runCancel('42', { signalProcess: () => {} })).resolves.toBe(0);

    const { projectId } = await resolveProjectPaths();
    const { readFile } = await import('node:fs/promises');
    const saved = JSON.parse(
      await readFile(getIssuePaths(projectId, '42').tasksFile, 'utf-8'),
    ) as TaskPlan;
    expect(saved.runState?.status).toBe('blocked');
    expect(saved.runState?.blockedReason).toContain('Cancelled');
  });
});
