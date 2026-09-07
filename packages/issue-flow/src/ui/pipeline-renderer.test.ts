import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PIPELINE_PHASES } from '../core/pipeline.js';
import { getStoryStageCallback } from '../core/verbose.js';
import type { TaskPlan } from '../types.js';
import { getIcons } from './logger.js';
import {
  createActiveStoryTracker,
  executeExpandsStories,
  phaseLabel,
  runPipelineWithRenderer,
  selectRenderer,
  storySubtaskTitle,
} from './pipeline-renderer.js';

/**
 * Regression coverage for the pipeline renderer itself.
 *
 * Every other test that touches `runPipeline` mocks `pipeline-renderer.js`
 * with a hand-rolled sequential loop (see commands/run.test.ts), so the real
 * listr2 wiring here — in particular whether a failed phase actually stops
 * the pipeline — was previously untested. That gap is exactly how a failed
 * `execute` phase (0/N stories passing, exit code 1) was still followed by
 * `review` running: the nested listr driving the execute phase's per-story
 * subtasks was built with `exitOnError: false`, which swallowed the engine
 * subtask's failure before it ever reached the outer phase list.
 */

function minimalPlan(overrides: Partial<TaskPlan> = {}): TaskPlan {
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
      prdCompleted: true,
      jsonCompleted: true,
      executionCompleted: false,
      reviewCompleted: false,
      prCreated: false,
    },
    userStories: [
      {
        id: 'US-001',
        title: 'A story',
        description: 'Test story',
        acceptanceCriteria: ['Criterion 1'],
        priority: 1,
        passes: false,
        notes: '',
      },
    ],
    ...overrides,
  };
}

describe('storySubtaskTitle', () => {
  it('is the plain "id: title" when not executing', () => {
    expect(storySubtaskTitle({ id: 'US-003', title: 'Add X' }, false)).toBe('US-003: Add X');
  });

  it('gets an "Executando..." suffix while executing', () => {
    expect(storySubtaskTitle({ id: 'US-003', title: 'Add X' }, true)).toBe(
      'US-003: Add X → Executando...',
    );
  });
});

describe('createActiveStoryTracker', () => {
  const stories = [
    { id: 'US-001', title: 'First' },
    { id: 'US-002', title: 'Second' },
  ];

  function makeTasks(): Map<string, { title: string }> {
    return new Map(stories.map((s) => [s.id, { title: storySubtaskTitle(s, false) }]));
  }

  it('marks the active story and un-marks the previous one', () => {
    const tasks = makeTasks();
    const tracker = createActiveStoryTracker(stories, tasks);

    tracker.setActive('US-001');
    expect(tasks.get('US-001')?.title).toBe(storySubtaskTitle(stories[0], true));

    tracker.setActive('US-002');
    expect(tasks.get('US-001')?.title).toBe('US-001: First');
    expect(tasks.get('US-002')?.title).toBe(storySubtaskTitle(stories[1], true));
  });

  it('clear() drops the suffix — the engine loop ends without a further iteration:start', () => {
    const tasks = makeTasks();
    const tracker = createActiveStoryTracker(stories, tasks);

    tracker.setActive('US-002');
    tracker.clear();

    expect(tasks.get('US-002')?.title).toBe('US-002: Second');
  });

  it('clear() is idempotent and safe with nothing active', () => {
    const tasks = makeTasks();
    const tracker = createActiveStoryTracker(stories, tasks);

    tracker.clear();
    tracker.clear();

    expect([...tasks.values()].map((t) => t.title)).toEqual(['US-001: First', 'US-002: Second']);
  });

  it('tolerates a story with no subtask registered yet', () => {
    const tracker = createActiveStoryTracker(stories, new Map());
    expect(() => {
      tracker.setActive('US-001');
      tracker.clear();
    }).not.toThrow();
  });
});

describe('executeExpandsStories', () => {
  it('keeps one line per story only under --verbose', () => {
    expect(executeExpandsStories(false)).toBe(false);
    expect(executeExpandsStories(true)).toBe(true);
  });
});

describe('terminal fallback contract', () => {
  function setStdoutTty(value: boolean): () => void {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value });
    return () => {
      if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor);
      else delete (process.stdout as NodeJS.WriteStream & { isTTY?: boolean }).isTTY;
    };
  }

  it('uses the simple listr2 renderer outside a TTY', () => {
    const restore = setStdoutTty(false);
    try {
      expect(selectRenderer(false)).toBe('simple');
      expect(selectRenderer(true)).toBe('simple');
    } finally {
      restore();
    }
  });

  it('keeps the TTY renderer but uses ASCII icons under NO_COLOR', () => {
    const restoreTty = setStdoutTty(true);
    const previousNoColor = process.env.NO_COLOR;
    const previousCi = process.env.CI;
    process.env.NO_COLOR = '1';
    delete process.env.CI;
    try {
      expect(selectRenderer(false)).toBe('default');
      expect(getIcons()).toMatchObject({ success: '[OK]', fail: '[FAIL]', connector: '|' });
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
      restoreTty();
    }
  });
});

describe('phaseLabel (issue 25, US-011)', () => {
  it('rotula a fase pr-review como "PR Review"', () => {
    // A tabela é Record<string, string>: ampliar PipelinePhase não quebra a
    // compilação quando o label falta, então o rótulo precisa de teste.
    expect(phaseLabel('pr-review')).toBe('PR Review');
  });

  it('mantém os rótulos das fases existentes', () => {
    expect(PIPELINE_PHASES.filter((p) => p !== 'init').map(phaseLabel)).toEqual([
      'PRD',
      'Plan',
      'Execute',
      'Review',
      'PR',
    ]);
  });

  it('capitaliza uma fase desconhecida em vez de exibir vazio', () => {
    expect(phaseLabel('deploy')).toBe('Deploy');
  });
});

describe('runPipelineWithRenderer — stops the pipeline on a failed phase', () => {
  it('does not run a phase after an earlier one throws (no tasksPath)', async () => {
    const started: string[] = [];
    const runners: Record<string, () => Promise<void>> = {
      prd: async () => {
        started.push('prd');
      },
      plan: async () => {
        started.push('plan');
        throw new Error('Phase plan failed with exit code 1');
      },
      execute: async () => {
        started.push('execute');
      },
      review: async () => {
        started.push('review');
      },
      pr: async () => {
        started.push('pr');
      },
    };

    const result = await runPipelineWithRenderer({
      phases: ['prd', 'plan', 'execute', 'review', 'pr'],
      startIndex: 0,
      verbose: false,
      runners,
    });

    expect(result.success).toBe(false);
    expect(result.failedPhase).toBe('plan');
    expect(started).toEqual(['prd', 'plan']);
  });

  describe('with tasksPath (execute phase drives per-story subtasks)', () => {
    let tmpDir: string;
    let tasksPath: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'issue-flow-pipeline-renderer-'));
      tasksPath = join(tmpDir, 'tasks.json');
      await writeFile(tasksPath, JSON.stringify(minimalPlan()), 'utf-8');
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    it('reports execute as the failed phase and never starts review', async () => {
      const started: string[] = [];
      const runners: Record<string, () => Promise<void>> = {
        prd: async () => {
          started.push('prd');
        },
        plan: async () => {
          started.push('plan');
        },
        execute: async () => {
          started.push('execute');
          throw new Error('Phase execute failed with exit code 1');
        },
        review: async () => {
          started.push('review');
        },
        pr: async () => {
          started.push('pr');
        },
      };

      const result = await runPipelineWithRenderer({
        phases: ['prd', 'plan', 'execute', 'review', 'pr'],
        startIndex: 0,
        verbose: false,
        runners,
        tasksPath,
      });

      expect(result.success).toBe(false);
      expect(result.failedPhase).toBe('execute');
      expect(started).toEqual(['prd', 'plan', 'execute']);
      expect(started).not.toContain('review');
    });

    it('still succeeds and runs every phase when execute passes', async () => {
      const started: string[] = [];
      const runners: Record<string, () => Promise<void>> = {
        prd: async () => {
          started.push('prd');
        },
        plan: async () => {
          started.push('plan');
        },
        execute: async () => {
          started.push('execute');
        },
        review: async () => {
          started.push('review');
        },
        pr: async () => {
          started.push('pr');
        },
      };

      const result = await runPipelineWithRenderer({
        phases: ['prd', 'plan', 'execute', 'review', 'pr'],
        startIndex: 0,
        verbose: false,
        runners,
        tasksPath,
      });

      expect(result.success).toBe(true);
      expect(result.failedPhase).toBeUndefined();
      expect(started).toEqual(['prd', 'plan', 'execute', 'review', 'pr']);
    });

    it('registers a story-stage callback while execute runs, and clears it afterward', async () => {
      let sawCallbackDuringExecute = false;
      const runners: Record<string, () => Promise<void>> = {
        prd: async () => {},
        plan: async () => {},
        execute: async () => {
          // Mirrors what engine.ts does alongside iteration:start — must not
          // throw, and must reach a registered callback.
          sawCallbackDuringExecute = getStoryStageCallback() !== undefined;
          getStoryStageCallback()?.('US-001');
        },
        review: async () => {},
        pr: async () => {},
      };

      const result = await runPipelineWithRenderer({
        phases: ['prd', 'plan', 'execute', 'review', 'pr'],
        startIndex: 0,
        verbose: false,
        runners,
        tasksPath,
      });

      expect(result.success).toBe(true);
      expect(sawCallbackDuringExecute).toBe(true);
      // Cleaned up like every other global callback once the renderer is done.
      expect(getStoryStageCallback()).toBeUndefined();
    });
  });
});
