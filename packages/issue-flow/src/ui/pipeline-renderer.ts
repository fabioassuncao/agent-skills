import { Listr, type ListrTask, PRESET_TIMER, PRESET_TIMESTAMP } from 'listr2';
import type { PipelinePhase } from '../core/pipeline.js';
import { getSessionPublisher } from '../core/session-publisher.js';
import { loadTaskPlan } from '../core/state-manager.js';
import {
  setActivityCallback,
  setOutputCallback,
  setStoryStageCallback,
  setStoryUpdateCallback,
} from '../core/verbose.js';
import type { UserStory } from '../types.js';
import { renderExecuteFocus } from './status-view.js';

/** Minimal interface for the listr2 task wrapper properties we use. */
interface TaskContext {
  title: string;
  output: string;
  newListr(tasks: ListrTask[], options?: Record<string, unknown>): Listr;
}

/**
 * Result returned after the pipeline renderer finishes.
 */
export interface PipelineResult {
  success: boolean;
  failedPhase?: string;
  overallElapsedSeconds: number;
}

/**
 * Options for runPipelineWithRenderer.
 */
export interface PipelineRendererOptions {
  /** All pipeline phases in order */
  phases: PipelinePhase[];
  /** Index of the first phase to run (phases before this are skipped) */
  startIndex: number;
  /** Whether verbose mode is enabled */
  verbose: boolean;
  /** Map of phase name to its async runner function */
  runners: Record<string, () => Promise<void>>;
  /** Path to tasks.json — enables execute-phase subtask progress when set */
  tasksPath?: string;
  /** Suffix per phase when its agent differs from the run default (e.g. `codex`). */
  phaseSuffixes?: Record<string, string>;
}

/**
 * Phase labels for display.
 *
 * Typed as `Record<string, string>` on purpose (phases arrive as plain strings
 * here), which also means adding a phase to `PipelinePhase` does *not* break
 * the build when its label is missing — it silently falls back to the
 * capitalized phase name. Hence `phaseLabel()` below being covered by a test.
 */
const PHASE_LABELS: Record<string, string> = {
  prd: 'PRD',
  plan: 'Plan',
  execute: 'Execute',
  review: 'Review',
  pr: 'PR',
  'pr-review': 'PR Review',
};

/**
 * Display label for a pipeline phase, falling back to the capitalized phase
 * name for anything not in the table.
 */
export function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase.charAt(0).toUpperCase() + phase.slice(1);
}

/**
 * Select the appropriate listr2 renderer based on environment.
 *
 * - TTY + not verbose -> 'default' (animated spinners)
 * - TTY + verbose -> 'verbose' (sequential lines)
 * - Non-TTY / CI -> 'simple' (plain timestamped output)
 *
 * NO_COLOR is handled by listr2's own color support and the useColor() utility,
 * not by switching renderers — a TTY with NO_COLOR still benefits from the
 * default renderer's layout and spinners.
 */
export function selectRenderer(verbose: boolean): 'default' | 'verbose' | 'simple' {
  const isTTY = !!process.stdout.isTTY;
  const isCI = !!process.env.CI;

  if (!isTTY || isCI) {
    return 'simple';
  }

  return verbose ? 'verbose' : 'default';
}

/**
 * Plain subtask title for a story, optionally suffixed to show it is the one
 * `execute` is currently working on. Exported standalone for testing without
 * spinning up a `listr2` renderer.
 */
export function storySubtaskTitle(
  story: Pick<UserStory, 'id' | 'title'>,
  executing: boolean,
): string {
  const base = `${story.id}: ${story.title}`;
  return executing ? `${base} → Executando...` : base;
}

/** Minimal view of a listr2 task the tracker needs: a writable title. */
interface TitledTask {
  title: string;
}

export interface ActiveStoryTracker {
  /** The story `execute` is now working on, or `undefined` for none. */
  setActive(storyId: string | undefined): void;
  /** Nothing is executing any more — drop the suffix from whoever holds it. */
  clear(): void;
}

/**
 * Keeps the "executing" suffix on exactly one story subtask at a time.
 *
 * `clear()` matters as much as `setActive()`: the engine leaves its loop the
 * moment the last story passes, so no further `iteration:start` ever arrives
 * to move the suffix off the story that just finished. Without an explicit
 * clear at the end of the phase, the terminal would keep showing a completed
 * story as executing while the web panel already shows it awaiting review.
 */
export function createActiveStoryTracker(
  stories: ReadonlyArray<Pick<UserStory, 'id' | 'title'>>,
  storyTasks: ReadonlyMap<string, TitledTask>,
): ActiveStoryTracker {
  let activeStoryId: string | undefined;

  const retitle = (storyId: string, executing: boolean): void => {
    const task = storyTasks.get(storyId);
    if (!task) return;
    task.title = storySubtaskTitle(
      stories.find((s) => s.id === storyId) ?? { id: storyId, title: '' },
      executing,
    );
  };

  return {
    setActive(storyId: string | undefined): void {
      if (activeStoryId !== undefined && activeStoryId !== storyId) {
        retitle(activeStoryId, false);
      }
      activeStoryId = storyId;
      if (storyId !== undefined) retitle(storyId, true);
    },
    clear(): void {
      if (activeStoryId === undefined) return;
      retitle(activeStoryId, false);
      activeStoryId = undefined;
    },
  };
}

/**
 * Clean mode never expands one line per story. The phase title carries
 * `N/M` and the output bar carries the active story plus the current tool,
 * both read from the same snapshot the dashboard uses.
 */
export function executeExpandsStories(verbose: boolean): boolean {
  return verbose;
}

function paintExecuteFocus(task: TaskContext): void {
  const lines = renderExecuteFocus(getSessionPublisher().snapshot());
  if (lines.length > 0) task.output = lines.join('\n');
}

/**
 * Build the execute phase task with dynamic subtasks for each user story.
 *
 * Stories that already pass are displayed as skipped. Pending stories wait for
 * the engine to complete them via the story update callback. The parent task
 * title is updated with aggregate progress (e.g., "Execute (3/5 stories passing)").
 */
function buildExecutePhaseTask(runner: () => Promise<void>, tasksPath: string, verbose: boolean) {
  return async (_ctx: unknown, task: TaskContext) => {
    let stories: UserStory[];
    try {
      const plan = await loadTaskPlan(tasksPath);
      stories = [...plan.userStories].sort((a, b) => a.priority - b.priority);
    } catch {
      // If we can't read the plan, fall back to running without subtasks
      setOutputCallback((line: string) => {
        task.output = line;
      });
      try {
        await runner();
      } finally {
        setOutputCallback(undefined);
      }
      return;
    }

    const totalStories = stories.length;
    const initialPassed = stories.filter((s) => s.passes).length;
    task.title = `Execute (${initialPassed}/${totalStories} stories passing)`;

    if (!executeExpandsStories(verbose)) {
      setStoryUpdateCallback((updatedStories: UserStory[]) => {
        const passed = updatedStories.filter((s) => s.passes).length;
        task.title = `Execute (${passed}/${totalStories} stories passing)`;
        paintExecuteFocus(task);
      });
      setStoryStageCallback(() => {
        paintExecuteFocus(task);
      });
      setActivityCallback(() => {
        paintExecuteFocus(task);
      });
      setOutputCallback((line: string) => {
        task.output = line;
      });
      try {
        await runner();
      } finally {
        setOutputCallback(undefined);
        setStoryUpdateCallback(undefined);
        setStoryStageCallback(undefined);
        setActivityCallback(undefined);
      }
      return;
    }

    // Create promise resolvers for pending stories
    const resolvers = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();

    // Set up story update callback — engine calls this after each iteration
    setStoryUpdateCallback((updatedStories: UserStory[]) => {
      const passed = updatedStories.filter((s) => s.passes).length;
      task.title = `Execute (${passed}/${totalStories} stories passing)`;

      for (const s of updatedStories) {
        if (s.passes && resolvers.has(s.id)) {
          resolvers.get(s.id)!.resolve();
          resolvers.delete(s.id);
        }
      }
    });

    // Own listr2 task handle per story subtask, so the story-stage callback
    // below can update a title after the subtask has already started — the
    // resolvers map alone has no reference back into the renderer.
    const storyTasks = new Map<string, TaskContext>();
    const tracker = createActiveStoryTracker(stories, storyTasks);

    // Engine calls this alongside every iteration:start, with the same
    // storyId the published event and the session snapshot carry — never a
    // second, independently computed "who is active" heuristic. Only ever
    // meaningful for a story still pending (an already-passing one has no
    // subtask left to update: it already resolved and disappeared from view).
    setStoryStageCallback((storyId: string | undefined) => {
      tracker.setActive(storyId);
    });

    // Build subtask definitions for each story
    const subtaskDefs = stories.map((story) => ({
      title: storySubtaskTitle(story, false),
      skip: story.passes ? 'already passing' : false,
      task: async (_c: unknown, subTask: TaskContext) => {
        storyTasks.set(story.id, subTask);
        await new Promise<void>((resolve, reject) => {
          resolvers.set(story.id, { resolve, reject });
        });
      },
      rendererOptions: {
        timer: PRESET_TIMER,
      },
    }));

    // Engine runner subtask — drives the execution loop
    const engineSubtask = {
      title: 'Running engine',
      task: async (_c: unknown, engineTask: TaskContext) => {
        setOutputCallback((line: string) => {
          engineTask.output = line;
        });
        try {
          await runner();
        } finally {
          setOutputCallback(undefined);
          setStoryUpdateCallback(undefined);
          setStoryStageCallback(undefined);
          // The engine is done — nothing is executing any more, whether it
          // finished the plan or failed mid-story.
          tracker.clear();
          // Resolve any remaining pending stories (engine finished successfully)
          for (const [, { resolve }] of resolvers) {
            resolve();
          }
          resolvers.clear();
        }
      },
      rendererOptions: {
        timer: PRESET_TIMER,
        outputBar: verbose ? Infinity : false,
        persistentOutput: false,
        bottomBar: verbose ? Infinity : 3,
      },
    };

    // Run engine + story subtasks concurrently:
    // - Engine subtask runs the actual execution loop
    // - Story subtasks resolve as the engine completes each story
    // Cleanup of setStoryUpdateCallback is handled in engineSubtask's finally block
    //
    // exitOnError must stay true: the per-story subtasks never reject (they
    // only ever get resolve()d, either by the story-update callback or by
    // engineSubtask's finally block once the engine is done), so the only way
    // this nested Listr can fail is engineSubtask itself throwing. With
    // exitOnError: false that failure was swallowed here — the outer "execute"
    // phase task then resolved successfully even though the engine failed,
    // and the pipeline moved on to `review` with 0 stories passing instead of
    // stopping. exitOnError: true lets the failure propagate out of
    // task.newListr(...) so the outer phase list (which does have
    // exitOnError: true) aborts before ever starting `review`.
    return task.newListr([engineSubtask, ...subtaskDefs], {
      concurrent: true,
      exitOnError: true,
      rendererOptions: {
        timer: PRESET_TIMER,
        collapseSkips: false,
      },
    });
  };
}

/**
 * Run the pipeline phases through listr2 for single-writer terminal output.
 *
 * Phases before startIndex are displayed as "skipped".
 * Each running phase shows an animated spinner with elapsed time.
 * Completed phases show a checkmark with final duration.
 * The execute phase shows per-story subtask progress when tasksPath is provided.
 */
export async function runPipelineWithRenderer(
  options: PipelineRendererOptions,
): Promise<PipelineResult> {
  const { phases, startIndex, verbose, runners, tasksPath, phaseSuffixes } = options;
  const overallStart = Date.now();
  let currentPhase: string | undefined;
  const renderer = selectRenderer(verbose);
  const isSimple = renderer === 'simple';

  const tasks = new Listr(
    phases.map((phase, index) => {
      const label = phaseSuffixes?.[phase]
        ? `${phaseLabel(phase)} (${phaseSuffixes[phase]})`
        : phaseLabel(phase);
      const isExecutePhase = phase === 'execute' && tasksPath;

      return {
        title: label,
        skip: index < startIndex ? 'skipped' : false,
        task: isExecutePhase
          ? async (_ctx: unknown, task: TaskContext) => {
              currentPhase = phase;
              const runner = runners[phase];
              if (!runner) {
                throw new Error(`No runner defined for phase: ${phase}`);
              }
              return buildExecutePhaseTask(runner, tasksPath, verbose)(_ctx, task);
            }
          : async (_ctx: unknown, task: TaskContext) => {
              currentPhase = phase;
              const runner = runners[phase];
              if (!runner) {
                throw new Error(`No runner defined for phase: ${phase}`);
              }
              // Route all output through task.output so listr2 controls rendering
              setOutputCallback((line: string) => {
                task.output = line;
              });
              try {
                await runner();
              } finally {
                setOutputCallback(undefined);
              }
            },
        rendererOptions: {
          timer: PRESET_TIMER,
          outputBar: verbose ? Infinity : false,
          persistentOutput: false,
        },
      };
    }),
    {
      renderer,
      rendererOptions: {
        timer: PRESET_TIMER,
        collapseSkips: false,
        ...(isSimple ? { timestamp: PRESET_TIMESTAMP } : {}),
      },
      exitOnError: true,
    },
  );

  let failedPhase: string | undefined;

  try {
    await tasks.run();
  } catch {
    failedPhase = currentPhase ?? phases[startIndex];
  } finally {
    // Ensure global callbacks are always cleaned up, even on unexpected errors
    setOutputCallback(undefined);
    setStoryUpdateCallback(undefined);
    setStoryStageCallback(undefined);
    setActivityCallback(undefined);
  }

  const overallElapsedSeconds = Math.floor((Date.now() - overallStart) / 1000);

  return {
    success: !failedPhase,
    failedPhase,
    overallElapsedSeconds,
  };
}
