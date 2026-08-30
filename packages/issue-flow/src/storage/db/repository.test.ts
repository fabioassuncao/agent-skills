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
    expect((await loadStoredPlan(context)).executions).toHaveLength(1);
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
