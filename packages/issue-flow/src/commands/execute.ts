import { randomUUID } from 'node:crypto';
import { createConfig, loadWebConfig, resolvePaths, validateDependencies } from '../config.js';
import { runEngine } from '../core/engine.js';
import { getSessionPublisher, setSessionPublisher } from '../core/session-publisher.js';
import { MemoryPublisher, NullPublisher, type SessionPublisher } from '../core/session-state.js';
import { allStoriesPass, isoNow, loadTaskPlan, saveTaskPlan } from '../core/state-manager.js';
import { getPlanRepository } from '../storage/db/repository.js';
import { SqliteSessionPublisher } from '../storage/db/session-publisher.js';
import { resolveIssuePaths } from '../storage/resolve.js';
import { printError } from '../ui/logger.js';
import { getPackageVersion } from '../version.js';
import { ensureWebMonitor } from '../web/lock.js';

export interface ExecuteOptions {
  inPipeline?: boolean;
  issue?: string;
  maxIterations?: number;
  retryLimit?: number;
  retryForever?: boolean;
  /** `--restart-web`: replace the detached monitor before direct execution. */
  restartWeb?: boolean;
  /**
   * Conventional-commit scope for the stories of this issue (`issue-71`).
   * Only the multi-issue queue sets it — see `EngineConfig.commitScope`.
   */
  commitScope?: string;
}

export async function runExecute(options: ExecuteOptions): Promise<number> {
  const errors = await validateDependencies();
  if (errors.length > 0) {
    printError('The following required tools are not installed:');
    for (const err of errors) {
      console.log(err);
    }
    return 1;
  }

  const config = createConfig({
    issueNumber: options.issue,
    inPipeline: options.inPipeline,
    maxIterations: options.maxIterations,
    retryLimit: options.retryLimit,
    retryForever: options.retryForever,
    commitScope: options.commitScope,
  });

  const paths = await resolvePaths(config);
  const webConfig = await loadWebConfig();
  const inheritedPublisher = getSessionPublisher();
  let standalonePublisher: SessionPublisher | null = null;

  // `run` owns the publisher when it delegates to this command. A direct
  // `execute --issue N --web` has no owner, so install a SQLite publisher and
  // tear down only what this invocation created.
  if (
    webConfig.enabled &&
    config.issueNumber !== undefined &&
    inheritedPublisher instanceof NullPublisher
  ) {
    const issuePaths = await resolveIssuePaths(config.issueNumber, {
      projectRoot: paths.projectRoot,
    });
    const repository = getPlanRepository(issuePaths.tasksFile);
    const publisher =
      repository === undefined
        ? new MemoryPublisher({
            logLimit: webConfig.logLimit,
            includeLogs: webConfig.includeLogs,
          })
        : new SqliteSessionPublisher(repository, {
            logLimit: webConfig.logLimit,
            includeLogs: webConfig.includeLogs,
          });
    standalonePublisher = publisher;
    setSessionPublisher(publisher);
    const numericIssue = /^\d+$/.test(config.issueNumber) ? Number(config.issueNumber) : null;
    publisher.publish({
      type: 'session:start',
      at: isoNow(),
      sessionId: randomUUID(),
      issueNumber: numericIssue,
      phases: ['execute'],
      // The agent is only settled per invocation here, so the run-wide fields
      // stay null; the version is what makes the session attributable to a build.
      environment: {
        node: process.version,
        platform: process.platform,
        agent: null,
        model: null,
        cliVersion: getPackageVersion(),
      },
    });
    publisher.publish({ type: 'phase:start', at: isoNow(), phase: 'execute' });
    await ensureWebMonitor(
      {
        port: webConfig.port,
        host: webConfig.host,
        refreshSeconds: webConfig.refreshSeconds,
      },
      { restart: options.restartWeb === true },
    );
  }

  let exitCode: number | null = null;
  try {
    exitCode = await runEngine(config, paths);

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
  } finally {
    if (standalonePublisher !== null) {
      const success = exitCode === 0;
      standalonePublisher.publish({
        type: 'phase:end',
        at: isoNow(),
        phase: 'execute',
        success,
        ...(success ? {} : { error: 'Execute phase failed' }),
      });
      standalonePublisher.publish({
        type: 'session:end',
        at: isoNow(),
        status: success ? 'completed' : 'failed',
      });
      await standalonePublisher.close();
      setSessionPublisher(undefined);
    }
  }
}
