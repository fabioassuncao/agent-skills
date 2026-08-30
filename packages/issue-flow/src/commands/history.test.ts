import { beforeEach, describe, expect, it, vi } from 'vitest';

const printed = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../ui/logger.js', () => ({
  printInfo: (message: string) => void printed.lines.push(message),
  printError: (message: string) => void printed.lines.push(message),
}));

vi.mock('../storage/resolve.js', () => ({
  resolveProjectPaths: async () => ({ projectId: 'project-1', storageDriver: 'sqlite' }),
  resolveIssuePaths: async () => {
    throw new Error('JSON fallback must not be used');
  },
}));

vi.mock('../storage/db/queries.js', () => ({
  getStoredIssueHistory: async () => ({
    issueId: '91',
    runs: [
      {
        id: 'run-1',
        status: 'completed',
        started_at: '2026-08-30T20:00:00Z',
        finished_at: '2026-08-30T20:05:00Z',
      },
    ],
    phases: [{ name: 'execute', status: 'completed' }],
    executions: [
      {
        id: 'execution-1',
        sessionId: 'run-1',
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
        finishedAt: '2026-08-30T20:05:00Z',
        durationMs: 300_000,
        usage: null,
        cost: { status: 'unknown', reason: 'not_reported' },
        status: 'completed',
        failure: null,
      },
    ],
    verifications: [{ verdict: 'passed' }],
    reviews: [{ lastRecommendation: 'APPROVE' }],
  }),
}));

const { runHistory } = await import('./history.js');

describe('history', () => {
  beforeEach(() => {
    printed.lines = [];
  });

  it('renders every relational history category for one issue', async () => {
    await expect(runHistory('91')).resolves.toBe(0);
    const output = printed.lines.join('\n');
    expect(output).toContain('History for issue #91');
    expect(output).toContain('run run-1');
    expect(output).toContain('phase execute');
    expect(output).toContain('execution execute · attempt 1 · initial');
    expect(output).toContain('verification · passed');
    expect(output).toContain('review · APPROVE');
  });

  it('emits a stable schema marker with --json', async () => {
    await expect(runHistory('91', { json: true })).resolves.toBe(0);
    expect(JSON.parse(printed.lines.join('\n'))).toMatchObject({
      schemaVersion: 1,
      issueId: '91',
      runs: [{ id: 'run-1' }],
    });
  });
});
