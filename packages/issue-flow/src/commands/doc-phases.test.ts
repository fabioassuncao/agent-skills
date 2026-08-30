import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskPlan } from '../types.js';

/**
 * The three documentation phases (`analyze`, `prd`, `plan`) share one contract:
 * every artifact they read or write is resolved through `resolveIssuePaths()`,
 * so it lands under the global storage and never under `<repoRoot>/issues/`.
 * They are tested together because the fixture — a temporary repo root, a
 * temporary `ISSUE_FLOW_HOME`, and a headless stub that plays the agent's role
 * of writing the file — is identical for all three.
 */

// getProjectRoot() and getRemoteUrl() both shell out through execa; the mock
// answers with the temporary repo root and a stable remote, so the derived
// project id is deterministic.
const mockRepo = vi.hoisted(() => ({ root: '', remote: 'https://github.com/acme/widgets.git' }));
vi.mock('execa', () => ({
  execa: vi.fn(async (file: string, args: string[] = []) => {
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { stdout: mockRepo.root, exitCode: 0 };
    }
    if (file === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
      return { stdout: mockRepo.remote, exitCode: 0 };
    }
    return { stdout: '', exitCode: 0 };
  }),
}));

// Stands in for the Claude session: receives the real options the command
// built (including `addDirs`) and may write the artifact the phase expects.
const headlessStub = vi.hoisted(() => ({
  run: async (_options: unknown): Promise<void> => {},
  result: '',
  cost: null as Record<string, number> | null,
}));
vi.mock('../core/headless.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/headless.js')>()),
  runHeadless: vi.fn(async (options: unknown) => {
    await headlessStub.run(options);
    return { success: true, result: headlessStub.result, cost: headlessStub.cost, error: null };
  }),
}));

// Only the backoff sleep is faked — `isTransientFailure` and
// `retryDelaySeconds` keep running for real, so the retry decision itself is
// still the production one; the test just doesn't wait 45s for it.
vi.mock('../utils/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/retry.js')>();
  return { ...actual, sleep: vi.fn(async () => {}) };
});

vi.mock('../ui/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/logger.js')>();
  return { ...actual, printSuccess: vi.fn(), printError: vi.fn(), printInfo: vi.fn() };
});

const { runHeadless } = await import('../core/headless.js');
const { printError, printSuccess } = await import('../ui/logger.js');
const { GLOBAL_ROOT_ENV } = await import('../storage/paths.js');
const { resetStorageResolutionCache, resolveIssuePaths } = await import('../storage/resolve.js');
const { runAnalyze } = await import('./analyze.js');
const { runPlan } = await import('./plan.js');
const { runPrd } = await import('./prd.js');

const mockRunHeadless = vi.mocked(runHeadless);
const mockPrintError = vi.mocked(printError);
const mockPrintSuccess = vi.mocked(printSuccess);

import { setSessionPublisher } from '../core/session-publisher.js';
import { MemoryPublisher, type SessionEvent } from '../core/session-state.js';
import type { Issue, ResolvedIssue } from '../issues/types.js';
import type { IssuePaths } from '../storage/paths.js';

/** Publisher that keeps every event, so the metrics payload can be asserted. */
class RecordingPublisher extends MemoryPublisher {
  readonly events: SessionEvent[] = [];

  protected override afterPublish(event: SessionEvent): void {
    this.events.push(event);
  }
}

function makeResolved(): ResolvedIssue {
  const issue: Issue = {
    id: '42',
    number: 42,
    title: 'Sample issue',
    body: 'Body',
    labels: [],
    state: 'open',
    source: 'github',
    remoteRef: 'https://github.com/acme/widgets/issues/42',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    contentHash: 'sha256:abc',
  };
  return { issue, source: 'github', local: null, github: issue, divergent: false };
}

function makePlan(): TaskPlan {
  return {
    project: 'widgets',
    issueNumber: 42,
    issueUrl: 'https://github.com/acme/widgets/issues/42',
    branchName: 'issue/42-sample',
    description: 'Test plan',
    issueStatus: 'in_progress',
    completedAt: null,
    lastAttemptAt: null,
    lastError: null,
    correctionCycle: 0,
    maxCorrectionCycles: 3,
    lastReviewFindings: null,
    pipeline: {
      prdCompleted: false,
      jsonCompleted: false,
      executionCompleted: false,
      reviewCompleted: false,
      prCreated: false,
    },
    userStories: [
      {
        id: 'US-001',
        title: 'First story',
        description: 'Test story',
        acceptanceCriteria: ['Criterion 1'],
        priority: 1,
        passes: false,
        notes: '',
      },
    ],
  };
}

let temps: string[] = [];
let repoRoot: string;
let globalHome: string;
let previousHome: string | undefined;

async function makeTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** The paths the command under test is expected to have used. */
function expectedPaths(issueNumber: string | number): Promise<IssuePaths> {
  return resolveIssuePaths(issueNumber);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Everything the phase printed on success, as one string. */
function successOutput(): string {
  return mockPrintSuccess.mock.calls.map(([line]) => line).join('\n');
}

/** The `addDirs` of the last runHeadless call. */
function lastAddDirs(): string[] | undefined {
  return mockRunHeadless.mock.calls.at(-1)?.[0].addDirs;
}

beforeEach(async () => {
  repoRoot = await makeTemp('issue-flow-repo-');
  globalHome = await makeTemp('issue-flow-home-');
  mockRepo.root = repoRoot;

  // The commands call resolveIssuePaths() with no options, so the override has
  // to reach them through the real process environment.
  previousHome = process.env[GLOBAL_ROOT_ENV];
  process.env[GLOBAL_ROOT_ENV] = globalHome;

  resetStorageResolutionCache();
  headlessStub.run = async () => {};
  headlessStub.result = '';
  headlessStub.cost = null;
  vi.clearAllMocks();
});

afterEach(async () => {
  resetStorageResolutionCache();
  if (previousHome === undefined) delete process.env[GLOBAL_ROOT_ENV];
  else process.env[GLOBAL_ROOT_ENV] = previousHome;

  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
  temps = [];
});

describe('runAnalyze', () => {
  it('writes analysis.md under the global storage, never under <repoRoot>/issues/', async () => {
    const paths = await expectedPaths(42);
    headlessStub.run = async () => {
      await writeFile(paths.analysisFile, '# Analysis of the issue', 'utf-8');
    };

    await expect(runAnalyze('42', makeResolved())).resolves.toBe(0);

    await expect(readFile(paths.analysisFile, 'utf-8')).resolves.toContain('# Analysis');
    expect(paths.analysisFile.startsWith(globalHome)).toBe(true);
    expect(await exists(join(repoRoot, 'issues'))).toBe(false);
    expect(successOutput()).toContain(paths.analysisFile);
  });

  it('grants the headless session access to the global issue directory', async () => {
    const paths = await expectedPaths(42);
    headlessStub.run = async () => {
      await writeFile(paths.analysisFile, '# Analysis of the issue', 'utf-8');
    };

    await runAnalyze('42', makeResolved());

    expect(lastAddDirs()).toEqual([paths.issueDir]);
  });

  it('falls back to saving the headless output when no file was created', async () => {
    const paths = await expectedPaths(42);
    headlessStub.result = 'Analysis produced inline instead of written to disk';

    await expect(runAnalyze('42', makeResolved())).resolves.toBe(0);

    await expect(readFile(paths.analysisFile, 'utf-8')).resolves.toBe(headlessStub.result);
    expect(await exists(join(repoRoot, 'issues'))).toBe(false);
  });

  it('updates the pipeline state of the global tasks.json', async () => {
    const paths = await expectedPaths(42);
    await mkdir(paths.issueDir, { recursive: true });
    await writeFile(paths.tasksFile, JSON.stringify(makePlan(), null, 2), 'utf-8');
    headlessStub.result = 'inline analysis';

    await runAnalyze('42', makeResolved());

    const plan: TaskPlan = JSON.parse(await readFile(paths.tasksFile, 'utf-8'));
    expect(plan.pipeline.analyzeCompleted).toBe(true);
  });
});

describe('runPrd', () => {
  it('writes prd.md under the global storage, never under <repoRoot>/issues/', async () => {
    const paths = await expectedPaths(42);
    headlessStub.run = async () => {
      await writeFile(paths.prdFile, '# PRD for issue 42', 'utf-8');
    };

    await expect(runPrd('42', makeResolved())).resolves.toBe(0);

    await expect(readFile(paths.prdFile, 'utf-8')).resolves.toContain('# PRD');
    expect(await exists(join(repoRoot, 'issues'))).toBe(false);
    expect(successOutput()).toContain(paths.prdFile);
    expect(lastAddDirs()).toEqual([paths.issueDir]);
  });

  // Three attempts, each spending the readFileWithGrace budget (~1.1s) before
  // giving up — the retry backoff itself is stubbed out above.
  it('reports the global path when the PRD was not created', { timeout: 20_000 }, async () => {
    const paths = await expectedPaths(42);

    await expect(runPrd('42', makeResolved())).resolves.toBe(1);

    const errors = mockPrintError.mock.calls.map(([line]) => line).join('\n');
    expect(errors).toContain(paths.prdFile);
  });

  // The prompt used to name `issues/<N>/analysis.md` relative to the repository;
  // that path no longer exists, so the analysis has to be pointed at explicitly.
  it('points the prompt at the global analysis.md', async () => {
    const paths = await expectedPaths(42);
    headlessStub.run = async () => {
      await writeFile(paths.prdFile, '# PRD for issue 42', 'utf-8');
    };

    await runPrd('42', makeResolved());

    const prompt = mockRunHeadless.mock.calls.at(-1)?.[0].prompt ?? '';
    expect(prompt).toContain(paths.analysisFile);
    expect(prompt).not.toContain('__ANALYSIS_PATH__');
  });

  it('updates the pipeline state of the global tasks.json', async () => {
    const paths = await expectedPaths(42);
    await mkdir(paths.issueDir, { recursive: true });
    await writeFile(paths.tasksFile, JSON.stringify(makePlan(), null, 2), 'utf-8');
    headlessStub.run = async () => {
      await writeFile(paths.prdFile, '# PRD for issue 42', 'utf-8');
    };

    await runPrd('42', makeResolved());

    const plan: TaskPlan = JSON.parse(await readFile(paths.tasksFile, 'utf-8'));
    expect(plan.pipeline.prdCompleted).toBe(true);
  });
});

describe('runPlan', () => {
  it('reads the global prd.md and writes the global tasks.json', async () => {
    const paths = await expectedPaths(42);
    await mkdir(paths.issueDir, { recursive: true });
    await writeFile(paths.prdFile, '# PRD for issue 42', 'utf-8');
    headlessStub.run = async () => {
      await writeFile(paths.tasksFile, JSON.stringify(makePlan(), null, 2), 'utf-8');
    };

    await expect(runPlan('42', makeResolved())).resolves.toBe(0);

    const plan: TaskPlan = JSON.parse(await readFile(paths.tasksFile, 'utf-8'));
    expect(plan.pipeline.jsonCompleted).toBe(true);
    expect(await exists(join(repoRoot, 'issues'))).toBe(false);
    expect(successOutput()).toContain(paths.tasksFile);
    expect(lastAddDirs()).toEqual([paths.issueDir]);
  });

  it('passes the PRD content of the global tree into the prompt', async () => {
    const paths = await expectedPaths(42);
    await mkdir(paths.issueDir, { recursive: true });
    await writeFile(paths.prdFile, '# PRD marker 8f21', 'utf-8');
    headlessStub.run = async () => {
      await writeFile(paths.tasksFile, JSON.stringify(makePlan(), null, 2), 'utf-8');
    };

    await runPlan('42', makeResolved());

    const prompt = mockRunHeadless.mock.calls.at(-1)?.[0].prompt ?? '';
    expect(prompt).toContain('# PRD marker 8f21');
    expect(prompt).toContain(paths.tasksFile);
  });

  it('names the global path when the PRD is missing', async () => {
    const paths = await expectedPaths(42);

    await expect(runPlan('42', makeResolved())).resolves.toBe(1);

    const errors = mockPrintError.mock.calls.map(([line]) => line).join('\n');
    expect(errors).toContain(`PRD not found at ${paths.prdFile}`);
    expect(mockRunHeadless).not.toHaveBeenCalled();
  });

  it('picks up a PRD that only existed in the legacy tree', async () => {
    // The whole point of routing through resolveIssuePaths(): an existing
    // install whose artifacts are still under <repoRoot>/issues/ is migrated on
    // the first read instead of being reported as missing.
    await mkdir(join(repoRoot, 'issues', '42'), { recursive: true });
    await writeFile(join(repoRoot, 'issues', '42', 'prd.md'), '# legacy PRD 3c07', 'utf-8');
    resetStorageResolutionCache();

    headlessStub.run = async (options) => {
      const paths = await expectedPaths(42);
      await writeFile(paths.tasksFile, JSON.stringify(makePlan(), null, 2), 'utf-8');
      expect((options as { addDirs?: string[] }).addDirs).toEqual([paths.issueDir]);
    };

    await expect(runPlan('42', makeResolved())).resolves.toBe(0);

    const prompt = mockRunHeadless.mock.calls.at(-1)?.[0].prompt ?? '';
    expect(prompt).toContain('# legacy PRD 3c07');

    // The legacy tree is read-only: the source stays exactly as it was.
    await expect(readFile(join(repoRoot, 'issues', '42', 'prd.md'), 'utf-8')).resolves.toBe(
      '# legacy PRD 3c07',
    );
    expect(await exists(join(repoRoot, 'issues', '42', 'tasks.json'))).toBe(false);
  });
});

/**
 * The same three phases publish their token/cost usage as `metrics:update`
 * events of scope `phase`. Publishing happens inside each command (not in the
 * `instrumentedRunners` wrapper of run.ts, which never sees the HeadlessResult),
 * so it covers standalone invocations too.
 */
describe('metrics of the documentation phases', () => {
  let publisher: RecordingPublisher;

  beforeEach(() => {
    publisher = new RecordingPublisher({ onWarn: () => {} });
    setSessionPublisher(publisher);
    publisher.publish({
      type: 'session:start',
      at: '2026-01-01T00:00:00Z',
      sessionId: 's1',
      issueNumber: 42,
      phases: ['analyze', 'prd', 'plan'],
    });
  });

  afterEach(() => {
    setSessionPublisher(undefined);
  });

  function metricsEvents(): Extract<SessionEvent, { type: 'metrics:update' }>[] {
    return publisher.events.filter(
      (e): e is Extract<SessionEvent, { type: 'metrics:update' }> => e.type === 'metrics:update',
    );
  }

  it('asks the CLI for usage by running in json output format', async () => {
    const paths = await expectedPaths(42);
    await mkdir(paths.issueDir, { recursive: true });
    await writeFile(paths.prdFile, '# PRD for issue 42', 'utf-8');
    headlessStub.result = 'inline analysis';

    await runAnalyze('42', makeResolved());
    expect(mockRunHeadless.mock.calls.at(-1)?.[0].outputFormat).toBe('json');

    headlessStub.run = async () => {
      await writeFile(paths.prdFile, '# PRD for issue 42', 'utf-8');
    };
    await runPrd('42', makeResolved());
    expect(mockRunHeadless.mock.calls.at(-1)?.[0].outputFormat).toBe('json');

    headlessStub.run = async () => {
      await writeFile(paths.tasksFile, JSON.stringify(makePlan(), null, 2), 'utf-8');
    };
    await runPlan('42', makeResolved());
    expect(mockRunHeadless.mock.calls.at(-1)?.[0].outputFormat).toBe('json');
  });

  it('publishes the invocation usage against its own phase', async () => {
    const paths = await expectedPaths(42);
    headlessStub.result = 'inline analysis';
    headlessStub.cost = { inputTokens: 8, outputTokens: 2, cacheReadTokens: 1_000, costUsd: 0.03 };

    await expect(runAnalyze('42', makeResolved())).resolves.toBe(0);

    expect(metricsEvents()).toHaveLength(1);
    expect(metricsEvents()[0]).toMatchObject({
      scope: 'phase',
      phase: 'analyze',
      inputTokens: 8,
      outputTokens: 2,
      cacheReadTokens: 1_000,
      costUsd: 0.03,
    });
    const phase = publisher.snapshot().phases.find((p) => p.name === 'analyze');
    expect(phase).toMatchObject({ inputTokens: 8, costUsd: 0.03 });
    expect(paths.analysisFile.startsWith(globalHome)).toBe(true);
  });

  it('publishes nothing, and still succeeds, when the CLI reports no usage', async () => {
    headlessStub.result = 'inline analysis';
    headlessStub.cost = null;

    await expect(runAnalyze('42', makeResolved())).resolves.toBe(0);

    expect(metricsEvents()).toHaveLength(0);
    expect(publisher.snapshot().phases.find((p) => p.name === 'analyze')?.inputTokens).toBeNull();
    expect(publisher.snapshot().metrics.totalInputTokens).toBeNull();
  });

  // Three attempts (the PRD file is never written), each one an invocation the
  // user paid for — the reducer's summing is what turns them into the total.
  it('publishes one event per attempt of a retrying phase', { timeout: 20_000 }, async () => {
    headlessStub.cost = { inputTokens: 5, costUsd: 0.01 };

    await expect(runPrd('42', makeResolved())).resolves.toBe(1);

    expect(metricsEvents()).toHaveLength(3);
    expect(metricsEvents().every((e) => e.phase === 'prd' && e.scope === 'phase')).toBe(true);
    const phase = publisher.snapshot().phases.find((p) => p.name === 'prd');
    expect(phase?.inputTokens).toBe(15);
    expect(phase?.costUsd).toBeCloseTo(0.03, 10);
  });
});
