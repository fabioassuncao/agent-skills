import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskPlan } from '../types.js';
import {
  allStoriesPass,
  clearLastError,
  initializeState,
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
    branchName: 'issue/1-test',
    description: 'Test plan',
    issueStatus: 'pending',
    completedAt: null,
    lastAttemptAt: null,
    lastError: null,
    correctionCycle: 0,
    maxCorrectionCycles: 3,
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

    // Regression guard: plans written by 0.4.4/0.5.2 must keep loading verbatim.
    it('should load a tasks.json written by an older version', async () => {
      const legacyPlan = {
        project: 'issue-flow',
        issueNumber: 22,
        issueUrl: 'https://github.com/fabioassuncao/issue-flow/issues/22',
        branchName: 'issue/22-web-monitor',
        noBranch: false,
        description: 'Legacy plan',
        issueStatus: 'in_progress',
        completedAt: null,
        lastAttemptAt: '2026-07-01T12:00:00Z',
        lastError: null,
        correctionCycle: 0,
        maxCorrectionCycles: 3,
        pipeline: {
          analyzeCompleted: true,
          prdCompleted: true,
          jsonCompleted: true,
          executionCompleted: false,
          reviewCompleted: false,
          prCreated: false,
        },
        userStories: [
          {
            id: 'US-001',
            title: 'Legacy story',
            description: 'As a user...',
            acceptanceCriteria: ['Criterion 1'],
            priority: 1,
            passes: true,
            notes: '',
          },
        ],
      };
      const filePath = join(tmpDir, 'tasks.json');
      await writeFile(filePath, JSON.stringify(legacyPlan, null, 2), 'utf-8');

      const loaded = await loadTaskPlan(filePath);
      expect(loaded.issueNumber).toBe(22);
      expect(loaded.issueUrl).toBe('https://github.com/fabioassuncao/issue-flow/issues/22');
    });

    it('should load a tasks.json without issueUrl', async () => {
      const { issueUrl: _omitted, ...plan } = createMinimalPlan();
      const filePath = join(tmpDir, 'tasks.json');
      await writeFile(filePath, JSON.stringify(plan), 'utf-8');

      const loaded = await loadTaskPlan(filePath);
      expect(loaded.issueUrl).toBe('');
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

  describe('initializeState', () => {
    it('should fill defaults for missing fields', () => {
      const plan = {
        userStories: [
          {
            id: 'US-001',
            title: 'Test',
            description: '',
            acceptanceCriteria: [],
            priority: 1,
            passes: false,
            notes: '',
          },
        ],
      } as unknown as TaskPlan;

      const initialized = initializeState(plan);
      expect(initialized.issueStatus).toBe('pending');
      expect(initialized.completedAt).toBeNull();
      expect(initialized.lastError).toBeNull();
      expect(initialized.correctionCycle).toBe(0);
      expect(initialized.maxCorrectionCycles).toBe(3);
      expect(initialized.pipeline.prdCompleted).toBe(false);
    });

    it('should preserve existing values', () => {
      const plan = createMinimalPlan({ issueStatus: 'in_progress' });
      const initialized = initializeState(plan);
      expect(initialized.issueStatus).toBe('in_progress');
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
