import { describe, expect, it } from 'vitest';
import { createInitialSnapshot, reduceSessionEvent } from './core/session-state.js';
import {
  headlessResultSchema,
  issueMetadataSchema,
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

  it('defaults issueUrl to an empty string when absent', () => {
    const { issueUrl: _omitted, ...plan } = validTaskPlan();
    const result = taskPlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
    expect(result.success && result.data.issueUrl).toBe('');
  });

  it('accepts a non-numeric local issueNumber', () => {
    const plan = { ...validTaskPlan(), issueNumber: 'local-auth-refactor' };
    const result = taskPlanSchema.safeParse(plan);
    expect(result.success).toBe(true);
    expect(result.success && result.data.issueNumber).toBe('local-auth-refactor');
  });

  it('rejects an empty issueNumber string', () => {
    const plan = { ...validTaskPlan(), issueNumber: '' };
    const result = taskPlanSchema.safeParse(plan);
    expect(result.success).toBe(false);
  });
});

describe('issueMetadataSchema', () => {
  function validMetadata() {
    return {
      schemaVersion: 1 as const,
      id: '23',
      number: 23,
      source: 'github' as const,
      title: 'Issue providers',
      labels: ['enhancement'],
      state: 'open' as const,
      createdAt: '2026-08-01T10:00:00Z',
      updatedAt: '2026-08-02T10:00:00Z',
      contentHash: 'sha256:abc',
    };
  }

  it('validates metadata without the remote pointer', () => {
    expect(issueMetadataSchema.safeParse(validMetadata()).success).toBe(true);
  });

  it('validates metadata with the remote pointer', () => {
    const metadata = {
      ...validMetadata(),
      source: 'local' as const,
      remote: {
        provider: 'github' as const,
        ref: 'https://github.com/test/test/issues/23',
        syncedAt: '2026-08-02T10:00:00Z',
        syncedContentHash: 'sha256:abc',
      },
    };
    expect(issueMetadataSchema.safeParse(metadata).success).toBe(true);
  });

  it('accepts a null number for non-numeric local ids', () => {
    const metadata = { ...validMetadata(), id: 'auth-refactor', number: null, source: 'local' };
    expect(issueMetadataSchema.safeParse(metadata).success).toBe(true);
  });

  it('rejects an unknown schemaVersion', () => {
    expect(issueMetadataSchema.safeParse({ ...validMetadata(), schemaVersion: 2 }).success).toBe(
      false,
    );
  });

  it('rejects an unknown source and an unknown state', () => {
    expect(issueMetadataSchema.safeParse({ ...validMetadata(), source: 'gitlab' }).success).toBe(
      false,
    );
    expect(issueMetadataSchema.safeParse({ ...validMetadata(), state: 'merged' }).success).toBe(
      false,
    );
  });

  it('rejects an incomplete remote pointer', () => {
    const metadata = { ...validMetadata(), remote: { provider: 'github', ref: 'url' } };
    expect(issueMetadataSchema.safeParse(metadata).success).toBe(false);
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

  it('accepts status and dependencies', () => {
    const result = userStorySchema.safeParse({
      id: 'US-002',
      title: 'Test',
      description: 'Desc',
      acceptanceCriteria: ['AC1'],
      priority: 2,
      passes: false,
      notes: '',
      status: 'in_review',
      dependencies: ['US-001'],
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.status).toBe('in_review');
    expect(result.success && result.data.dependencies).toEqual(['US-001']);
  });

  it('rejects an unknown status', () => {
    const result = userStorySchema.safeParse({
      id: 'US-001',
      title: 'Test',
      description: 'Desc',
      acceptanceCriteria: [],
      priority: 1,
      passes: false,
      notes: '',
      status: 'blocked',
    });
    expect(result.success).toBe(false);
  });

  // The two fields are `.optional()`, not `.default()`: a story that never
  // declared them must not gain artificial values when the plan is rewritten.
  it('leaves status and dependencies absent when the story omits them', () => {
    const result = userStorySchema.safeParse({
      id: 'US-001',
      title: 'Test',
      description: 'Desc',
      acceptanceCriteria: [],
      priority: 1,
      passes: false,
      notes: '',
    });
    expect(result.success).toBe(true);
    expect(result.success && 'status' in result.data).toBe(false);
    expect(result.success && 'dependencies' in result.data).toBe(false);
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

  it('validates a result carrying cache tokens and USD cost', () => {
    const result = headlessResultSchema.safeParse({
      success: true,
      result: 'output text',
      cost: {
        inputTokens: 2,
        outputTokens: 4,
        cacheReadTokens: 500,
        cacheCreationTokens: 15_000,
        costUsd: 0.1607,
      },
      error: null,
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

/**
 * Artifacts written by releases that predate the token/cost instrumentation.
 * Both must keep parsing: the metrics extension is additive, and an absent
 * field means "not reported", never zero.
 */
describe('backwards compatibility with pre-metrics artifacts', () => {
  /** A session.json exactly as the FilePublisher wrote it before the metrics. */
  function legacySessionSnapshot() {
    return {
      schemaVersion: 1,
      sessionId: 's-42',
      readOnly: true,
      capabilities: ['read'],
      issue: { number: 42, url: 'https://github.com/acme/repo/issues/42' },
      status: 'completed',
      startedAt: '2026-07-01T10:00:00Z',
      updatedAt: '2026-07-01T10:30:00Z',
      endedAt: '2026-07-01T10:30:00Z',
      elapsedSeconds: 1800,
      estimatedRemainingSeconds: null,
      progress: {
        percent: 100,
        phasesCompleted: 1,
        phasesTotal: 1,
        storiesCompleted: 1,
        storiesTotal: 1,
      },
      currentPhase: null,
      currentActivity: null,
      phases: [
        {
          name: 'execute',
          status: 'completed',
          startedAt: '2026-07-01T10:00:00Z',
          endedAt: '2026-07-01T10:30:00Z',
          durationSeconds: 1800,
          error: null,
        },
      ],
      stories: [
        {
          id: 'US-001',
          title: 'Legacy story',
          priority: 1,
          passes: true,
          completedAt: '2026-07-01T10:30:00Z',
        },
      ],
      execution: { iteration: 1, retries: 0, correctionCycle: 0, maxCorrectionCycles: 3 },
      git: { branch: 'issue/42-legacy', baseBranch: 'main', commits: [] },
      pullRequests: [],
      logs: [],
      errors: [],
      warnings: [],
      lastError: null,
      nextSteps: [],
      environment: null,
    };
  }

  it('parses a session.json written before the metrics existed', () => {
    const result = sessionSnapshotSchema.safeParse(legacySessionSnapshot());
    expect(result.success).toBe(true);
  });

  it('fills the absent snapshot metrics with null, never with zeros', () => {
    const snapshot = sessionSnapshotSchema.parse(legacySessionSnapshot());

    expect(snapshot.metrics).toEqual({
      totalInputTokens: null,
      totalOutputTokens: null,
      totalCacheReadTokens: null,
      totalCacheCreationTokens: null,
      totalCostUsd: null,
    });
    expect(snapshot.phases[0]).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      costUsd: null,
      // The pre-existing fields are untouched.
      durationSeconds: 1800,
    });
    expect(snapshot.stories[0]).toMatchObject({
      durationSeconds: null,
      inputTokens: null,
      costUsd: null,
      completedAt: '2026-07-01T10:30:00Z',
    });
  });

  it('fills the absent issue enrichment of an older session.json', () => {
    const snapshot = sessionSnapshotSchema.parse(legacySessionSnapshot());

    expect(snapshot.issue).toEqual({
      number: 42,
      url: 'https://github.com/acme/repo/issues/42',
      title: null,
      description: null,
      labels: [],
      state: null,
    });
  });

  it('fills the absent repository section of an older session.json', () => {
    const snapshot = sessionSnapshotSchema.parse(legacySessionSnapshot());

    expect(snapshot.repository).toEqual({
      name: null,
      remoteUrl: null,
      branch: null,
      headCommit: null,
      root: null,
    });
  });

  it('fills the absent story status and dependencies of an older session.json', () => {
    const snapshot = sessionSnapshotSchema.parse(legacySessionSnapshot());

    expect(snapshot.stories[0]).toMatchObject({ status: 'backlog', dependencies: [] });
  });

  it('fills the absent story description and acceptance criteria of an older session.json', () => {
    const snapshot = sessionSnapshotSchema.parse(legacySessionSnapshot());

    // The panel's story drawer reads these directly: absent must resolve to an
    // empty value, never to undefined reaching the DOM.
    expect(snapshot.stories[0]).toMatchObject({ description: '', acceptanceCriteria: [] });
  });

  it('parses a tasks.json written before the metrics existed', () => {
    const result = taskPlanSchema.safeParse(validTaskPlan());
    expect(result.success).toBe(true);
    // Optional by design: the story keeps exactly the keys it had on disk.
    expect(result.success && Object.keys(result.data.userStories[0]!).sort()).toEqual([
      'acceptanceCriteria',
      'description',
      'id',
      'notes',
      'passes',
      'priority',
      'title',
    ]);
  });

  it('keeps the metrics of a story that does carry them', () => {
    const plan = validTaskPlan();
    plan.userStories[0] = {
      ...plan.userStories[0]!,
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 500,
      cacheCreationTokens: 1_200,
      costUsd: 0.42,
      durationSeconds: 90,
    } as (typeof plan.userStories)[number];

    const result = taskPlanSchema.safeParse(plan);

    expect(result.success).toBe(true);
    expect(result.success && result.data.userStories[0]).toMatchObject({
      inputTokens: 10,
      costUsd: 0.42,
      durationSeconds: 90,
    });
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

describe('TaskPlan.runState (US-016)', () => {
  it('is absent — not defaulted — in a plan written before it existed', () => {
    const parsed = taskPlanSchema.parse(validTaskPlan());

    // Absent means "this plan predates the field", which is a different
    // statement from `idle`. Materialising a default here would make a plan
    // from an older release indistinguishable from one that ran and idled.
    expect(parsed.runState).toBeUndefined();
    expect('runState' in parsed).toBe(false);
  });

  it('round-trips a fully written state', () => {
    const runState = {
      status: 'retrying' as const,
      currentPhase: 'prd',
      attempt: 2,
      lastHeartbeatAt: '2026-08-30T03:00:00.000Z',
      blockedReason: null,
      owner: { pid: 4242, host: 'laptop.local', startedAt: '2026-08-30T02:00:00.000Z' },
    };

    const parsed = taskPlanSchema.parse({ ...validTaskPlan(), runState });

    expect(parsed.runState).toEqual(runState);
  });

  it('fills every field of a half-written state instead of invalidating the plan', () => {
    // What a process killed mid-write leaves behind.
    const parsed = taskPlanSchema.parse({ ...validTaskPlan(), runState: { status: 'paused' } });

    expect(parsed.runState).toEqual({
      status: 'paused',
      currentPhase: null,
      attempt: 0,
      lastHeartbeatAt: null,
      blockedReason: null,
      owner: null,
    });
  });

  it('accepts every status of the issue-level projection', () => {
    for (const status of [
      'idle',
      'running',
      'waiting',
      'retrying',
      'paused',
      'blocked',
      'failed',
    ]) {
      expect(taskPlanSchema.safeParse({ ...validTaskPlan(), runState: { status } }).success).toBe(
        true,
      );
    }
  });

  it('rejects a status that belongs to the run machine but not to an issue', () => {
    // `completed` and `cancelled` live on `RunStatus`; on an issue the answer
    // is `issueStatus`, and two answers to one question is the bug.
    for (const status of ['completed', 'cancelled', 'queued']) {
      expect(taskPlanSchema.safeParse({ ...validTaskPlan(), runState: { status } }).success).toBe(
        false,
      );
    }
  });

  it('keeps the pipeline booleans untouched beside it', () => {
    const parsed = taskPlanSchema.parse({
      ...validTaskPlan(),
      runState: { status: 'running' },
    });

    // PipelineManager reads these and nothing else; runState is additional
    // information, never a replacement.
    expect(parsed.pipeline).toEqual(validTaskPlan().pipeline);
  });
});
