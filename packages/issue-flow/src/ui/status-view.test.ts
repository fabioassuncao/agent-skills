import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createInitialSnapshot, type SessionSnapshot } from '../core/session-state.js';
import type { Icons } from './logger.js';
import { formatIssueHeadline, renderExecuteFocus, renderStatusView } from './status-view.js';
import { failureExcerpt, stripMarkdown } from './text.js';

const ASCII: Icons = {
  success: '[OK]',
  fail: '[FAIL]',
  pending: '[...]',
  retry: '[RETRY]',
  warn: '[WARN]',
  start: '[START]',
  end: '[END]',
  notReached: '[ ]',
  tool: '>',
  connector: '|',
  info: '-',
};

function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  const base = createInitialSnapshot();
  return {
    ...base,
    issue: { ...base.issue, number: 63, title: 'Long-running autonomous execution' },
    git: { ...base.git, branch: 'feat/63-autonomous-execution' },
    elapsedSeconds: 4080,
    estimatedRemainingSeconds: 4200,
    progress: {
      percent: 50,
      phasesCompleted: 3,
      phasesTotal: 6,
      storiesCompleted: 11,
      storiesTotal: 22,
    },
    currentPhase: 'execute',
    execution: { iteration: 14, retries: 2, correctionCycle: 0, maxCorrectionCycles: 3 },
    metrics: { ...base.metrics, totalCostUsd: 4.31 },
    phases: [
      phase('init', 'completed', 2),
      phase('prd', 'completed', 72),
      phase('plan', 'completed', 48),
      phase('execute', 'running', 3840),
      phase('review', 'pending'),
      phase('pr', 'pending'),
    ],
    stories: [
      {
        id: 'US-012',
        title: 'Repository security preflight',
        priority: 12,
        passes: false,
        completedAt: null,
        durationSeconds: 271,
        status: 'in_progress',
        dependencies: [],
        description: '',
        acceptanceCriteria: [],
        stage: 'executing',
        stageSince: null,
        stageDetail: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        costUsd: null,
      },
    ],
    currentActivity: {
      story: 'US-012',
      tool: 'Edit',
      detail: 'src/resilience/policy.ts',
      since: '2026-08-30T00:00:00.000Z',
    },
    ...overrides,
  };
}

function phase(
  name: string,
  status: 'pending' | 'running' | 'completed' | 'failed',
  durationSeconds: number | null = null,
  error: string | null = null,
) {
  return {
    name,
    status,
    startedAt: null,
    endedAt: null,
    durationSeconds,
    error,
    harnessExecutionMs: null,
    orchestrationOverheadMs: null,
    harnessStartupMs: null,
    ttftMs: null,
    attemptCount: null,
    retryDurationMs: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    costUsd: null,
  };
}

describe('renderStatusView', () => {
  it('fits the run on one screen: issue, phases, active story, times', () => {
    const lines = renderStatusView(snapshot(), { icons: ASCII });
    const text = lines.join('\n');

    expect(text).toContain('#63');
    expect(text).toContain('Long-running autonomous execution');
    expect(text).toContain('feat/63-autonomous-execution');
    expect(text).toContain('Preflight');
    expect(text).toContain('PRD');
    expect(text).toContain('Plan');
    expect(text).toContain('Execute');
    expect(text).toContain('Review');
    expect(text).toContain('PR');
    expect(text).toContain('11/22 stories');
    expect(text).toContain('US-012');
    expect(text).toContain('elapsed');
    expect(text).toContain('remaining');
    expect(lines.filter((line) => line.includes('US-'))).toHaveLength(1);
  });

  it('does not expand one line per story', () => {
    const many = snapshot({
      stories: Array.from({ length: 22 }, (_, i) => ({
        id: `US-${String(i + 1).padStart(3, '0')}`,
        title: `Story ${i + 1}`,
        priority: i + 1,
        passes: i < 11,
        completedAt: null,
        durationSeconds: null,
        status: i === 11 ? 'in_progress' : i < 11 ? 'done' : 'backlog',
        dependencies: [],
        description: '',
        acceptanceCriteria: [],
        stage: i === 11 ? 'executing' : i < 11 ? 'done' : 'pending',
        stageSince: null,
        stageDetail: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        costUsd: null,
      })),
    });
    const lines = renderStatusView(many, { icons: ASCII });
    expect(lines.filter((line) => /US-\d+/.test(line))).toHaveLength(1);
    expect(lines.length).toBeLessThan(20);
  });

  it('strips markdown from titles and activity so none of it reaches clean output', () => {
    const dirty = snapshot({
      issue: {
        number: 1,
        url: null,
        title: 'Add **bold** and `code`',
        description: null,
        labels: [],
        state: null,
      },
      currentActivity: {
        story: 'US-012',
        tool: 'Edit',
        detail: 'see `src/foo.ts` — **important**',
        since: '2026-08-30T00:00:00.000Z',
      },
    });
    const text = renderStatusView(dirty, { icons: ASCII }).join('\n');
    expect(text).not.toMatch(/\*\*/);
    expect(text).not.toMatch(/`/);
    expect(text).toContain('Add bold and code');
  });

  it('omits the monitor URL when none is up — US-009 stays file-free', () => {
    const lines = renderStatusView(snapshot(), { icons: ASCII });
    expect(lines.join('\n')).not.toContain('monitor');
  });

  it('shows a failed phase cause without requiring verbose', () => {
    const failed = snapshot({
      phases: [
        phase('init', 'completed', 2),
        phase('prd', 'failed', 12, 'Missing ANTHROPIC_API_KEY'),
      ],
      currentPhase: 'prd',
      stories: [],
      currentActivity: null,
    });
    const text = renderStatusView(failed, { icons: ASCII }).join('\n');
    expect(text).toContain('Missing ANTHROPIC_API_KEY');
  });
});

describe('renderExecuteFocus', () => {
  it('is the active story plus the current tool, nothing else', () => {
    const lines = renderExecuteFocus(snapshot(), { icons: ASCII });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('US-012');
    expect(lines[1]).toContain('Edit');
    expect(lines[1]).toContain('src/resilience/policy.ts');
  });
});

describe('formatIssueHeadline', () => {
  it('degrades when the issue has no number yet', () => {
    expect(formatIssueHeadline(createInitialSnapshot())).toBe('Issue Flow');
  });

  it('names the version that produced the run', () => {
    const base = createInitialSnapshot();
    const withVersion: SessionSnapshot = {
      ...base,
      issue: { ...base.issue, number: 63, title: 'Autonomous execution' },
      environment: {
        node: 'v22.0.0',
        platform: 'darwin',
        agent: 'claude',
        model: null,
        cliVersion: '0.15.0',
      },
    };
    expect(formatIssueHeadline(withVersion)).toBe(
      'Issue Flow v0.15.0 · #63 · Autonomous execution',
    );
  });

  it('omits the version for a session written before it was recorded', () => {
    const base = createInitialSnapshot();
    const legacy: SessionSnapshot = {
      ...base,
      issue: { ...base.issue, number: 63, title: 'Autonomous execution' },
      environment: {
        node: 'v22.0.0',
        platform: 'darwin',
        agent: 'claude',
        model: null,
        cliVersion: null,
      },
    };
    expect(formatIssueHeadline(legacy)).toBe('Issue Flow · #63 · Autonomous execution');
  });
});

describe('stripMarkdown / failureExcerpt', () => {
  it('removes the markers a terminal cannot render', () => {
    expect(stripMarkdown('## Title\n- item and **bold** and `code`')).toBe(
      'Title\nitem and bold and code',
    );
    expect(stripMarkdown('Missing ANTHROPIC_API_KEY')).toBe('Missing ANTHROPIC_API_KEY');
  });

  it('keeps the last non-empty lines of a failure', () => {
    const excerpt = failureExcerpt('ok\n\n**boom**\n`file.ts`');
    expect(excerpt).toEqual(['ok', 'boom', 'file.ts']);
  });
});

describe('single-writer guard', () => {
  it('status-view and pipeline-renderer never write to the console themselves', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const file of ['status-view.ts', 'pipeline-renderer.ts', 'text.ts']) {
      const source = await readFile(join(here, file), 'utf-8');
      expect(source).not.toMatch(/\bconsole\.log\b/);
      expect(source).not.toMatch(/\bprocess\.stdout\.write\b/);
    }
  });
});
