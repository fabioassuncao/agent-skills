import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDependencyGraph, type DependencyGraph } from '../issues/graph.js';
import { emptyRelations } from '../issues/relations.js';
import type { Issue, IssueRelations } from '../issues/types.js';
import { computeExecutionOrder } from './order.js';
import {
  buildExecutionPlan,
  isQueueComplete,
  loadExecutionPlan,
  markQueueIssueCompleted,
  markQueueIssueFailed,
  markQueueIssueInProgress,
  nextQueueIssue,
  queueStatus,
  saveExecutionPlan,
  setQueueBranch,
  setQueuePullRequest,
} from './plan.js';
import type { ExecutionPlan } from './types.js';

function issue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    number: Number(id),
    title: `Issue ${id}`,
    body: '',
    labels: [],
    state: 'open',
    source: 'github',
    remoteRef: `https://github.com/acme/widgets/issues/${id}`,
    createdAt: '',
    updatedAt: '',
    contentHash: 'sha256:0',
    ...overrides,
  };
}

async function graphOf(
  spec: Record<string, Partial<IssueRelations> & { labels?: string[] }>,
): Promise<DependencyGraph> {
  const ids = Object.keys(spec);
  return buildDependencyGraph(
    ids,
    async (id) => {
      const { labels: _labels, ...relations } = spec[id] ?? {};
      return { ...emptyRelations(id), ...relations };
    },
    { known: ids.map((id) => issue(id, { labels: spec[id]?.labels ?? [] })) },
  );
}

async function planOf(
  spec: Record<string, Partial<IssueRelations> & { labels?: string[] }>,
  requested: string[] = Object.keys(spec),
  include?: string[],
): Promise<ExecutionPlan> {
  const graph = await graphOf(spec);
  const order = computeExecutionOrder(graph, { include });
  if (!order.ok) throw new Error('unexpected cycle');
  return buildExecutionPlan({
    projectId: 'widgets-abc123',
    requested,
    graph,
    order: order.order,
  });
}

describe('buildExecutionPlan', () => {
  it('describes each issue of the order with its position and origin', async () => {
    const plan = await planOf(
      { '50': { blocking: ['51'], labels: ['high'] }, '51': { blockedBy: ['50'] } },
      ['50'],
    );

    expect(plan.id).toBe('50');
    expect(plan.project).toBe('widgets-abc123');
    expect(plan.status).toBe('pending');
    expect(plan.branchName).toBeNull();
    expect(plan.issues).toMatchObject([
      {
        id: '50',
        number: 50,
        title: 'Issue 50',
        url: 'https://github.com/acme/widgets/issues/50',
        position: 1,
        status: 'pending',
        origin: 'requested',
        priority: 'high',
        dependsOn: [],
      },
      { id: '51', position: 2, origin: 'discovered', dependsOn: ['50'], priority: null },
    ]);
  });

  it('records the hierarchy and the heuristic flag', async () => {
    const plan = await planOf({
      '50': { children: ['80'] },
      '80': { parent: '50', heuristic: ['50'] },
    });

    expect(plan.issues.find((entry) => entry.id === '80')).toMatchObject({
      parent: '50',
      heuristic: true,
    });
    expect(plan.issues.find((entry) => entry.id === '50')?.heuristic).toBe(false);
  });

  it('lists discovered issues left out of the order as excluded', async () => {
    const plan = await planOf({ '50': { blocking: ['51'] }, '51': {} }, ['50'], ['50']);

    expect(plan.issues).toHaveLength(1);
    expect(plan.excluded).toEqual([
      {
        id: '51',
        number: 51,
        title: 'Issue 51',
        url: 'https://github.com/acme/widgets/issues/51',
        reason: 'Discovered in the hierarchy but not selected for this run',
      },
    ]);
  });

  it('does not enforce a dependency that is not part of the queue', async () => {
    const plan = await planOf({ '50': { blocking: ['51'] }, '51': {} }, ['51'], ['51']);
    expect(plan.issues[0]?.dependsOn).toEqual([]);
  });

  it('carries the truncation flag of the discovery', async () => {
    const graph = await graphOf({ '1': { children: ['2'] }, '2': { children: ['3'] } });
    graph.truncated = true;
    const order = computeExecutionOrder(graph);
    if (!order.ok) throw new Error('unexpected cycle');

    const plan = buildExecutionPlan({
      projectId: 'p',
      requested: ['1'],
      graph,
      order: order.order,
    });
    expect(plan.truncated).toBe(true);
  });
});

describe('queue progression', () => {
  it('walks the queue in order and reports the status of the whole', async () => {
    let plan = await planOf({ '50': { blocking: ['51'] }, '51': {} }, ['50']);
    expect(queueStatus(plan)).toBe('pending');
    expect(nextQueueIssue(plan)?.id).toBe('50');

    plan = markQueueIssueInProgress(plan, '50', () => 'T1');
    expect(plan.status).toBe('in_progress');
    expect(nextQueueIssue(plan)?.id).toBe('50');

    plan = markQueueIssueCompleted(plan, '50', () => 'T2');
    expect(nextQueueIssue(plan)?.id).toBe('51');
    expect(isQueueComplete(plan)).toBe(false);

    plan = markQueueIssueCompleted(plan, '51', () => 'T3');
    expect(plan.status).toBe('completed');
    expect(isQueueComplete(plan)).toBe(true);
    expect(nextQueueIssue(plan)).toBeNull();
  });

  it('keeps the original startedAt when an issue is resumed', async () => {
    let plan = await planOf({ '50': {} });
    plan = markQueueIssueInProgress(plan, '50', () => 'FIRST');
    plan = markQueueIssueInProgress(plan, '50', () => 'SECOND');
    expect(plan.issues[0]?.startedAt).toBe('FIRST');
  });

  it('records where a failure happened and marks the queue failed', async () => {
    let plan = await planOf({ '50': { blocking: ['51'] }, '51': {} }, ['50']);
    plan = markQueueIssueCompleted(plan, '50', () => 'T1');
    plan = markQueueIssueFailed(plan, '51', {
      phase: 'execute',
      error: { category: 'phase_failed', message: 'boom', at: 'T2' },
    });

    expect(plan.status).toBe('failed');
    expect(plan.issues[1]).toMatchObject({
      status: 'failed',
      failedPhase: 'execute',
      lastError: { category: 'phase_failed', message: 'boom' },
    });
    // The completed issue is untouched: a resume must not redo it.
    expect(plan.issues[0]?.status).toBe('completed');
  });

  it('picks the failed issue up again before moving on', async () => {
    let plan = await planOf({ '50': { blocking: ['51'] }, '51': {}, '52': {} }, ['50']);
    plan = markQueueIssueCompleted(plan, '50', () => 'T1');
    plan = markQueueIssueFailed(plan, '51', { phase: 'execute', error: null });

    // Not the next `pending` one: the queue never steps over a failure.
    expect(nextQueueIssue(plan)?.id).toBe('51');
    expect(isQueueComplete(plan)).toBe(false);
  });

  it('clears the failure when the issue is retried', async () => {
    let plan = await planOf({ '50': {} });
    plan = markQueueIssueFailed(plan, '50', {
      phase: 'review',
      error: { category: 'x', message: 'y', at: 'T' },
    });
    plan = markQueueIssueInProgress(plan, '50');

    expect(plan.issues[0]).toMatchObject({ failedPhase: null, lastError: null });
    expect(plan.status).toBe('in_progress');
  });
});

describe('persistence', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'issue-flow-queue-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates the queue directory and round-trips the plan', async () => {
    const plan = await planOf({ '50': { blocking: ['51'] }, '51': {} }, ['50']);
    const file = join(dir, 'queues', '50', 'execution-plan.json');

    await saveExecutionPlan(file, plan, () => '2026-08-05T10:00:00Z');
    const loaded = await loadExecutionPlan(file);

    expect(loaded.updatedAt).toBe('2026-08-05T10:00:00Z');
    expect(loaded.issues).toEqual(plan.issues);
    expect(loaded.excluded).toEqual(plan.excluded);
  });

  it('keeps the branch and the pull request across a round trip', async () => {
    let plan = await planOf({ '50': {} });
    plan = setQueueBranch(plan, 'issue/50-multi');
    plan = setQueuePullRequest(plan, {
      number: 7,
      url: 'https://github.com/acme/widgets/pull/7',
      headBranch: 'issue/50-multi',
      createdAt: 'T',
    });

    const file = join(dir, 'execution-plan.json');
    await saveExecutionPlan(file, plan);
    const loaded = await loadExecutionPlan(file);

    expect(loaded.branchName).toBe('issue/50-multi');
    expect(loaded.pullRequest?.number).toBe(7);
  });

  it('reports the offending field of an invalid plan', async () => {
    const file = join(dir, 'execution-plan.json');
    await writeFile(file, JSON.stringify({ schemaVersion: 1, id: '50' }), 'utf-8');

    await expect(loadExecutionPlan(file)).rejects.toThrow(/Invalid execution-plan.json/);
  });

  it('writes indented JSON with a trailing newline, like tasks.json', async () => {
    const file = join(dir, 'execution-plan.json');
    await saveExecutionPlan(file, await planOf({ '50': {} }));

    const raw = await readFile(file, 'utf-8');
    expect(raw.endsWith('}\n')).toBe(true);
    expect(raw).toContain('\n  "id": "50"');
  });
});
