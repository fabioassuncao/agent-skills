import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskPlan } from '../../types.js';
import {
  ingestAgentPlan,
  loadStoredPlan,
  type PlanRepositoryContext,
  resetPlanRepositories,
  saveExecution,
  saveStoredPlan,
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
});
