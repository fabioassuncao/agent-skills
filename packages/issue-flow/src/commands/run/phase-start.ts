import { PIPELINE_PHASES, PipelineManager, type PipelinePhase } from '../../core/pipeline.js';
import { loadTaskPlan } from '../../core/state-manager.js';
import { printError, printInfo } from '../../ui/logger.js';

/**
 * Decide which phase the renderer starts at, and whether resume is allowed.
 */
export async function resolveStartPhase(input: {
  from: string | undefined;
  activePhases: readonly PipelinePhase[];
  effectiveNoBranch: boolean;
  tasksPath: string;
}): Promise<{ ok: true; startPhase: PipelinePhase } | { ok: false }> {
  const { from, activePhases, effectiveNoBranch, tasksPath } = input;
  let startPhase: PipelinePhase = 'prd';
  if (from) {
    if (!(activePhases as readonly string[]).includes(from)) {
      const validPhases = activePhases.filter((p) => p !== 'init').join(', ');
      if (effectiveNoBranch && (PIPELINE_PHASES as readonly string[]).includes(from)) {
        printError(
          `The '${from}' phase is not available in --no-branch mode. Valid phases: ${validPhases}`,
        );
      } else {
        printError(`Invalid phase: ${from}. Valid phases: ${validPhases}`);
      }
      return { ok: false };
    }
    startPhase = from as PipelinePhase;
  } else {
    try {
      const plan = await loadTaskPlan(tasksPath);
      const mgr = new PipelineManager(plan, tasksPath, activePhases);
      const nextPhase = mgr.getNextPhase();
      if (nextPhase && nextPhase !== 'init') {
        startPhase = nextPhase;
        printInfo(`Resuming from phase: ${startPhase}`);
      }
    } catch {
      // No tasks.json yet — start from beginning
    }
  }

  if (from) {
    try {
      const plan = await loadTaskPlan(tasksPath);
      const mgr = new PipelineManager(plan, tasksPath, activePhases);
      if (!mgr.canResume(startPhase)) {
        printError(`Cannot resume from ${startPhase}: prerequisite phases not complete`);
        return { ok: false };
      }
    } catch {
      if (startPhase !== 'prd') {
        printError(`Cannot resume from ${startPhase}: no pipeline state found`);
        return { ok: false };
      }
    }
  }

  return { ok: true, startPhase };
}
