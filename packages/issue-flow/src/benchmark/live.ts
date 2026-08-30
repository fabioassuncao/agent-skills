import { setIssuesCliOverrides } from '../config.js';
import { loadTaskPlan } from '../core/state-manager.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import { resetStorageResolutionCache, resolveIssuePaths } from '../storage/resolve.js';
import { runAcceptance } from '../verify/run-issue.js';
import type { RepeatOutcome, RepeatRunner, RepeatRunnerInput } from './real.js';

/**
 * Live repeats spend money. Unit tests must never take this path.
 * The only escape is an explicit `ISSUE_FLOW_E2E_BENCH=1`, matching the
 * `#80` Antigravity e2e gate.
 */
export function assertLiveBenchAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env.VITEST && env.ISSUE_FLOW_E2E_BENCH !== '1') {
    throw new Error(
      'issue-flow bench --mode real does not run under npm test. Set ISSUE_FLOW_E2E_BENCH=1 for a deliberate live campaign.',
    );
  }
}

export interface LiveRepeatDeps {
  runPipeline: (issue: string) => Promise<number>;
}

/**
 * Isolate one repetition: own ISSUE_FLOW_HOME, local issues, no GitHub,
 * `--setting-sources` pinned, `--fallback-model` never passed.
 */
export function createLiveRepeatRunner(deps: LiveRepeatDeps): RepeatRunner {
  return async (input: RepeatRunnerInput): Promise<RepeatOutcome> => {
    assertLiveBenchAllowed();
    const previousHome = process.env[GLOBAL_ROOT_ENV];
    const previousCwd = process.cwd();
    process.env[GLOBAL_ROOT_ENV] = input.campaignHome;
    resetStorageResolutionCache();
    setIssuesCliOverrides({ preferredProvider: 'local' });
    process.chdir(input.fixture.root);
    const started = performance.now();
    try {
      await deps.runPipeline(input.fixture.issueRef);
      const paths = await resolveIssuePaths(input.fixture.issueRef, {
        projectRoot: input.fixture.root,
      });
      const plan = await loadTaskPlan(paths.tasksFile);
      const records = plan.executions ?? [];
      const acceptance = await runAcceptance({
        cwd: input.fixture.root,
        issueDir: paths.issueDir,
        declared: input.fixture.expectedVerification,
        executionId: records.at(-1)?.id ?? null,
        skipReviewer: input.arm !== 'L2',
        explicit: input.arm === 'L2',
      });
      const wall = performance.now() - started;
      const harness = records.reduce((sum, record) => sum + (record.durationMs ?? 0), 0);
      const reported = records.flatMap((record) =>
        record.cost.status === 'reported' ? [record.cost.amount] : [],
      );
      const cost =
        reported.length > 0
          ? {
              status: 'reported' as const,
              amount: reported.reduce((sum, amount) => sum + amount, 0),
              currency: 'USD' as const,
            }
          : ({ status: 'unknown' as const, reason: 'not_reported' as const } as const);
      return {
        records,
        verdict: acceptance.verdict,
        taskDurationMs: wall,
        harnessExecutionMs: harness,
        orchestrationOverheadMs: Math.max(0, wall - harness),
        attemptCount: records.reduce((max, record) => Math.max(max, record.attempt), 0) || 1,
        cost,
      };
    } finally {
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env[GLOBAL_ROOT_ENV];
      else process.env[GLOBAL_ROOT_ENV] = previousHome;
      resetStorageResolutionCache();
      setIssuesCliOverrides({});
    }
  };
}
