import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ExecutionPlan } from '../../execution/types.js';
import { taskPlanSchema } from '../../schemas.js';
import type { TaskPlan } from '../../types.js';
import { ISSUES_DIR_NAME, QUEUES_DIR_NAME } from '../paths.js';
import { executionPlanSchema } from '../schemas.js';
import { type OpenIssueFlowDatabaseOptions, openIssueFlowDatabase } from './index.js';
import { loadStoredPlan, loadStoredQueue } from './repository.js';

export interface VerifyProjectInput {
  projectId: string;
  projectDir: string;
  projectRoot: string;
  databaseOptions?: OpenIssueFlowDatabaseOptions;
}

export interface VerifyProjectResult {
  checked: number;
  divergences: string[];
}

async function canonicalIds(
  input: VerifyProjectInput,
): Promise<{ issues: string[]; queues: string[] }> {
  const database = await openIssueFlowDatabase(input.databaseOptions);
  try {
    return {
      issues: database
        .prepare('SELECT issue_id FROM pipelines WHERE project_id = ?')
        .all<{ issue_id: string }>(input.projectId)
        .map((row) => row.issue_id),
      queues: database
        .prepare('SELECT id FROM queues WHERE project_id = ?')
        .all<{ id: string }>(input.projectId)
        .map((row) => row.id),
    };
  } finally {
    database.close();
  }
}

/** Compare readable plan/queue projections with their canonical relational state. */
export async function verifyProjectProjections(
  input: VerifyProjectInput,
): Promise<VerifyProjectResult> {
  let checked = 0;
  const divergences: string[] = [];
  const canonical = await canonicalIds(input);
  const issuesDir = join(input.projectDir, ISSUES_DIR_NAME);
  const issueIds = new Set([...(await readdir(issuesDir).catch(() => [])), ...canonical.issues]);
  for (const issueId of [...issueIds].sort()) {
    const tasksPath = join(issuesDir, issueId, 'tasks.json');
    let projection: TaskPlan;
    try {
      projection = taskPlanSchema.parse(JSON.parse(await readFile(tasksPath, 'utf-8'))) as TaskPlan;
    } catch {
      if (canonical.issues.includes(issueId)) {
        checked++;
        divergences.push(`issues/${issueId}/tasks.json (missing or invalid projection)`);
      }
      continue;
    }
    checked++;
    try {
      const stored = taskPlanSchema.parse(
        await loadStoredPlan({
          tasksPath,
          projectId: input.projectId,
          issueId,
          projectRoot: input.projectRoot,
          databaseOptions: input.databaseOptions,
        }),
      );
      if (!isDeepStrictEqual(projection, stored)) divergences.push(`issues/${issueId}/tasks.json`);
    } catch {
      divergences.push(`issues/${issueId}/tasks.json (missing from SQLite)`);
    }
  }

  const queuesDir = join(input.projectDir, QUEUES_DIR_NAME);
  const queueIds = new Set([...(await readdir(queuesDir).catch(() => [])), ...canonical.queues]);
  for (const queueId of [...queueIds].sort()) {
    const planFile = join(queuesDir, queueId, 'execution-plan.json');
    let projection: ExecutionPlan;
    try {
      projection = executionPlanSchema.parse(JSON.parse(await readFile(planFile, 'utf-8')));
    } catch {
      if (canonical.queues.includes(queueId)) {
        checked++;
        divergences.push(`queues/${queueId}/execution-plan.json (missing or invalid projection)`);
      }
      continue;
    }
    checked++;
    const storedValue = await loadStoredQueue({
      planFile,
      projectId: input.projectId,
      projectRoot: input.projectRoot,
      databaseOptions: input.databaseOptions,
    });
    const stored = storedValue === null ? null : executionPlanSchema.parse(storedValue);
    if (stored === null || !isDeepStrictEqual(projection, stored)) {
      divergences.push(`queues/${queueId}/execution-plan.json`);
    }
  }
  return { checked, divergences };
}
