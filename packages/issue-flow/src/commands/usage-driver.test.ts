import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const projectRoot = vi.hoisted(() => ({ value: '' }));
vi.mock('execa', () => ({
  execa: vi.fn(async (file: string, args: string[] = []) => {
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { stdout: projectRoot.value, exitCode: 0 };
    }
    if (file === 'git' && args[0] === 'remote') return { stdout: '', exitCode: 1 };
    return { stdout: '', exitCode: 1 };
  }),
}));

const printed = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../ui/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/logger.js')>();
  return {
    ...actual,
    printInfo: (message: string) => void printed.lines.push(message),
    printError: (message: string) => void printed.lines.push(message),
  };
});

const { runUsage } = await import('./usage.js');
const { resetStorageResolutionCache, resolveIssuePaths } = await import('../storage/resolve.js');

describe('usage with the JSON compatibility driver', () => {
  let home: string;
  let repo: string;
  let originalCwd: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-usage-json-home-'));
    repo = await mkdtemp(join(tmpdir(), 'issue-flow-usage-json-repo-'));
    previousHome = process.env.ISSUE_FLOW_HOME;
    process.env.ISSUE_FLOW_HOME = home;
    originalCwd = process.cwd();
    process.chdir(repo);
    projectRoot.value = repo;
    printed.lines = [];
    resetStorageResolutionCache();
    await writeFile(join(home, 'config.json'), JSON.stringify({ storage: { driver: 'json' } }));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    resetStorageResolutionCache();
    if (previousHome === undefined) delete process.env.ISSUE_FLOW_HOME;
    else process.env.ISSUE_FLOW_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });

  it('reads task projections and never opens issue-flow.db', async () => {
    const paths = await resolveIssuePaths('91');
    await mkdir(paths.issueDir, { recursive: true });
    await writeFile(
      paths.tasksFile,
      JSON.stringify({
        project: 'json',
        issueNumber: 91,
        issueUrl: '',
        branchName: 'develop',
        description: '',
        issueStatus: 'in_progress',
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
        userStories: [],
        executions: [
          {
            id: 'execution-1',
            sessionId: null,
            purpose: 'execute',
            attempt: 1,
            trigger: 'initial',
            triggerReason: null,
            agent: {
              harness: 'codex',
              provider: 'openai',
              model: { requested: null, resolved: null, source: 'provider' },
              providerSessionId: null,
            },
            startedAt: '2026-08-30T20:00:00Z',
            finishedAt: '2026-08-30T20:01:00Z',
            durationMs: 60_000,
            usage: null,
            cost: { status: 'unknown', reason: 'not_reported' },
            status: 'completed',
            failure: null,
          },
        ],
      }),
    );

    await expect(runUsage('91', { by: 'trigger' })).resolves.toBe(0);
    expect(printed.lines.join('\n')).toContain('initial');
    expect(existsSync(join(home, 'issue-flow.db'))).toBe(false);
  });
});
