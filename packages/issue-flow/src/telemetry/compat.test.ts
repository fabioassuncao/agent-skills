import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { taskPlanSchema } from '../schemas.js';

const legacyPlan = {
  project: 'test',
  issueNumber: 63,
  issueUrl: 'https://github.com/acme/repo/issues/63',
  branchName: 'issue/63-execucao-autonoma',
  description: 'legacy',
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
      title: 'Story',
      description: '',
      acceptanceCriteria: ['ok'],
      priority: 1,
      passes: false,
      notes: '',
    },
  ],
};

const priorSchema = taskPlanSchema.omit({ executions: true });

describe('telemetry compatibility', () => {
  it('loads a pre-telemetry tasks.json and does not materialize executions: []', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'telemetry-compat-'));
    const path = join(dir, 'tasks.json');
    await writeFile(path, `${JSON.stringify(legacyPlan, null, 2)}\n`);
    const loaded = await loadTaskPlan(path);
    expect(loaded.executions).toBeUndefined();
    await saveTaskPlan(path, loaded);
    const raw = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
    expect(raw).not.toHaveProperty('executions');
  });

  it('keeps a plan with executions readable by a schema that does not know the field', () => {
    const withExecutions = {
      ...legacyPlan,
      executions: [
        {
          id: 'e1',
          sessionId: null,
          purpose: 'prd',
          attempt: 1,
          trigger: 'initial',
          triggerReason: null,
          agent: {
            harness: 'claude-code',
            provider: 'anthropic',
            model: { requested: null, resolved: null, source: 'unavailable' },
            providerSessionId: null,
          },
          startedAt: '2026-08-30T00:00:00Z',
          finishedAt: '2026-08-30T00:01:00Z',
          durationMs: 1000,
          usage: null,
          cost: { status: 'unknown', reason: 'not_reported' },
          status: 'completed',
          failure: null,
        },
      ],
    };
    expect(taskPlanSchema.safeParse(withExecutions).success).toBe(true);
    const stripped = z.object({}).passthrough().safeParse(withExecutions);
    expect(stripped.success).toBe(true);
    expect(priorSchema.safeParse(withExecutions).success).toBe(true);
  });
});
