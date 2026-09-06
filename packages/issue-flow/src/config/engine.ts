import { join } from 'node:path';
import { resolveIssuePaths } from '../storage/resolve.js';
import type { EngineConfig, ResolvedPaths } from '../types.js';
import { getProjectRoot } from '../utils/git.js';

/**
 * Default configuration values — matching the Bash script exactly.
 */
export const DEFAULTS = {
  retryLimit: 10,
  retryForever: false,
  backoffBaseSeconds: 30,
  backoffMaxSeconds: 900,
} as const;

/**
 * Create a EngineConfig with defaults merged with provided options.
 */
export function createConfig(options: Partial<EngineConfig>): EngineConfig {
  return {
    issueNumber: options.issueNumber,
    inPipeline: options.inPipeline,
    maxIterations: options.maxIterations,
    retryLimit: options.retryLimit ?? DEFAULTS.retryLimit,
    retryForever: options.retryForever ?? DEFAULTS.retryForever,
    backoffBaseSeconds: options.backoffBaseSeconds ?? DEFAULTS.backoffBaseSeconds,
    backoffMaxSeconds: options.backoffMaxSeconds ?? DEFAULTS.backoffMaxSeconds,
    // Left absent (rather than defaulted to an empty string) so the execute
    // prompt keeps its historical commit format unless a queue asks otherwise.
    ...(options.commitScope === undefined ? {} : { commitScope: options.commitScope }),
    storiesPerIteration: options.storiesPerIteration ?? 1,
  };
}

/**
 * Resolve file paths based on issue number and project root.
 *
 * With --issue N, every artifact comes from the global storage layer via
 * `resolveIssuePaths()`, which also migrates the legacy `<projectRoot>/issues/`
 * tree on first read:
 *   prdFile = ~/.issue-flow/projects/{id}/issues/{N}/tasks.json
 *   progressFile = ~/.issue-flow/projects/{id}/issues/{N}/progress.txt
 *
 * Standalone:
 *   prdFile = {projectRoot}/prd.json
 *   progressFile = {projectRoot}/progress.txt
 *
 * Beware of the asymmetric mapping in the issue branch: `ResolvedPaths.prdFile`
 * is the engine's *task plan*, so it maps to `IssuePaths.tasksFile`
 * (`tasks.json`) and **not** to `IssuePaths.prdFile` (`prd.md`, the human-facing
 * document produced by the `prd` phase). The name predates the split and is kept
 * because standalone mode really does read a `prd.json`.
 *
 * `projectRoot` stays on the result either way: `core/engine.ts` uses it as the
 * cwd of its git operations, which the global storage does not replace.
 */
export async function resolvePaths(
  config: EngineConfig,
  scriptDir?: string,
): Promise<ResolvedPaths> {
  const projectRoot = await getProjectRoot();

  if (config.issueNumber) {
    // projectRoot is forwarded so the resolver does not shell out to
    // `git rev-parse --show-toplevel` a second time for the answer we just got.
    const issuePaths = await resolveIssuePaths(config.issueNumber, { projectRoot });
    return {
      prdFile: issuePaths.tasksFile,
      progressFile: issuePaths.progressFile,
      archiveDir: issuePaths.archiveDir,
      lastBranchFile: issuePaths.lastBranchFile,
      projectRoot,
    };
  }

  // Standalone mode — use scriptDir if available, otherwise projectRoot
  const base = scriptDir ?? projectRoot;
  const standalone = {
    prdFile: join(base, 'prd.json'),
    progressFile: join(base, 'progress.txt'),
    archiveDir: join(base, 'archive'),
    lastBranchFile: join(base, '.last-branch'),
    projectRoot,
  };
  const { bindTelemetry } = await import('../telemetry/recorder.js');
  bindTelemetry({ tasksPath: standalone.prdFile });
  return standalone;
}
