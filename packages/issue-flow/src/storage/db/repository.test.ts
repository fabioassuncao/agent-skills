import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionPlan } from '../../execution/types.js';
import type { TaskPlan } from '../../types.js';
import {
  exportStoredState,
  findHighestStoredUserStoryNumber,
  ingestAgentPlan,
  ingestGeneratedPlan,
  listStoredExecutions,
  loadStoredPlan,
  loadStoredQueue,
  type PlanRepositoryContext,
  type QueueRepositoryContext,
  resetPlanRepositories,
  saveExecution,
  saveStoredPlan,
  saveStoredQueue,
  saveStoredVerification,
} from './repository.js';

function plan(): TaskPlan {
  return {
    project: 'test',
    issueNumber: 91,
    issueUrl: '',
    branchName: 'develop',
    noBranch: false,
    description: 'test',
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
    userStories: [
      {
        id: 'US-001',
        title: 'Preserve agent state',
        description: '',
        acceptanceCriteria: [],
        priority: 1,
        passes: false,
        notes: '',
      },
    ],
  };
}

describe('SQLite plan repository', () => {
  let context: PlanRepositoryContext;

  beforeEach(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'issue-flow-repository-'));
    context = {
      tasksPath: join(directory, 'tasks.json'),
      projectId: 'test-project',
      issueId: '91',
      projectRoot: directory,
    };
    await saveStoredPlan(context, plan());
  });

  afterEach(() => resetPlanRepositories());

  it('persists closure choices but refuses authorization or confirmation from generated output', async () => {
    await saveStoredPlan(context, { ...plan(), closeIssue: false });
    await writeFile(
      context.tasksPath,
      JSON.stringify({ ...plan(), closeIssue: true, issueClosedAt: 'forged' }),
    );
    await ingestGeneratedPlan(context);
    expect(await loadStoredPlan(context)).toMatchObject({ closeIssue: false });
    expect((await loadStoredPlan(context)).issueClosedAt).toBeUndefined();
    await saveStoredPlan(context, { ...plan(), closeIssue: true, issueClosedAt: 'confirmed' });
    await writeFile(context.tasksPath, JSON.stringify(plan()));
    await ingestGeneratedPlan(context);
    expect(await loadStoredPlan(context)).toMatchObject({
      closeIssue: true,
      issueClosedAt: 'confirmed',
    });
  });

  it('reingests agent passes and notes after telemetry closes its execution', async () => {
    const execution = {
      id: 'execution-1',
      startedAt: '2026-08-30T20:00:00Z',
      finishedAt: null,
      durationMs: null,
      status: 'running',
      cost: { status: 'unknown', reason: 'not_reported' },
    };
    await saveExecution(context, execution);

    const agentPlan = plan();
    agentPlan.userStories[0] = { ...agentPlan.userStories[0]!, passes: true, notes: 'done' };
    await writeFile(context.tasksPath, JSON.stringify(agentPlan), 'utf-8');

    await saveExecution(context, {
      ...execution,
      status: 'completed',
      finishedAt: '2026-08-30T20:01:00Z',
      durationMs: 60_000,
    });
    const imported = await ingestAgentPlan(context);

    expect(imported.userStories[0]).toMatchObject({ passes: true, notes: 'done' });
    expect(
      await listStoredExecutions({
        projectId: context.projectId,
        issueId: context.issueId,
        databaseOptions: context.databaseOptions,
      }),
    ).toHaveLength(1);
    expect(JSON.parse(await readFile(context.tasksPath, 'utf-8')).userStories[0]).toMatchObject({
      passes: true,
      notes: 'done',
    });
  });

  it('serves indexed history and a readable diagnostic export without the projection', async () => {
    await saveExecution(context, {
      id: 'execution-history',
      startedAt: '2026-08-30T20:00:00Z',
      finishedAt: null,
      durationMs: null,
      status: 'running',
      cost: { status: 'unknown', reason: 'not_reported' },
    });

    expect(
      await listStoredExecutions({ projectId: context.projectId, issueId: context.issueId }),
    ).toContainEqual(expect.objectContaining({ id: 'execution-history' }));
    await expect(
      findHighestStoredUserStoryNumber({ projectId: context.projectId }),
    ).resolves.toEqual({ number: 1, issueId: '91', storyId: 'US-001' });
    await expect(exportStoredState()).resolves.toMatchObject({
      stories: expect.arrayContaining([expect.objectContaining({ id: 'US-001', story_number: 1 })]),
      executions: expect.arrayContaining([expect.objectContaining({ id: 'execution-history' })]),
    });
  });

  it('ingests correction acknowledgement and blockers without granting pipeline ownership', async () => {
    const baseline = { ...plan(), lastReviewFindings: 'Fix expiry', closeIssue: false };
    await saveStoredPlan(context, baseline);
    const blocker = {
      category: 'verification',
      message: 'Browser unavailable',
      at: '2026-09-05T00:00:00Z',
    };
    await writeFile(
      context.tasksPath,
      JSON.stringify({
        ...baseline,
        lastReviewFindings: null,
        lastError: blocker,
        closeIssue: true,
        pipeline: { ...baseline.pipeline, reviewCompleted: true, prCreated: true },
      }),
    );
    expect(await ingestAgentPlan(context, baseline)).toMatchObject({
      lastReviewFindings: null,
      lastError: blocker,
      closeIssue: false,
      pipeline: { reviewCompleted: false, prCreated: false },
    });
  });

  it('preserves newer canonical findings and blockers while ingesting story progress', async () => {
    const baseline = { ...plan(), lastReviewFindings: 'Old finding' };
    const newer = { category: 'review', message: 'New blocker', at: '2026-09-05T00:00:00Z' };
    await saveStoredPlan(context, {
      ...baseline,
      lastReviewFindings: 'New finding',
      lastError: newer,
    });
    await writeFile(context.tasksPath, JSON.stringify({ ...baseline, lastReviewFindings: null }));
    expect(await ingestAgentPlan(context, baseline)).toMatchObject({
      lastReviewFindings: 'New finding',
      lastError: newer,
    });
  });

  it('applies only an explicit positive execution retention limit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'issue-flow-retention-'));
    const retained: PlanRepositoryContext = {
      tasksPath: join(directory, 'tasks.json'),
      projectId: `retention-project-${Date.now()}`,
      issueId: '91',
      projectRoot: directory,
      retention: { executions: 1 },
    };
    await saveStoredPlan(retained, plan());
    await saveExecution(retained, {
      id: 'older',
      startedAt: '2026-08-30T20:00:00Z',
      finishedAt: null,
      durationMs: null,
      status: 'completed',
      cost: { status: 'unknown', reason: 'not_reported' },
    });
    await saveExecution(retained, {
      id: 'newer',
      startedAt: '2026-08-30T20:01:00Z',
      finishedAt: null,
      durationMs: null,
      status: 'completed',
      cost: { status: 'unknown', reason: 'not_reported' },
    });

    await expect(listStoredExecutions({ projectId: retained.projectId })).resolves.toEqual([
      expect.objectContaining({ id: 'newer' }),
    ]);
  });

  it('persists verification evidence before a plan has materialized the issue row', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'issue-flow-verification-'));
    const verificationContext: PlanRepositoryContext = {
      tasksPath: join(directory, 'tasks.json'),
      projectId: `verification-project-${Date.now()}`,
      issueId: '42',
      projectRoot: directory,
    };

    await expect(
      saveStoredVerification(verificationContext, {
        at: '2026-08-30T20:00:00Z',
        verdict: 'unverified',
      }),
    ).resolves.toBeUndefined();

    await expect(exportStoredState()).resolves.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ project_id: verificationContext.projectId, id: '42' }),
      ]),
      verifications: expect.arrayContaining([
        expect.objectContaining({ project_id: verificationContext.projectId, issue_id: '42' }),
      ]),
    });
  });

  it.each([
    'analyze',
    'prd',
    'plan',
  ] as const)('records standalone %s telemetry with its project, issue, run and phase in one transaction', async (purpose) => {
    const directory = await mkdtemp(join(tmpdir(), `issue-flow-${purpose}-standalone-`));
    const standalone: PlanRepositoryContext = {
      tasksPath: join(directory, 'tasks.json'),
      projectId: `standalone-${purpose}-${Date.now()}`,
      issueId: '42',
      projectRoot: directory,
    };
    await saveExecution(standalone, {
      id: `${purpose}-execution`,
      purpose,
      status: 'completed',
      startedAt: '2026-08-30T20:00:00Z',
      finishedAt: '2026-08-30T20:00:01Z',
      durationMs: 1000,
      usage: { inputTokens: 3, outputTokens: 2 },
      cost: { status: 'unknown', reason: 'not_reported' },
    });
    await expect(exportStoredState()).resolves.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ project_id: standalone.projectId, id: '42' }),
      ]),
      runs: expect.arrayContaining([
        expect.objectContaining({ project_id: standalone.projectId, issue_id: '42' }),
      ]),
      phases: expect.arrayContaining([
        expect.objectContaining({ name: purpose, input_tokens: 3, output_tokens: 2 }),
      ]),
      executions: expect.arrayContaining([expect.objectContaining({ id: `${purpose}-execution` })]),
    });
  });

  it('round-trips pull-request and review history from runtime plan state', async () => {
    const updated = plan();
    updated.pipeline.prCreated = true;
    updated.pullRequest = {
      number: 91,
      url: 'https://example.test/pull/91',
      headBranch: 'develop',
      createdAt: '2026-08-30T20:00:00Z',
    };
    updated.prReview = {
      enabled: true,
      rounds: 1,
      lastRecommendation: 'APPROVE',
      lastReviewedAt: '2026-08-30T20:01:00Z',
    };
    await saveStoredPlan(context, updated);

    await expect(exportStoredState()).resolves.toMatchObject({
      pull_requests: expect.arrayContaining([
        expect.objectContaining({ issue_id: context.issueId, number: 91 }),
      ]),
      reviews: expect.arrayContaining([expect.objectContaining({ status: 'APPROVE' })]),
    });
  });
});

describe('SQLite queue repository', () => {
  it('persists queue coordination state transactionally and keeps the JSON projection readable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'issue-flow-queue-repository-'));
    const context: QueueRepositoryContext = {
      planFile: join(directory, 'queues', '91', 'execution-plan.json'),
      projectId: `queue-project-${Date.now()}`,
      projectRoot: directory,
    };
    const queue: ExecutionPlan = {
      schemaVersion: 1,
      id: '91',
      project: context.projectId,
      requested: ['91', '92'],
      branchName: 'feat/queue',
      noBranch: false,
      prReview: false,
      status: 'in_progress',
      createdAt: '2026-08-30T20:00:00Z',
      updatedAt: '2026-08-30T20:01:00Z',
      truncated: false,
      excluded: [],
      issues: [
        {
          id: '91',
          number: 91,
          title: 'First',
          url: null,
          source: 'github',
          position: 1,
          status: 'completed',
          origin: 'requested',
          role: 'executable',
          externalDependencies: [],
          dependsOn: [],
          parent: null,
          priority: 'high',
          heuristic: false,
          failedPhase: null,
          lastError: null,
          attempts: 1,
          blockedReason: null,
          startedAt: '2026-08-30T20:00:00Z',
          completedAt: '2026-08-30T20:01:00Z',
        },
        {
          id: '92',
          number: 92,
          title: 'Second',
          url: null,
          source: 'github',
          position: 2,
          status: 'in_progress',
          origin: 'requested',
          role: 'executable',
          externalDependencies: [],
          dependsOn: ['91'],
          parent: null,
          priority: null,
          heuristic: false,
          failedPhase: null,
          lastError: null,
          attempts: 1,
          blockedReason: null,
          startedAt: '2026-08-30T20:01:00Z',
          completedAt: null,
        },
      ],
    };

    await saveStoredQueue(context, queue);

    await expect(loadStoredQueue(context)).resolves.toEqual(queue);
    expect(JSON.parse(await readFile(context.planFile, 'utf-8'))).toEqual(queue);
    await expect(exportStoredState()).resolves.toMatchObject({
      queues: expect.arrayContaining([
        expect.objectContaining({ id: '91', project_id: context.projectId }),
      ]),
      queue_issues: expect.arrayContaining([
        expect.objectContaining({ queue_id: '91', issue_id: '92', attempts: 1 }),
      ]),
      queue_dependencies: expect.arrayContaining([
        expect.objectContaining({ queue_id: '91', issue_id: '92', depends_on_issue_id: '91' }),
      ]),
    });
  });
});
