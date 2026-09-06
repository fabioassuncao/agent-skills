import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '../../utils/shell.js';
import type { GhCheckEntry, GhCheckRunEntry } from './types.js';

vi.mock('../../utils/shell.js', () => ({ run: vi.fn() }));

const { run } = await import('../../utils/shell.js');
const {
  dedupeLatestChecks,
  deriveCheckStatus,
  fetchFailedRunLog,
  mapChecks,
  parseRunId,
  summarizeChecks,
} = await import('./ci.js');

const mockRun = vi.mocked(run);

function result(overrides?: Partial<ExecResult>): ExecResult {
  return { stdout: '', stderr: '', exitCode: 0, ...overrides };
}

/**
 * Mirrors the `GhCheckEntry` shape closely enough for the summarizers, which
 * only read the fields referenced below — the upstream test helper.
 */
function checkRun(over: Partial<GhCheckRunEntry> = {}): GhCheckEntry {
  return {
    __typename: 'CheckRun',
    name: 'codex-review',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    detailsUrl: 'https://github.com/o/r/actions/runs/1/job/1',
    startedAt: '2026-07-23T09:00:00Z',
    completedAt: '2026-07-23T09:05:00Z',
    ...over,
  };
}

beforeEach(() => {
  mockRun.mockReset();
});

/* ── migrated from backend/src/__tests__/pr.test.ts ─────────────────────── */

describe('summarizeChecks — cancelled/superseded runs', () => {
  it('does not report failed when a run was cancelled by a re-trigger', () => {
    // Real-world shape: a review command cancels the auto run (concurrency
    // cancel-in-progress); the fresh run posts under a different check name.
    const checks = [
      checkRun({
        name: 'codex-review',
        conclusion: 'CANCELLED',
        completedAt: '2026-07-23T09:32:58Z',
      }),
      checkRun({
        name: 'codex / codex-review',
        conclusion: 'SUCCESS',
        completedAt: '2026-07-23T09:40:00Z',
      }),
    ];
    expect(summarizeChecks(checks)).toBe('success');
  });

  it('latest run of the same check name wins over an earlier cancelled one', () => {
    const checks = [
      checkRun({ conclusion: 'CANCELLED', completedAt: '2026-07-23T09:32:58Z' }),
      checkRun({
        conclusion: 'SUCCESS',
        startedAt: '2026-07-23T09:33:00Z',
        completedAt: '2026-07-23T09:40:00Z',
      }),
    ];
    expect(summarizeChecks(checks)).toBe('success');
  });

  it('still reports failed for a genuine failing run', () => {
    expect(summarizeChecks([checkRun({ conclusion: 'FAILURE' })])).toBe('failed');
  });

  it('reports none when every check is cancelled (no verdict)', () => {
    expect(summarizeChecks([checkRun({ conclusion: 'CANCELLED' })])).toBe('none');
  });

  it('treats a still-running check as pending despite the zero completedAt sentinel', () => {
    const checks = [
      checkRun({ conclusion: 'CANCELLED', completedAt: '2026-07-23T09:32:58Z' }),
      checkRun({
        status: 'IN_PROGRESS',
        conclusion: null,
        startedAt: '2026-07-23T09:35:00Z',
        completedAt: '0001-01-01T00:00:00Z',
      }),
    ];
    expect(summarizeChecks(checks)).toBe('pending');
  });
});

describe('dedupeLatestChecks / mapChecks', () => {
  it('keeps only the latest entry per check name', () => {
    const deduped = dedupeLatestChecks([
      checkRun({ conclusion: 'CANCELLED', completedAt: '2026-07-23T09:32:58Z' }),
      checkRun({ conclusion: 'SUCCESS', completedAt: '2026-07-23T09:40:00Z' }),
    ]);
    expect(deduped).toHaveLength(1);
    expect((deduped[0] as GhCheckRunEntry).conclusion).toBe('SUCCESS');
  });

  it('maps a cancelled run to skipped rather than failed', () => {
    const mapped = mapChecks([checkRun({ name: 'solo', conclusion: 'CANCELLED' })]);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]?.status).toBe('skipped');
  });
});

/* ── Issue Flow additions ───────────────────────────────────────────────── */

describe('summarizeChecks — empty rollups', () => {
  it('reports none for a null or empty rollup', () => {
    expect(summarizeChecks(null)).toBe('none');
    expect(summarizeChecks([])).toBe('none');
  });
});

describe('external status contexts', () => {
  const statusContext = (over: Record<string, unknown> = {}): GhCheckEntry =>
    ({
      __typename: 'StatusContext',
      context: 'vercel',
      state: 'SUCCESS',
      targetUrl: 'https://vercel.com/deploy/1',
      createdAt: '2026-07-23T09:00:00Z',
      ...over,
    }) as GhCheckEntry;

  it('treats PENDING and EXPECTED as not done', () => {
    expect(summarizeChecks([statusContext({ state: 'PENDING' })])).toBe('pending');
    expect(summarizeChecks([statusContext({ state: 'EXPECTED' })])).toBe('pending');
  });

  it('reports ERROR as failed and SUCCESS as success', () => {
    expect(summarizeChecks([statusContext({ state: 'ERROR' })])).toBe('failed');
    expect(summarizeChecks([statusContext()])).toBe('success');
  });

  it('keys a status context apart from a check run of the same name', () => {
    const deduped = dedupeLatestChecks([
      statusContext({ context: 'ci' }),
      checkRun({ name: 'ci' }),
    ]);
    expect(deduped).toHaveLength(2);
  });

  it('maps the target URL and derives no run id', () => {
    const mapped = mapChecks([statusContext()]);
    expect(mapped[0]).toEqual({
      name: 'vercel',
      status: 'success',
      url: 'https://vercel.com/deploy/1',
      runId: null,
    });
  });
});

describe('parseRunId', () => {
  it('extracts the Actions run id from a details URL', () => {
    expect(parseRunId('https://github.com/o/r/actions/runs/1234/job/9')).toBe(1234);
  });

  it('returns null for a URL without a run segment, and for null', () => {
    expect(parseRunId('https://vercel.com/deploy/1')).toBeNull();
    expect(parseRunId(null)).toBeNull();
  });
});

describe('deriveCheckStatus', () => {
  it('reports a queued run as pending', () => {
    expect(deriveCheckStatus(checkRun({ status: 'QUEUED', conclusion: null }))).toBe('pending');
  });

  it('reports NEUTRAL as success and TIMED_OUT as failed', () => {
    expect(deriveCheckStatus(checkRun({ conclusion: 'NEUTRAL' }))).toBe('success');
    expect(deriveCheckStatus(checkRun({ conclusion: 'TIMED_OUT' }))).toBe('failed');
  });
});

describe('fetchFailedRunLog', () => {
  it('reads the failed steps of a run through the gh chokepoint', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: 'step failed\n' }));

    await expect(fetchFailedRunLog(42)).resolves.toEqual({ ok: true, log: 'step failed\n' });
    expect(mockRun).toHaveBeenCalledWith(
      'gh',
      ['run', 'view', '42', '--log-failed'],
      expect.objectContaining({ retry: expect.any(Function), timeout: 15_000 }),
    );
  });

  it('addresses a linked repository with --repo', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: '' }));

    await fetchFailedRunLog(7, { repo: 'acme/api', cwd: '/tmp/repo' });

    expect(mockRun).toHaveBeenCalledWith(
      'gh',
      ['run', 'view', '7', '--log-failed', '--repo', 'acme/api'],
      expect.objectContaining({ cwd: '/tmp/repo' }),
    );
  });

  it('reports a failure instead of throwing', async () => {
    mockRun.mockResolvedValueOnce(result({ exitCode: 1, stderr: 'run not found\n' }));

    await expect(fetchFailedRunLog(9)).resolves.toEqual({
      ok: false,
      error: 'gh run view failed for run 9: run not found',
    });
  });
});
