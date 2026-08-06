import { createConfig, resolvePaths, validateDependencies } from '../config.js';
import { runEngine } from '../core/engine.js';
import { allStoriesPass, loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { printError } from '../ui/logger.js';

export interface ExecuteOptions {
  issue?: string;
  maxIterations?: number;
  retryLimit?: number;
  retryForever?: boolean;
  /**
   * Conventional-commit scope for the stories of this issue (`issue-71`).
   * Only the multi-issue queue sets it — see `EngineConfig.commitScope`.
   */
  commitScope?: string;
}

export async function runExecute(
  positionalMaxIter: number | undefined,
  options: ExecuteOptions,
): Promise<number> {
  const errors = await validateDependencies();
  if (errors.length > 0) {
    printError('The following required tools are not installed:');
    for (const err of errors) {
      console.log(err);
    }
    return 1;
  }

  const maxIterations = options.maxIterations ?? positionalMaxIter;

  const config = createConfig({
    issueNumber: options.issue,
    maxIterations,
    retryLimit: options.retryLimit,
    retryForever: options.retryForever,
    commitScope: options.commitScope,
  });

  const paths = await resolvePaths(config);
  const exitCode = await runEngine(config, paths);

  // Update pipeline state if all stories pass
  if (exitCode === 0 && config.issueNumber) {
    try {
      const plan = await loadTaskPlan(paths.prdFile);
      if (allStoriesPass(plan)) {
        plan.pipeline.executionCompleted = true;
        await saveTaskPlan(paths.prdFile, plan);
      }
    } catch {
      // Non-critical — engine already handled state
    }
  }

  return exitCode;
}
