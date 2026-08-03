import { describe, expect, it } from 'vitest';
import { createInitialSnapshot, reduceSessionEvent } from './core/session-state.js';
import {
  headlessResultSchema,
  pipelineStateSchema,
  sessionSnapshotSchema,
  taskPlanSchema,
  userStorySchema,
  webConfigSchema,
} from './schemas.js';

function validTaskPlan() {
  return {
    project: 'test',
    issueNumber: 1,
    issueUrl: 'https://github.com/test/test/issues/1',
    branchName: 'issue/1-test',
    description: 'Test issue',
    issueStatus: 'pending' as const,
    completedAt: null,
    lastAttemptAt: null,
    lastError: null,
    correctionCycle: 0,
    maxCorrectionCycles: 3,
    pipeline: {
      analyzeCompleted: false,
      prdCompleted: false,
      jsonCompleted: false,
      executionCompleted: false,
      reviewCompleted: false,
      prCreated: false,
    },
    userStories: [
      {
        id: 'US-001',
        title: 'Test story',
        description: 'As a user...',
        acceptanceCriteria: ['Criterion 1'],
        priority: 1,
        passes: false,
        notes: '',
      },
    ],
  };
}

describe('taskPlanSchema', () => {
  it('validates a correct task plan', () => {
    const result = taskPlanSchema.safeParse(validTaskPlan());
    expect(result.success).toBe(true);
  });

  it('rejects missing required fields', () => {
    const result = taskPlanSchema.safeParse({ project: 'test' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid issueStatus', () => {
    const plan = { ...validTaskPlan(), issueStatus: 'unknown' };
    const result = taskPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });

  it('accepts lastError when present', () => {
    const plan = {
      ...validTaskPlan(),
      lastError: { category: 'build', message: 'tsc failed', at: '2026-01-01T00:00:00Z' },
    };
    const result = taskPlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
  });

  it('rejects negative issueNumber', () => {
    const plan = { ...validTaskPlan(), issueNumber: -1 };
    const result = taskPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });
});

describe('userStorySchema', () => {
  it('validates a correct user story', () => {
    const result = userStorySchema.safeParse({
      id: 'US-001',
      title: 'Test',
      description: 'Desc',
      acceptanceCriteria: ['AC1'],
      priority: 1,
      passes: false,
      notes: '',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing id', () => {
    const result = userStorySchema.safeParse({
      title: 'Test',
      description: 'Desc',
      acceptanceCriteria: [],
      priority: 1,
      passes: false,
      notes: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('pipelineStateSchema', () => {
  it('validates correct pipeline state', () => {
    const result = pipelineStateSchema.safeParse({
      analyzeCompleted: true,
      prdCompleted: false,
      jsonCompleted: false,
      executionCompleted: false,
      reviewCompleted: false,
      prCreated: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects non-boolean values', () => {
    const result = pipelineStateSchema.safeParse({
      analyzeCompleted: 'yes',
      prdCompleted: false,
      jsonCompleted: false,
      executionCompleted: false,
      reviewCompleted: false,
      prCreated: false,
    });
    expect(result.success).toBe(false);
  });
});

describe('headlessResultSchema', () => {
  it('validates a success result', () => {
    const result = headlessResultSchema.safeParse({
      success: true,
      result: 'output text',
      cost: { inputTokens: 100, outputTokens: 50 },
      error: null,
    });
    expect(result.success).toBe(true);
  });

  it('validates an error result', () => {
    const result = headlessResultSchema.safeParse({
      success: false,
      result: '',
      cost: null,
      error: 'something went wrong',
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing fields', () => {
    const result = headlessResultSchema.safeParse({ success: true });
    expect(result.success).toBe(false);
  });
});

describe('sessionSnapshotSchema', () => {
  it('validates the initial snapshot', () => {
    const result = sessionSnapshotSchema.safeParse(createInitialSnapshot());
    expect(result.success).toBe(true);
  });

  it('validates a snapshot produced by the reducer', () => {
    let snap = reduceSessionEvent(createInitialSnapshot(), {
      type: 'session:start',
      at: '2026-08-03T12:00:00Z',
      sessionId: 'abc',
      issueNumber: 22,
      issueUrl: 'https://github.com/test/test/issues/22',
      branch: 'issue/22-test',
      baseBranch: 'main',
      phases: ['init', 'prd', 'execute'],
      environment: { node: 'v22.0.0', platform: 'darwin' },
    });
    snap = reduceSessionEvent(snap, {
      type: 'phase:start',
      at: '2026-08-03T12:00:05Z',
      phase: 'init',
    });
    snap = reduceSessionEvent(snap, {
      type: 'stories:update',
      at: '2026-08-03T12:00:10Z',
      stories: [
        {
          id: 'US-001',
          title: 'Story',
          description: 'Desc',
          acceptanceCriteria: [],
          priority: 1,
          passes: false,
          notes: '',
        },
      ],
    });
    snap = reduceSessionEvent(snap, {
      type: 'log',
      at: '2026-08-03T12:00:15Z',
      level: 'warn',
      message: 'careful',
    });
    const result = sessionSnapshotSchema.safeParse(snap);
    expect(result.success).toBe(true);
  });

  it('rejects a payload with a wrong schemaVersion', () => {
    const snapshot = { ...createInitialSnapshot(), schemaVersion: 2 };
    const result = sessionSnapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(false);
  });

  it('rejects a payload without readOnly: true', () => {
    const snapshot = { ...createInitialSnapshot(), readOnly: false };
    const result = sessionSnapshotSchema.safeParse(snapshot);
    expect(result.success).toBe(false);
  });
});

describe('webConfigSchema', () => {
  it('fills in the documented defaults for an empty object', () => {
    const result = webConfigSchema.parse({});
    expect(result).toEqual({
      enabled: false,
      port: 3737,
      host: '0.0.0.0',
      refreshSeconds: 5,
      logLimit: 200,
      includeLogs: true,
    });
  });

  it('accepts partial overrides', () => {
    const result = webConfigSchema.parse({ enabled: true, port: 8080 });
    expect(result.enabled).toBe(true);
    expect(result.port).toBe(8080);
    expect(result.host).toBe('0.0.0.0');
  });

  it('rejects an out-of-range port', () => {
    expect(webConfigSchema.safeParse({ port: 0 }).success).toBe(false);
    expect(webConfigSchema.safeParse({ port: 70000 }).success).toBe(false);
    expect(webConfigSchema.safeParse({ port: 12.5 }).success).toBe(false);
  });

  it('rejects a non-positive refreshSeconds', () => {
    expect(webConfigSchema.safeParse({ refreshSeconds: 0 }).success).toBe(false);
  });
});
