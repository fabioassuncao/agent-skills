import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskPlan } from '../types.js';

// resolveIssuePaths() and determineUserStoryNumbering() both shell out to git
// (`rev-parse --show-toplevel`, `remote get-url origin`); execa is the single
// seam both go through.
const mockRepo = vi.hoisted(() => ({ root: '', remote: '' }));
vi.mock('execa', () => ({
  execa: vi.fn(async (file: string, args: string[] = []) => {
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { stdout: mockRepo.root, exitCode: 0 };
    }
    if (file === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
      return mockRepo.remote
        ? { stdout: mockRepo.remote, exitCode: 0 }
        : { stdout: '', exitCode: 1 };
    }
    return { stdout: '', exitCode: 0 };
  }),
}));

const headlessOptions = vi.hoisted(() => ({ last: null as Record<string, unknown> | null }));

vi.mock('../core/headless.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/headless.js')>()),
  runHeadless: vi.fn(async (options: Record<string, unknown>) => {
    headlessOptions.last = options;
    const plan = {
      description: 'Test plan',
      stories: [
        {
          key: 'first-story',
          title: 'First story',
          description: 'As a user, I want X',
          acceptanceCriteria: ['Typecheck passes'],
        },
      ],
    };
    return {
      success: true,
      result: `<task-plan>${JSON.stringify(plan)}</task-plan>`,
      cost: null,
      error: null,
    };
  }),
}));

// The numbering decision is logged, never silent — capture instead of printing.
vi.mock('../ui/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/logger.js')>();
  return {
    ...actual,
    printInfo: vi.fn(),
    printSuccess: vi.fn(),
    printError: vi.fn(),
    printWarning: vi.fn(),
  };
});

import type { Issue, ResolvedIssue } from '../issues/types.js';
import { openIssueFlowDatabase } from '../storage/db/index.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import { resetStorageResolutionCache, resolveIssuePaths } from '../storage/resolve.js';
import { printInfo, printWarning } from '../ui/logger.js';
import { runPlan } from './plan.js';

const mockPrintInfo = vi.mocked(printInfo);
const mockPrintWarning = vi.mocked(printWarning);

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

describe('runPlan — User Story numbering continuity (issue #36)', () => {
  let tmpDir: string;
  let globalHome: string;
  let previousHome: string | undefined;
  let issueDir: string;
  let tasksPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'issue-flow-plan-'));
    globalHome = await mkdtemp(join(tmpdir(), 'issue-flow-home-'));
    mockRepo.root = tmpDir;
    mockRepo.remote = '';

    // runPlan (and determineUserStoryNumbering inside it) call resolveIssuePaths()
    // / getProjectRoot() with no options, so the override has to reach them
    // through the real process environment.
    previousHome = process.env[GLOBAL_ROOT_ENV];
    process.env[GLOBAL_ROOT_ENV] = globalHome;
    resetStorageResolutionCache();
    headlessOptions.last = null;
    mockPrintInfo.mockClear();
    mockPrintWarning.mockClear();

    const paths = await resolveIssuePaths('42');
    issueDir = paths.issueDir;
    tasksPath = paths.tasksFile;
    await mkdir(issueDir, { recursive: true });
    await writeFile(paths.prdFile, '# PRD\n\nSome requirements.', 'utf-8');
  });

  afterEach(async () => {
    resetStorageResolutionCache();
    if (previousHome === undefined) delete process.env[GLOBAL_ROOT_ENV];
    else process.env[GLOBAL_ROOT_ENV] = previousHome;

    await rm(tmpDir, { recursive: true, force: true });
    await rm(globalHome, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  async function readStoredNumbering(): Promise<Record<string, unknown> | undefined> {
    const { resolveProjectPaths } = await import('../storage/resolve.js');
    const { projectId } = await resolveProjectPaths({});
    const database = await openIssueFlowDatabase();
    try {
      return database
        .prepare(
          `SELECT next_number AS nextNumber, source, issue_id AS issueNumber,
                  decided_at AS decidedAt, detail
           FROM user_story_numbering WHERE project_id = ?`,
        )
        .get<Record<string, unknown>>(projectId);
    } finally {
      database.close();
    }
  }

  async function seedPriorStory(): Promise<void> {
    const { resolveProjectPaths } = await import('../storage/resolve.js');
    const { projectId } = await resolveProjectPaths({});
    const { seedStoriesForNumbering } = await import('../storage/db/test-seed.js');
    await seedStoriesForNumbering({
      projectId,
      projectRoot: tmpDir,
      issueId: '12',
      stories: [{ id: 'US-015', number: 15, passes: true }],
    });
  }

  it('starts at US-001 with no prior history for the project', async () => {
    const code = await runPlan('42', makeResolved());

    expect(code).toBe(0);
    expect((JSON.parse(await readFile(tasksPath, 'utf8')) as TaskPlan).userStories[0]?.id).toBe(
      'US-001',
    );
    const messages = mockPrintInfo.mock.calls.map(([line]) => String(line));
    expect(messages.some((m) => m.includes('US-001') && m.includes('no previous history'))).toBe(
      true,
    );

    expect(await readStoredNumbering()).toMatchObject({ nextNumber: 1, source: 'none' });
  });

  it('continues numbering automatically from a previous issue in the same project', async () => {
    // Seed history: another issue in the same project already used up to US-015.
    await seedPriorStory();

    const code = await runPlan('42', makeResolved());

    expect(code).toBe(0);
    expect((JSON.parse(await readFile(tasksPath, 'utf8')) as TaskPlan).userStories[0]?.id).toBe(
      'US-016',
    );
    const messages = mockPrintInfo.mock.calls.map(([line]) => String(line));
    expect(messages.some((m) => m.includes('Continuing') && m.includes('US-016'))).toBe(true);

    expect(await readStoredNumbering()).toMatchObject({ nextNumber: 16, source: 'history' });
  });

  it('--start-us forces the numbering and ignores history', async () => {
    await seedPriorStory();

    const code = await runPlan('42', makeResolved(), { startUs: 27 });

    expect(code).toBe(0);
    expect((JSON.parse(await readFile(tasksPath, 'utf8')) as TaskPlan).userStories[0]?.id).toBe(
      'US-027',
    );
    const messages = mockPrintInfo.mock.calls.map(([line]) => String(line));
    expect(messages.some((m) => m.includes('forced') && m.includes('US-027'))).toBe(true);

    expect(await readStoredNumbering()).toMatchObject({ nextNumber: 27, source: 'start-us' });
  });

  it('--continue names the flag explicitly in the log while resolving the same number', async () => {
    await seedPriorStory();

    const code = await runPlan('42', makeResolved(), { continueFlag: true });

    expect(code).toBe(0);
    const messages = mockPrintInfo.mock.calls.map(([line]) => String(line));
    expect(messages.some((m) => m.includes('--continue') && m.includes('US-016'))).toBe(true);
  });

  it('re-running plan on the same issue does not push its own numbering forward', async () => {
    await seedPriorStory();

    expect(await runPlan('42', makeResolved())).toBe(0);
    // Second run over the tasks.json the first one just wrote (US-016).
    expect(await runPlan('42', makeResolved())).toBe(0);

    expect((JSON.parse(await readFile(tasksPath, 'utf8')) as TaskPlan).userStories[0]?.id).toBe(
      'US-016',
    );
    expect(await readStoredNumbering()).toMatchObject({ nextNumber: 16, source: 'history' });
  });

  it('assigns numbering in code rather than trusting generated IDs', async () => {
    await seedPriorStory();

    expect(await runPlan('42', makeResolved())).toBe(0);

    const plan = JSON.parse(await readFile(tasksPath, 'utf8')) as TaskPlan;
    expect(plan.userStories[0]?.id).toBe('US-016');
    expect(mockPrintWarning).not.toHaveBeenCalled();
  });

  it('is unaffected when tasksPath and prdPath differ from earlier fixtures', async () => {
    // Sanity: the plan produced by the (mocked) headless call is still
    // validated and reported as a success as before.
    const code = await runPlan('42', makeResolved());
    expect(code).toBe(0);

    const plan: TaskPlan = JSON.parse(await readFile(tasksPath, 'utf-8'));
    expect(plan.pipeline.jsonCompleted).toBe(true);
  });
});
