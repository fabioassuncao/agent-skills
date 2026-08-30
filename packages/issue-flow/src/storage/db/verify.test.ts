import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskPlan } from '../../types.js';
import { saveStoredPlan } from './repository.js';
import { verifyProjectProjections } from './verify.js';

function plan(): TaskPlan {
  return {
    project: 'verify',
    issueNumber: 91,
    issueUrl: '',
    branchName: 'develop',
    description: 'Canonical state',
    issueStatus: 'in_progress',
    completedAt: null,
    lastAttemptAt: '2026-08-30T20:00:00Z',
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
  };
}

describe('SQLite projection verification', () => {
  let home: string;
  let projectDir: string;
  let tasksPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-verify-home-'));
    projectDir = join(home, 'projects', 'verify-project');
    tasksPath = join(projectDir, 'issues', '91', 'tasks.json');
    await saveStoredPlan(
      {
        tasksPath,
        projectId: 'verify-project',
        issueId: '91',
        projectRoot: '/repo',
        databaseOptions: { env: { ISSUE_FLOW_HOME: home } },
      },
      plan(),
    );
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const verify = () =>
    verifyProjectProjections({
      projectId: 'verify-project',
      projectDir,
      projectRoot: '/repo',
      databaseOptions: { env: { ISSUE_FLOW_HOME: home } },
    });

  it('accepts a materialized projection that matches canonical state', async () => {
    await expect(verify()).resolves.toEqual({ checked: 1, divergences: [] });
  });

  it('reports changed and missing projections without modifying either side', async () => {
    const projection = JSON.parse(await readFile(tasksPath, 'utf-8')) as TaskPlan;
    projection.description = 'Diverged projection';
    await writeFile(tasksPath, JSON.stringify(projection));

    await expect(verify()).resolves.toMatchObject({
      checked: 1,
      divergences: ['issues/91/tasks.json'],
    });

    await rm(tasksPath);
    await expect(verify()).resolves.toMatchObject({
      checked: 1,
      divergences: ['issues/91/tasks.json (missing or invalid projection)'],
    });
  });
});
