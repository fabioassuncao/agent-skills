import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskPlan } from '../types.js';
import {
  allStoriesPass,
  applyStoryMetrics,
  clearLastError,
  hasPendingCorrection,
  loadTaskPlan,
  markIssueCompleted,
  markIssueInProgress,
  markStoryPassing,
  saveTaskPlan,
  setLastError,
  trimErrorMessage,
} from './state-manager.js';

function createMinimalPlan(overrides?: Partial<TaskPlan>): TaskPlan {
  return {
    project: 'test',
    issueNumber: 1,
    issueUrl: 'https://github.com/test/test/issues/1',
    branchName: 'feat/1-test',
    noBranch: false,
    description: 'Test plan',
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
    userStories: [
      {
        id: 'US-001',
        title: 'First story',
        description: 'Test story',
        acceptanceCriteria: ['Criterion 1'],
        priority: 1,
        passes: false,
        notes: '',
      },
      {
        id: 'US-002',
        title: 'Second story',
        description: 'Test story 2',
        acceptanceCriteria: ['Criterion 2'],
        priority: 2,
        passes: false,
        notes: '',
      },
    ],
    ...overrides,
  };
}

describe('state-manager', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `issue-flow-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('loadTaskPlan', () => {
    it('should load and parse a valid tasks.json', async () => {
      const plan = createMinimalPlan();
      const filePath = join(tmpDir, 'tasks.json');
      await writeFile(filePath, JSON.stringify(plan), 'utf-8');

      const loaded = await loadTaskPlan(filePath);
      expect(loaded.project).toBe('test');
      expect(loaded.userStories).toHaveLength(2);
    });

    it('should throw on missing userStories', async () => {
      const filePath = join(tmpDir, 'tasks.json');
      await writeFile(filePath, JSON.stringify({ project: 'test' }), 'utf-8');

      await expect(loadTaskPlan(filePath)).rejects.toThrow('Invalid tasks.json');
    });

    it('should throw on missing file', async () => {
      await expect(loadTaskPlan(join(tmpDir, 'missing.json'))).rejects.toThrow();
    });

    it('should load a tasks.json without the pr-review fields and not add them on save', async () => {
      const plan = createMinimalPlan();
      const filePath = join(tmpDir, 'tasks.json');
      await writeFile(filePath, JSON.stringify(plan, null, 2), 'utf-8');

      const loaded = await loadTaskPlan(filePath);
      expect(loaded.pullRequest).toBeUndefined();
      expect(loaded.prReview).toBeUndefined();
      expect(loaded.pipeline.prReviewCompleted).toBeUndefined();

      await saveTaskPlan(filePath, loaded);
      const rewritten = JSON.parse(await readFile(filePath, 'utf-8'));
      expect(rewritten).not.toHaveProperty('pullRequest');
      expect(rewritten).not.toHaveProperty('prReview');
      expect(rewritten.pipeline).not.toHaveProperty('prReviewCompleted');
    });

    it('should load and round-trip a tasks.json with the pr-review fields', async () => {
      const plan = createMinimalPlan({
        pipeline: {
          prdCompleted: true,
          jsonCompleted: true,
          executionCompleted: true,
          reviewCompleted: true,
          prCreated: true,
          prReviewCompleted: true,
        },
        pullRequest: {
          number: 42,
          url: 'https://github.com/test/test/pull/42',
          headBranch: 'feat/1-test',
          createdAt: '2026-08-03T12:00:00Z',
        },
        prReview: {
          enabled: true,
          pullRequestNumber: 42,
          rounds: 2,
          lastRecommendation: 'REQUEST_CHANGES',
          lastReviewedAt: '2026-08-03T13:00:00Z',
        },
      });
      const filePath = join(tmpDir, 'tasks.json');
      await writeFile(filePath, JSON.stringify(plan, null, 2), 'utf-8');

      const loaded = await loadTaskPlan(filePath);
      expect(loaded.pullRequest).toEqual(plan.pullRequest);
      expect(loaded.prReview).toEqual(plan.prReview);
      expect(loaded.pipeline.prReviewCompleted).toBe(true);

      await saveTaskPlan(filePath, loaded);
      const reloaded = await loadTaskPlan(filePath);
      expect(reloaded.pullRequest).toEqual(plan.pullRequest);
      expect(reloaded.prReview).toEqual(plan.prReview);
      expect(reloaded.pipeline.prReviewCompleted).toBe(true);
    });

    it('should reject an unknown pr-review recommendation', async () => {
      const plan = createMinimalPlan({
        prReview: {
          enabled: true,
          rounds: 1,
          lastRecommendation: 'LGTM' as never,
        },
      });
      const filePath = join(tmpDir, 'tasks.json');
      await writeFile(filePath, JSON.stringify(plan), 'utf-8');

      await expect(loadTaskPlan(filePath)).rejects.toThrow('Invalid tasks.json');
    });

    it('should round-trip story status and dependencies', async () => {
      const plan = createMinimalPlan();
      plan.userStories[0].status = 'in_review';
      plan.userStories[0].dependencies = [];
      plan.userStories[1].status = 'backlog';
      plan.userStories[1].dependencies = ['US-001'];
      const filePath = join(tmpDir, 'tasks.json');
      await writeFile(filePath, JSON.stringify(plan, null, 2), 'utf-8');

      const loaded = await loadTaskPlan(filePath);
      expect(loaded.userStories[0].status).toBe('in_review');
      expect(loaded.userStories[1].dependencies).toEqual(['US-001']);

      await saveTaskPlan(filePath, loaded);
      const reloaded = await loadTaskPlan(filePath);
      expect(reloaded.userStories).toEqual(loaded.userStories);
    });

    it('should not materialize optional story observations', async () => {
      const plan = createMinimalPlan();
      const filePath = join(tmpDir, 'tasks.json');
      await writeFile(filePath, JSON.stringify(plan, null, 2), 'utf-8');

      const loaded = await loadTaskPlan(filePath);
      await saveTaskPlan(filePath, loaded);
      const rewritten = JSON.parse(await readFile(filePath, 'utf-8'));

      for (const story of rewritten.userStories) {
        expect('status' in story).toBe(false);
        expect('dependencies' in story).toBe(false);
      }
    });

    it('should load a tasks.json with a non-numeric local issueNumber', async () => {
      const plan = createMinimalPlan({ issueNumber: 'auth-refactor', issueUrl: '' });
      const filePath = join(tmpDir, 'tasks.json');
      await writeFile(filePath, JSON.stringify(plan), 'utf-8');

      const loaded = await loadTaskPlan(filePath);
      expect(loaded.issueNumber).toBe('auth-refactor');
    });
  });

  describe('saveTaskPlan', () => {
    it('should write plan atomically and be readable', async () => {
      const plan = createMinimalPlan();
      const filePath = join(tmpDir, 'tasks.json');

      await saveTaskPlan(filePath, plan);

      const content = await readFile(filePath, 'utf-8');
      const loaded = JSON.parse(content);
      expect(loaded.project).toBe('test');
      expect(loaded.userStories).toHaveLength(2);
    });
  });

  describe('allStoriesPass', () => {
    it('should return false if any story is not passing', () => {
      const plan = createMinimalPlan();
      expect(allStoriesPass(plan)).toBe(false);
    });

    it('should return true if all stories pass', () => {
      const plan = createMinimalPlan();
      plan.userStories[0]!.passes = true;
      plan.userStories[1]!.passes = true;
      expect(allStoriesPass(plan)).toBe(true);
    });

    it('should return false for empty stories', () => {
      const plan = createMinimalPlan({ userStories: [] });
      expect(allStoriesPass(plan)).toBe(false);
    });
  });

  describe('hasPendingCorrection', () => {
    it('is false when lastReviewFindings is null', () => {
      expect(hasPendingCorrection(createMinimalPlan({ lastReviewFindings: null }))).toBe(false);
    });

    it("is true when lastReviewFindings holds a failed review's findings", () => {
      const plan = createMinimalPlan({ lastReviewFindings: 'getProjectId ignores projectRoot' });
      expect(hasPendingCorrection(plan)).toBe(true);
    });
  });

  describe('markStoryPassing', () => {
    it('should set passes=true for the specified story', () => {
      const plan = createMinimalPlan();
      const updated = markStoryPassing(plan, 'US-001');
      expect(updated.userStories[0]!.passes).toBe(true);
      expect(updated.userStories[1]!.passes).toBe(false);
    });

    it('should not modify other stories', () => {
      const plan = createMinimalPlan();
      const updated = markStoryPassing(plan, 'US-002');
      expect(updated.userStories[0]!.passes).toBe(false);
      expect(updated.userStories[1]!.passes).toBe(true);
    });
  });

  describe('applyStoryMetrics', () => {
    it('should write the share onto the targeted stories only', () => {
      const plan = createMinimalPlan();
      const updated = applyStoryMetrics(plan, ['US-001'], { inputTokens: 5, costUsd: 0.25 }, 30);

      expect(updated.userStories[0]).toMatchObject({
        inputTokens: 5,
        costUsd: 0.25,
        durationSeconds: 30,
      });
      expect(updated.userStories[1]).not.toHaveProperty('inputTokens');
      expect(updated.userStories[1]).not.toHaveProperty('durationSeconds');
    });

    it('should accumulate over values already on the story', () => {
      const plan = createMinimalPlan();
      const first = applyStoryMetrics(plan, ['US-001'], { inputTokens: 5, costUsd: 0.25 }, 30);
      const second = applyStoryMetrics(first, ['US-001'], { inputTokens: 3, costUsd: 0.1 }, 12);

      expect(second.userStories[0]).toMatchObject({
        inputTokens: 8,
        costUsd: 0.35,
        durationSeconds: 42,
      });
    });

    it('should leave unreported fields absent instead of writing zeros', () => {
      const plan = createMinimalPlan();
      const updated = applyStoryMetrics(plan, ['US-001'], { inputTokens: 5 });

      const story = updated.userStories[0]!;
      expect(story.inputTokens).toBe(5);
      expect(story).not.toHaveProperty('outputTokens');
      expect(story).not.toHaveProperty('cacheReadTokens');
      expect(story).not.toHaveProperty('costUsd');
      expect(story).not.toHaveProperty('durationSeconds');
    });

    it('should return the plan untouched when no story completed', () => {
      const plan = createMinimalPlan();
      expect(applyStoryMetrics(plan, [], { inputTokens: 5 }, 10)).toBe(plan);
    });

    it('should not mutate the input plan', () => {
      const plan = createMinimalPlan();
      applyStoryMetrics(plan, ['US-001'], { inputTokens: 5 }, 10);

      expect(plan.userStories[0]).not.toHaveProperty('inputTokens');
      expect(plan.userStories[0]).not.toHaveProperty('durationSeconds');
    });

    it('should ignore ids that are not in the plan', () => {
      const plan = createMinimalPlan();
      const updated = applyStoryMetrics(plan, ['US-999'], { inputTokens: 5 }, 10);

      expect(updated.userStories.every((s) => s.inputTokens === undefined)).toBe(true);
    });

    it('should survive a save -> load round-trip', async () => {
      const plan = applyStoryMetrics(
        createMinimalPlan(),
        ['US-001'],
        { inputTokens: 5, outputTokens: 2, cacheReadTokens: 100, costUsd: 0.25 },
        30,
      );
      const filePath = join(tmpDir, 'tasks.json');

      await saveTaskPlan(filePath, plan);
      const reloaded = await loadTaskPlan(filePath);

      expect(reloaded.userStories[0]).toMatchObject({
        inputTokens: 5,
        outputTokens: 2,
        cacheReadTokens: 100,
        costUsd: 0.25,
        durationSeconds: 30,
      });
      expect(reloaded.userStories[1]).not.toHaveProperty('inputTokens');
    });
  });

  describe('markIssueInProgress', () => {
    it('should set status to in_progress', () => {
      const plan = createMinimalPlan();
      const updated = markIssueInProgress(plan);
      expect(updated.issueStatus).toBe('in_progress');
      expect(updated.completedAt).toBeNull();
      expect(updated.lastAttemptAt).toBeTruthy();
    });
  });

  describe('markIssueCompleted', () => {
    it('should set status to completed with timestamps', () => {
      const plan = createMinimalPlan();
      const updated = markIssueCompleted(plan);
      expect(updated.issueStatus).toBe('completed');
      expect(updated.completedAt).toBeTruthy();
      expect(updated.lastAttemptAt).toBeTruthy();
      expect(updated.lastError).toBeNull();
      expect(updated.pipeline.executionCompleted).toBe(true);
    });
  });

  describe('setLastError', () => {
    it('should set lastError with category and message', () => {
      const plan = createMinimalPlan();
      const updated = setLastError(plan, 'test_error', 'Something failed');
      expect(updated.lastError).not.toBeNull();
      expect(updated.lastError!.category).toBe('test_error');
      expect(updated.lastError!.message).toBe('Something failed');
      expect(updated.lastError!.at).toBeTruthy();
    });
  });

  describe('clearLastError', () => {
    it('should clear error if it was set before the attempt', () => {
      const plan = createMinimalPlan();
      const withError = setLastError(plan, 'old_error', 'Old error');
      // Use a future timestamp to ensure the error was before it
      const cleared = clearLastError(withError, '9999-01-01T00:00:00Z');
      expect(cleared.lastError).toBeNull();
    });

    it('should keep error if it was set after the attempt started', () => {
      const plan = createMinimalPlan();
      const withError = setLastError(plan, 'new_error', 'New error');
      // Use a past timestamp — the error was set after
      const cleared = clearLastError(withError, '2000-01-01T00:00:00Z');
      expect(cleared.lastError).not.toBeNull();
    });
  });

  describe('trimErrorMessage', () => {
    it('should trim to 8 non-empty lines', () => {
      const lines = Array.from({ length: 15 }, (_, i) => `Line ${i + 1}`).join('\n');
      const trimmed = trimErrorMessage(lines);
      expect(trimmed.split('\n')).toHaveLength(8);
    });

    it('should skip empty lines', () => {
      const input = 'Line 1\n\n\nLine 2\n\nLine 3';
      const trimmed = trimErrorMessage(input);
      expect(trimmed).toBe('Line 1\nLine 2\nLine 3');
    });
  });
});
