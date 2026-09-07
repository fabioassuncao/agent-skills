import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { taskPlanSchema } from '../schemas.js';
import { inspectArtifact } from './artifact-files.js';
import { executionContext, inspectTaskPlan } from './task-plan.js';

const story = (id: string, priority = 1, dependencies?: string[]) => ({
  id,
  title: id,
  description: 'Work',
  acceptanceCriteria: ['Verified'],
  priority,
  passes: false,
  notes: '',
  ...(dependencies ? { dependencies } : {}),
});
const plan = (userStories = [story('A')]) => ({
  project: 'test',
  issueNumber: 42,
  issueUrl: 'https://github.com/acme/repo/issues/42',
  issueStatus: 'pending',
  completedAt: null,
  lastAttemptAt: null,
  lastError: null,
  correctionCycle: 0,
  maxCorrectionCycles: 3,
  lastReviewFindings: null,
  pipeline: {
    prdCompleted: false,
    jsonCompleted: false,
    executionCompleted: false,
    reviewCompleted: false,
    prCreated: false,
  },
  branchName: 'fix/example',
  noBranch: false,
  description: 'Example',
  userStories,
});

describe('shared task plan contract', () => {
  it('keeps current requirements and corrections without completed-story history', () => {
    const input = taskPlanSchema.parse({
      ...plan([
        { ...story('US-001'), passes: true, description: 'OLD DETAILS', notes: 'OLD TRACE' },
        { ...story('US-002', 2, ['US-001']), notes: 'Current decision' },
      ]),
      lastReviewFindings: null,
    });
    const current = executionContext(input);
    expect(current.activeStory).toMatchObject({
      id: 'US-002',
      notes: 'Current decision',
      acceptanceCriteria: ['Verified'],
      dependencies: [{ id: 'US-001', passes: true }],
    });
    expect(JSON.stringify(current)).not.toContain('OLD');
    expect(
      executionContext({ ...input, lastReviewFindings: 'GENERAL: verify browser' }),
    ).toMatchObject({
      activeStory: null,
      lastReviewFindings: 'GENERAL: verify browser',
    });
  });
  it('preserves extension fields, never changes the input, and selects by dependencies before priority', () => {
    const input = {
      ...plan([story('B', 1, ['A']), story('A', 2), story('C', 2)]),
      extension: { preserve: true },
    };
    const before = JSON.stringify(input);
    expect(inspectTaskPlan(input)).toMatchObject({
      ok: true,
      data: {
        readyStoryIds: ['A', 'C'],
        nextStory: { id: 'A' },
        blockedStories: [{ id: 'B', dependencies: ['A'] }],
      },
    });
    expect(JSON.stringify(input)).toBe(before);
    input.userStories[1].passes = true;
    expect(inspectTaskPlan(input)).toMatchObject({ data: { nextStory: { id: 'B' } } });
  });
  it.each([
    [[story('A'), story('A')], 'duplicate_story'],
    [[story('A', 1, ['missing'])], 'missing_dependency'],
    [[story('A', 1, ['A'])], 'self_dependency'],
    [[story('A', 1, ['B']), story('B', 1, ['C']), story('C', 1, ['A'])], 'dependency_cycle'],
  ])('rejects malformed dependency graphs', (stories, code) => {
    const result = inspectTaskPlan(plan(stories));
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
  });
  it('distinguishes an empty plan, completed execution and pending correction', () => {
    expect(inspectTaskPlan(plan([]))).toMatchObject({
      data: { executionComplete: false, nextStory: null },
    });
    const input = plan();
    input.userStories[0].passes = true;
    expect(inspectTaskPlan(input)).toMatchObject({ data: { executionComplete: true } });
    expect(inspectTaskPlan({ ...input, lastReviewFindings: '- Regression' })).toMatchObject({
      data: { executionComplete: false, correctionRequired: true, nextStory: null },
    });
  });
  it('reads explicit files without resolving a project or rewriting unknown fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'if-inspect-'));
    try {
      const path = join(root, 'tasks.json');
      const bytes = JSON.stringify({ ...plan(), extension: 'keep' });
      await writeFile(path, bytes);
      expect(await inspectArtifact('plan', path)).toMatchObject({ schemaVersion: 1, ok: true });
      expect(await readFile(path, 'utf8')).toBe(bytes);
      await writeFile(path, '{');
      expect(await inspectArtifact('plan', path)).toMatchObject({ ok: false, data: null });
      expect(await inspectArtifact('plan')).toMatchObject({ ok: false });
      expect(await inspectArtifact('unknown', path)).toMatchObject({ ok: false });
      expect(await inspectArtifact('plan', path, 'extra')).toMatchObject({ ok: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
