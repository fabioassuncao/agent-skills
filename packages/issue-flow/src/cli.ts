import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Argument, Command, Help, InvalidArgumentError, Option } from 'commander';
import { parseAgentPhaseFlag } from './agents/resolve.js';
import {
  AGENT_PHASES,
  AGENT_PROVIDER_IDS,
  AGENT_PROVIDER_LIST,
  type AgentCliOverrides,
  isAgentProviderId,
} from './agents/types.js';
import { BENCH_MODES, TASK_CLASSES } from './benchmark/corpus.js';
import { buildRootHelp } from './cli-help.js';
import {
  CliFlagError,
  resolveQueueScopeFlags,
  resolveRunPhaseFlags,
  resolveUserStoryNumberingFlags,
  resolveWebOverrides,
} from './cli-options.js';
import { RunDemandError, resolveAutoCloseFlag } from './commands/run/demand.js';
import {
  QUEUE_FAILURE_MODES,
  type QueueFailureMode,
  RUNNABLE_PHASES_WITH_PR_REVIEW,
} from './commands/run/types.js';
import { attachCompletion } from './completion.js';
import {
  setAgentCliOverrides,
  setIssuesCliOverrides,
  setResilienceCliOverrides,
  setRoutingCliOverrides,
  setVerifyCliOverrides,
  setWebCliOverrides,
} from './config.js';
import { installShutdownHandlers } from './core/shutdown.js';
import { setGlobalTimeout, setInactivityTimeout, setVerbose } from './core/verbose.js';
import {
  IssueFlagError,
  resolveGenerateTarget,
  resolveIssuesOverrides,
} from './issues/cli-flags.js';
import type { IssueGenerateTarget } from './issues/types.js';
import { resolveResilienceOverrides } from './resilience/cli-flags.js';
import type { RoutingConfig } from './schemas.js';
import { printError } from './ui/logger.js';
import { VERIFICATION_LEVELS } from './verify/types.js';
import { getPackageVersion } from './version.js';

const version = getPackageVersion();

/**
 * Parse a numeric string, throwing InvalidArgumentError if not a valid number.
 */
function parseInteger(value: string): number {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new InvalidArgumentError('Must be a non-negative integer.');
  }
  return parsed;
}

function parseUsd(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new InvalidArgumentError('Must be a non-negative number.');
  }
  return parsed;
}

function collectString(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Parse `--on-issue-failure <mode>`, rejecting anything but the three modes. */
function parseQueueFailureMode(value: string): QueueFailureMode {
  if ((QUEUE_FAILURE_MODES as readonly string[]).includes(value)) {
    return value as (typeof QUEUE_FAILURE_MODES)[number];
  }
  throw new InvalidArgumentError(`Must be one of: ${QUEUE_FAILURE_MODES.join(', ')}.`);
}

/**
 * Parse `--start-us <n>`: a User Story number is 1-based, so 0 is rejected
 * along with everything `parseInteger` already rejects.
 */
function parseStartUs(value: string): number {
  const parsed = parseInteger(value);
  if (parsed < 1) {
    throw new InvalidArgumentError('Must be a positive integer (US-001 is the first story).');
  }
  return parsed;
}

/**
 * Add the User Story numbering override options to a subcommand that
 * triggers `plan` (`run` and `plan` itself) — see issue #36.
 */
function withUserStoryNumberingOptions(cmd: Command): Command {
  return cmd
    .option('--continue', 'Continue User Story numbering from the last used in this project')
    .option(
      '--start-us <n>',
      'Force User Story numbering to start at a specific number, ignoring history',
      parseStartUs,
    );
}

/**
 * Add shared options (--verbose) to a subcommand.
 */
function withGlobalOptions(cmd: Command): Command {
  return (
    cmd
      .option('-v, --verbose', 'Show agent progress output in real time')
      .option(
        '-t, --timeout <seconds>',
        'Override headless timeout in seconds (0 = no limit)',
        parseInteger,
      )
      // The second, tighter instrument beside the absolute timeout: a phase that
      // has said nothing for this long is stuck, not slow. `0` turns it off.
      .option(
        '--inactivity-timeout <seconds>',
        'Stop the agent after this many seconds with no output (0 = no watchdog)',
        parseInteger,
      )
      .addOption(
        new Option(
          '--agent <provider>',
          'Run every phase on this agent (claude|codex|cursor|antigravity|opencode)',
        ).choices(AGENT_PROVIDER_IDS),
      )
      .option('--agent-model <model>', 'Override the model for every phase')
      .option(
        '--agent-phase <phase>=<provider>[:<model>]',
        'Override one phase (repeatable)',
        collectAgentPhase,
        {} as AgentCliOverrides['phases'],
      )
      .addOption(
        new Option(
          '--verify-level <level>',
          'Acceptance-contract level: L0 | L1 | L2 | L3 | L5',
        ).choices(VERIFICATION_LEVELS),
      )
      .option('--no-cross-verify', 'Keep L2 off even when a trigger would fire')
      .option('--no-escalation', 'Keep routing.escalation.enabled off')
      .option('--max-cost <usd>', 'Issue cost ceiling in USD (Issue Flow enforces it)', parseUsd)
      .option('--max-duration <seconds>', 'Issue duration ceiling in seconds', parseInteger)
  );
}

function collectAgentPhase(
  value: string,
  previous: NonNullable<AgentCliOverrides['phases']> | undefined,
): NonNullable<AgentCliOverrides['phases']> {
  const parsed = parseAgentPhaseFlag(value);
  return { ...previous, [parsed.phase]: parsed.block };
}

function resolveAgentOverrides(opts: Record<string, unknown>): AgentCliOverrides {
  const overrides: AgentCliOverrides = {};
  if (typeof opts.agent === 'string') {
    if (!isAgentProviderId(opts.agent)) {
      throw new InvalidArgumentError(`Must be one of: ${AGENT_PROVIDER_IDS.join(', ')}.`);
    }
    overrides.forceProvider = opts.agent;
  }
  if (typeof opts.agentModel === 'string') {
    overrides.forceModel = opts.agentModel;
  }
  if (opts.agentPhase && typeof opts.agentPhase === 'object') {
    overrides.phases = opts.agentPhase as AgentCliOverrides['phases'];
  }
  return overrides;
}

function resolveVerifyOverrides(opts: Record<string, unknown>): {
  level?: (typeof VERIFICATION_LEVELS)[number];
  crossVerify?: boolean;
} {
  const overrides: { level?: (typeof VERIFICATION_LEVELS)[number]; crossVerify?: boolean } = {};
  if (typeof opts.verifyLevel === 'string') {
    if (!VERIFICATION_LEVELS.includes(opts.verifyLevel as (typeof VERIFICATION_LEVELS)[number])) {
      throw new InvalidArgumentError(`Must be one of: ${VERIFICATION_LEVELS.join(', ')}.`);
    }
    overrides.level = opts.verifyLevel as (typeof VERIFICATION_LEVELS)[number];
  }
  if (opts.crossVerify === false) overrides.crossVerify = false;
  return overrides;
}

function resolveRoutingOverrides(opts: Record<string, unknown>): Partial<RoutingConfig> {
  const overrides: Partial<RoutingConfig> = {};
  if (opts.escalation === false) {
    overrides.escalation = {
      enabled: false,
      minAttemptsBeforeEscalation: 2,
      maxEscalations: 2,
      maxRungs: ['effort', 'model', 'harness'],
    };
  }
  if (typeof opts.maxCost === 'number' || typeof opts.maxDuration === 'number') {
    overrides.ceilings = {
      maxCostUsdPerIssue: typeof opts.maxCost === 'number' ? opts.maxCost : null,
      maxDurationMsPerIssue: typeof opts.maxDuration === 'number' ? opts.maxDuration * 1000 : null,
      maxExecutionsPerIssue: null,
      onCeiling: 'block',
    };
  }
  return overrides;
}

/**
 * Add the resilience options to a subcommand, in the shape `--web` and
 * `--pr-review` already follow: declared here, resolved into configuration
 * overrides by the preAction hook, and applied through the same ladder every
 * other key climbs.
 */
function withResilienceOptions(cmd: Command): Command {
  return cmd
    .option('--continuous', 'Long-running profile: keep going without supervision')
    .option('--resilient', 'Alias of --continuous')
    .option('--no-failover', 'Never migrate a phase to another agent provider')
    .option('--auto-decompose', 'Act on a decomposition report instead of only writing it');
}

/**
 * Add web monitoring options to a subcommand (run and execute only).
 * The values are resolved into CLI overrides by the preAction hook below;
 * loadWebConfig() applies the flag > env > file > defaults precedence.
 */
function withWebOptions(cmd: Command): Command {
  return cmd
    .option('--web', 'Enable the web monitoring server')
    .option('--serve', 'Alias for --web')
    .option('--restart-web', 'Restart the web monitor before serving it (implies --web)')
    .option('--port <n>', 'Web server port (default: 3737)', parseInteger)
    .option('--host <h>', 'Web server host (default: 0.0.0.0)')
    .option('--refresh <s>', 'Suggested UI polling interval in seconds', parseInteger)
    .option('--web-log-limit <n>', 'Max log entries kept in the snapshot', parseInteger)
    .option('--web-no-logs', 'Exclude logs from the published snapshot');
}

/**
 * Add the Issue provider options to a subcommand.
 *
 * Declared once here (like withWebOptions) so no command repeats the flag
 * list; the preAction hook below turns them into config overrides, and
 * loadIssuesConfig() applies the flag > .issue-flow.json > defaults precedence.
 */
function withIssueOptions(cmd: Command): Command {
  return cmd
    .option('--local', 'Prefer the local file Issue provider')
    .option('--github', 'Prefer the GitHub Issue provider')
    .option('--prefer-local', 'On divergence, use the local version without asking')
    .option('--prefer-github', 'On divergence, use the GitHub version without asking')
    .option('--ask', 'On divergence, ask which version to use (interactive only)');
}

export const program = new Command();

const defaultHelp = new Help();
program.configureHelp({
  formatHelp(command, helper) {
    return command === program ? buildRootHelp() : defaultHelp.formatHelp(command, helper);
  },
});

program
  .name('issue-flow')
  .description(
    'Unified CLI for orchestrating the full issue-flow pipeline via Claude Code, Codex CLI, Cursor CLI or Antigravity CLI.',
  )
  .version(version);

program.hook('preAction', (_thisCommand, actionCommand) => {
  // Installed once, before any command runs: a `Ctrl+C` during a six-hour run
  // has to write a checkpoint and stop the agent, not kill the process
  // mid-phase and leave `session.json` on `running` forever.
  installShutdownHandlers();

  const opts = actionCommand.opts();
  if (opts.verbose) {
    setVerbose(true);
  }
  if (opts.timeout !== undefined) {
    setGlobalTimeout(opts.timeout * 1000);
  }
  if (opts.inactivityTimeout !== undefined) {
    setInactivityTimeout(opts.inactivityTimeout * 1000);
  }
  setWebCliOverrides(resolveWebOverrides(opts));
  try {
    setVerifyCliOverrides(resolveVerifyOverrides(opts));
    setAgentCliOverrides(resolveAgentOverrides(opts));
    setRoutingCliOverrides(resolveRoutingOverrides(opts));
  } catch (error) {
    if (error instanceof InvalidArgumentError) {
      printError(error.message);
      process.exit(1);
    }
    throw error;
  }
  // The CLI rung of the `resilience` ladder. `--continuous` expands here into
  // the settings it implies, with every granular flag applied on top of it.
  setResilienceCliOverrides(
    resolveResilienceOverrides({
      continuous: opts.continuous,
      resilient: opts.resilient,
      failover: opts.failover,
      autoDecompose: opts.autoDecompose,
      inactivityTimeout: opts.inactivityTimeout,
      onIssueFailure: opts.onIssueFailure,
    }),
  );
  try {
    setIssuesCliOverrides(resolveIssuesOverrides(opts));
  } catch (error) {
    if (error instanceof IssueFlagError) {
      printError(error.message);
      process.exit(1);
    }
    throw error;
  }
});

// ── init ────────────────────────────────────────────────────────────────────
withIssueOptions(
  withGlobalOptions(
    program
      .command('init')
      .description(
        'Check prerequisites and report (or create) the conventions this repository is missing',
      )
      .option('--apply', 'Create the missing files instead of only reporting them')
      .option('--json', 'Emit the plan as JSON')
      .option('--scope <dir>', 'Resolve the conventions for a subdirectory (monorepo)')
      .option('--check-only', 'Only verify prerequisites, as earlier releases did')
      .option('--no-agent-prompt', 'Skip the first-run agent choice'),
  ),
).action(
  async (options: {
    apply?: boolean;
    json?: boolean;
    scope?: string;
    checkOnly?: boolean;
    agentPrompt?: boolean;
  }) => {
    const { loadIssuesConfig } = await import('./config.js');
    const { runInit } = await import('./commands/init.js');
    const { preferredProvider } = await loadIssuesConfig();
    const code = await runInit(preferredProvider, {
      ...options,
      noAgentPrompt: options.agentPrompt === false,
    });
    process.exit(code);
  },
);

// ── generate ────────────────────────────────────────────────────────────────
withGlobalOptions(
  program
    .command('generate')
    .description('Draft an issue with the configured agent and create it')
    .requiredOption('--prompt <text>', 'Issue description text')
    .option('--github', 'Create the issue on GitHub')
    .option('--local', 'Create the issue under issues/<n>/ only')
    .option('--both', 'Create the issue on GitHub and mirror it locally'),
).action(async (options: { prompt: string; github?: boolean; local?: boolean; both?: boolean }) => {
  let target: IssueGenerateTarget | undefined;
  try {
    target = resolveGenerateTarget(options);
  } catch (error) {
    if (error instanceof IssueFlagError) {
      printError(error.message);
      process.exit(1);
    }
    throw error;
  }

  const { runGenerate } = await import('./commands/generate.js');
  const code = await runGenerate(options.prompt, target);
  process.exit(code);
});

// ── run ─────────────────────────────────────────────────────────────────────
withUserStoryNumberingOptions(
  withResilienceOptions(
    withWebOptions(
      withIssueOptions(
        withGlobalOptions(
          program
            .command('run')
            .description(
              'Execute the full pipeline: prd → plan → execute → review → pr (→ pr-review, optional)',
            )
            .argument('[issues...]', 'Issue number(s): 42, "42,43" or 42 43')
            // The demand itself, with no Issue behind it (§17). It is minted
            // into an Issue of the `inline` origin before anything starts, so
            // the pipeline, the acceptance contract and the independent
            // reviewer are the same ones an issue number gets.
            .option('--prompt <text>', 'Describe the work directly, without an Issue')
            .option('--auto-close', 'Close the agent sessions this run leaves open once it is done')
            .option('--keep-open', 'Leave them open, revoking a configured run.autoClose')
            .option('--mode <mode>', 'Execution mode: auto | manual', 'auto')
            .addOption(
              new Option('--from <phase>', 'Resume from a specific phase').choices(
                RUNNABLE_PHASES_WITH_PR_REVIEW,
              ),
            )
            .option(
              '--no-branch',
              'Run pipeline on current branch without creating a new branch or PR',
            )
            .option('--pr-review', 'Review the created Pull Request after the pr phase')
            .option('--close-issue', 'Close issues after successful delivery; remember this choice')
            .option('--no-close-issue', 'Revoke automatic issue closure')
            .option('-y, --yes', 'Run the whole discovered hierarchy without confirmation')
            .option('--cascade', 'Run the children of a container, without implementing it')
            .option('--only', 'Run just the issues informed, without their hierarchy')
            // Same two flags `execute` has always had, forwarded to the execute
            // phase of the pipeline: a `run` is the only way most users reach that
            // loop, and had no way to widen its retry budget.
            .option(
              '--retry-limit <number>',
              'Retry transient Claude failures up to N consecutive times',
              parseInteger,
            )
            .option('--retry-forever', 'Retry transient Claude failures indefinitely')
            // What one failing issue does to the rest of a queue. `stop` is what
            // every release before this flag did, and stays the default.
            .addOption(
              new Option(
                '--on-issue-failure <mode>',
                'In a queue, on a failing issue: stop | skip | block',
              )
                .choices(QUEUE_FAILURE_MODES)
                .argParser(parseQueueFailureMode),
            )
            .option('-d, --background', 'Detach after confirmation and return the terminal')
            .addOption(new Option('--detached-child').hideHelp()),
        ),
      ),
    ),
  ),
).action(
  async (
    issues: string[],
    options: {
      mode: string;
      from?: string;
      branch?: boolean;
      prReview?: boolean;
      closeIssue?: boolean;
      prompt?: string;
      autoClose?: boolean;
      keepOpen?: boolean;
      yes?: boolean;
      only?: boolean;
      continue?: boolean;
      startUs?: number;
      retryLimit?: number;
      retryForever?: boolean;
      onIssueFailure?: 'stop' | 'skip' | 'block';
      background?: boolean;
      detachedChild?: boolean;
      restartWeb?: boolean;
    },
  ) => {
    let phases: ReturnType<typeof resolveRunPhaseFlags>;
    let scope: ReturnType<typeof resolveQueueScopeFlags>;
    let numbering: ReturnType<typeof resolveUserStoryNumberingFlags>;
    let autoClose: boolean | undefined;
    try {
      phases = resolveRunPhaseFlags(options);
      scope = resolveQueueScopeFlags(options);
      numbering = resolveUserStoryNumberingFlags(options);
      autoClose = resolveAutoCloseFlag(options);
    } catch (error) {
      if (error instanceof CliFlagError || error instanceof RunDemandError) {
        printError(error.message);
        process.exit(1);
      }
      throw error;
    }

    const { runPipeline } = await import('./commands/run.js');
    const code = await runPipeline(
      issues,
      options.mode,
      options.from,
      phases.noBranch,
      phases.prReview,
      {
        closeIssue: options.closeIssue,
        prompt: options.prompt,
        autoClose,
        yes: scope.yes,
        only: scope.only,
        cascade: scope.cascade,
        continueNumbering: numbering.continueFlag,
        startUs: numbering.startUs,
        retryLimit: options.retryLimit,
        retryForever: options.retryForever,
        onIssueFailure: options.onIssueFailure,
        background: options.background,
        detachedChild: options.detachedChild,
        restartWeb: options.restartWeb,
      },
    );
    process.exit(code);
  },
);

// ── resume ──────────────────────────────────────────────────────────────────
withIssueOptions(
  withGlobalOptions(
    program
      .command('resume')
      .description('Resume an interrupted pipeline from the phase it stopped at')
      .argument('[issue]', 'Issue to resume. Omitted: the most recently attempted one')
      .option('--all', 'Resume every unfinished issue of this project, in order')
      .option('--close-issue', 'Close issues after successful delivery; remember this choice')
      .option('--no-close-issue', 'Revoke automatic issue closure')
      .option('--mode <mode>', 'Execution mode: auto | manual', 'auto'),
  ),
).action(
  async (
    issue: string | undefined,
    options: { all?: boolean; mode?: string; closeIssue?: boolean },
  ) => {
    const { runResume } = await import('./commands/resume.js');
    const code = await runResume(issue, {
      ...(options.closeIssue === undefined ? {} : { closeIssue: options.closeIssue }),
      ...(options.all === undefined ? {} : { all: options.all }),
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    process.exit(code);
  },
);

// Explicit-file inspection works outside a repository and without an agent.
const artifactsCommand = program
  .command('artifacts')
  .description('Inspect local artifacts without changing files or CLI state');
// Argument failures are part of this machine-readable command's contract too.
if (process.argv.includes('--json')) {
  artifactsCommand.configureOutput({ writeErr: () => {} }).exitOverride((error) => {
    if (error.exitCode === 0) process.exit(0);
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        ok: false,
        data: null,
        errors: [{ code: 'arguments', path: '', message: error.message }],
      }),
    );
    process.exit(1);
  });
}
for (const operation of ['plan', 'issue']) {
  const command = artifactsCommand.command(operation).argument('[file]', 'Artifact path');
  if (operation === 'issue') command.argument('[metadata]', 'Optional metadata.json');
  else command.option('--context', 'Select current execution facts without history');
  command.option('--json', 'Emit a versioned JSON inspection').allowExcessArguments(false);
  command.action(async (...args: unknown[]) => {
    const file = args[0] as string | undefined;
    const metadata = operation === 'issue' ? (args[1] as string | undefined) : undefined;
    const options = args[operation === 'issue' ? 2 : 1] as { json?: boolean; context?: boolean };
    const { runArtifacts } = await import('./commands/artifacts.js');
    process.exit(
      await runArtifacts(options.context ? 'context' : operation, file, metadata, options.json),
    );
  });
}

// ── status / runs / logs / pause / cancel ───────────────────────────────────
// The operation surface of a long run. Every one of them reads state that
// already exists; only pause and cancel write anything, and what they write is
// a signal to the process that owns the run.
withGlobalOptions(
  program
    .command('status')
    .description('What is running right now, in which phase, and since when')
    .argument('[issue]', 'Restrict the report to one issue')
    .option('--json', 'Emit the assembled state as JSON'),
).action(async (issue: string | undefined, options: { json?: boolean }) => {
  const { runStatus } = await import('./commands/operations.js');
  process.exit(
    await runStatus(issue, { ...(options.json === undefined ? {} : { json: options.json }) }),
  );
});

withGlobalOptions(
  program
    .command('usage')
    .description('Aggregate execution telemetry from SQLite')
    .argument('[issue]', 'Restrict the report to one issue')
    .option('--issue <issue>', 'Same as the positional argument')
    .option('--since <date>', 'Only executions started on or after this ISO date')
    .option('--by <key>', 'Group by harness, provider, model, purpose, trigger or status')
    .option('--json', 'Emit the assembled totals as JSON'),
).action(
  async (
    issue: string | undefined,
    options: { issue?: string; since?: string; by?: string; json?: boolean },
  ) => {
    const { runUsage, USAGE_GROUP_KEYS } = await import('./commands/usage.js');
    const by = options.by;
    if (by !== undefined && !(USAGE_GROUP_KEYS as readonly string[]).includes(by)) {
      printError('Must be one of: harness, provider, model, purpose, trigger, status.');
      process.exit(1);
    }
    process.exit(
      await runUsage(issue ?? options.issue, {
        ...(options.since === undefined ? {} : { since: options.since }),
        ...(by === undefined ? {} : { by: by as (typeof USAGE_GROUP_KEYS)[number] }),
        ...(options.json === undefined ? {} : { json: options.json }),
      }),
    );
  },
);

withGlobalOptions(
  program
    .command('ps')
    .description('Every issue-flow run active on this machine')
    .option('--json', 'Emit the listing as JSON')
    .option('--watch', 'Refresh the listing until interrupted'),
).action(async (options: { json?: boolean; watch?: boolean }) => {
  const { runPs } = await import('./commands/ps.js');
  process.exit(await runPs(options));
});

// ── db ──────────────────────────────────────────────────────────────────────
const db = program.command('db').description('Inspect and maintain the Issue Flow SQLite database');

db.command('check')
  .description('Run SQLite integrity_check')
  .action(async () => {
    const { runDbCheck } = await import('./commands/db.js');
    process.exit(await runDbCheck());
  });

db.command('backup')
  .description('Create a consistent SQLite backup')
  .option('--destination <path>', 'Where to write the backup')
  .action(async (options: { destination?: string }) => {
    const { runDbBackup } = await import('./commands/db.js');
    process.exit(await runDbBackup(options.destination));
  });

db.command('vacuum')
  .description('Rebuild the SQLite database to reclaim unused space')
  .action(async () => {
    const { runDbVacuum } = await import('./commands/db.js');
    process.exit(await runDbVacuum());
  });

db.command('export')
  .description('Export structured SQLite state as readable JSON')
  .option('--destination <path>', 'Where to write the JSON export (stdout by default)')
  .action(async (options: { destination?: string }) => {
    const { runDbExport } = await import('./commands/db.js');
    process.exit(await runDbExport(options.destination));
  });

db.command('verify')
  .description('Compare task and queue projections with canonical SQLite state')
  .action(async () => {
    const { runDbVerify } = await import('./commands/db.js');
    process.exit(await runDbVerify());
  });

db.command('import')
  .description('Import preserved compatibility artifacts')
  .option('--with-events', 'Also import the potentially large JSONL journal')
  .action(async (options: { withEvents?: boolean }) => {
    const { runDbImport } = await import('./commands/db.js');
    process.exit(await runDbImport(options));
  });

withGlobalOptions(
  program.command('runs').description('History of the runs of this project, with how each ended'),
).action(async () => {
  const { runRuns } = await import('./commands/operations.js');
  process.exit(await runRuns());
});

withGlobalOptions(
  program
    .command('history')
    .description('Relational phase, invocation and verdict history for one issue')
    .argument('<issue>', 'Issue identifier')
    .option('--json', 'Emit the complete history as JSON'),
).action(async (issue: string, options: { json?: boolean }) => {
  const { runHistory } = await import('./commands/history.js');
  process.exit(await runHistory(issue, options));
});

withGlobalOptions(
  program
    .command('logs')
    .description('Read the execution journal (events.jsonl), filtered and readable')
    .argument('[issue]', 'Issue to read. Omitted: the most recently attempted one')
    .option('--issue <issue>', 'Same as the positional argument')
    .option('--follow', 'Keep reading as the journal grows')
    .option('--tail <n>', 'How many entries to show first (default 50)', parseInteger)
    .option('--kind <kinds>', 'Only these event types, comma separated (retry, phase:end, …)'),
).action(
  async (
    issue: string | undefined,
    options: { issue?: string; follow?: boolean; tail?: number; kind?: string },
  ) => {
    const { runLogs } = await import('./commands/operations.js');
    const kinds =
      options.kind === undefined
        ? undefined
        : options.kind
            .split(',')
            .map((kind) => kind.trim())
            .filter((kind) => kind !== '');
    process.exit(
      await runLogs(issue ?? options.issue, {
        ...(kinds === undefined ? {} : { kind: kinds }),
        ...(options.follow === undefined ? {} : { follow: options.follow }),
        ...(options.tail === undefined ? {} : { tail: options.tail }),
      }),
    );
  },
);

withGlobalOptions(
  program
    .command('pause')
    .description('Ask the running pipeline to stop after writing a checkpoint'),
).action(async () => {
  const { runPause } = await import('./commands/operations.js');
  process.exit(await runPause());
});

withGlobalOptions(
  program
    .command('cancel')
    .description('Stop the run and mark the issue so a resume does not pick it up')
    .argument('[issue]', 'Issue to cancel. Omitted: the most recently attempted one'),
).action(async (issue: string | undefined) => {
  const { runCancel } = await import('./commands/operations.js');
  process.exit(await runCancel(issue));
});

// ── analyze ─────────────────────────────────────────────────────────────────
withIssueOptions(
  withGlobalOptions(
    program
      .command('analyze')
      .description('Analyze an issue with the configured agent')
      .argument('<issue>', 'Issue number'),
  ),
).action(async (issue: string) => {
  const { runAnalyze } = await import('./commands/analyze.js');
  const code = await runAnalyze(issue);
  process.exit(code);
});

// ── prd ─────────────────────────────────────────────────────────────────────
withIssueOptions(
  withGlobalOptions(
    program
      .command('prd')
      .description('Generate a PRD from an analyzed issue with the configured agent')
      .argument('<issue>', 'Issue number'),
  ),
).action(async (issue: string) => {
  const { runPrd } = await import('./commands/prd.js');
  const code = await runPrd(issue);
  process.exit(code);
});

// ── plan ────────────────────────────────────────────────────────────────────
withUserStoryNumberingOptions(
  withIssueOptions(
    withGlobalOptions(
      program
        .command('plan')
        .description('Convert a PRD to a tasks.json task plan with the configured agent')
        .argument('<issue>', 'Issue number'),
    ),
  ),
).action(async (issue: string, options: { continue?: boolean; startUs?: number }) => {
  let numbering: ReturnType<typeof resolveUserStoryNumberingFlags>;
  try {
    numbering = resolveUserStoryNumberingFlags(options);
  } catch (error) {
    if (error instanceof CliFlagError) {
      printError(error.message);
      process.exit(1);
    }
    throw error;
  }

  const { runPlan } = await import('./commands/plan.js');
  const code = await runPlan(issue, undefined, numbering);
  process.exit(code);
});

// ── execute ─────────────────────────────────────────────────────────────────
withWebOptions(
  withGlobalOptions(
    program
      .command('execute')
      .description('Run the iterative story execution loop (issue-flow engine)')
      .option('--issue <number>', 'Issue number — reads artifacts from issues/N/')
      .option('--max-iterations <number>', 'Stop after N iterations', parseInteger)
      .option(
        '--retry-limit <number>',
        'Retry transient Claude failures up to N consecutive times',
        parseInteger,
      )
      .option('--retry-forever', 'Retry transient Claude failures indefinitely')
      .argument(
        '[max-iterations]',
        'Backward-compatible alias for --max-iterations N',
        parseInteger,
      ),
  ),
).action(
  async (
    positionalMaxIter: number | undefined,
    options: {
      issue?: string;
      maxIterations?: number;
      retryLimit?: number;
      retryForever?: boolean;
      restartWeb?: boolean;
    },
  ) => {
    try {
      const { runExecute } = await import('./commands/execute.js');
      const code = await runExecute(positionalMaxIter, options);
      process.exit(code);
    } catch (error) {
      printError(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  },
);

// ── review ──────────────────────────────────────────────────────────────────
withIssueOptions(
  withGlobalOptions(
    program
      .command('review')
      .description('Validate an issue resolution with the configured agent')
      .argument('<issue>', 'Issue number'),
  ),
).action(async (issue: string) => {
  const { runReview } = await import('./commands/review.js');
  const code = await runReview(issue);
  process.exit(code);
});

// ── pr ──────────────────────────────────────────────────────────────────────
withIssueOptions(
  withGlobalOptions(
    program
      .command('pr')
      .description('Create a pull request with the configured agent')
      .argument('<issue>', 'Issue number'),
  ),
).action(async (issue: string) => {
  const { runPr } = await import('./commands/pr.js');
  const code = await runPr(issue);
  process.exit(code);
});

// ── web ─────────────────────────────────────────────────────────────────────
// ── serve ───────────────────────────────────────────────────────────────────
// The canonical name for the machine-wide monitor. `web serve` stays as its
// alias (§47.4): the command, the lock and the detached-spawn contract are
// unchanged, so nothing that already spells `web serve` has to be rewritten.
program
  .command('serve')
  .description('Serve every registered project on one dashboard')
  .option('--port <n>', 'Web server port (default: 3737)', parseInteger)
  .option('--host <h>', 'Web server host (default: 0.0.0.0)')
  .option('--refresh <s>', 'Suggested UI polling interval in seconds', parseInteger)
  .option(
    '--project <path>',
    'Serve an extra repository for this process only (repeatable)',
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .action(
    async (options: { port?: number; host?: string; refresh?: number; project?: string[] }) => {
      const { runServe } = await import('./commands/serve.js');
      const code = await runServe(options);
      // On success this process stays alive for as long as the server is bound
      // (server.ts binds it with unref: false) — only a failure exits here.
      if (code !== 0) {
        process.exit(code);
      }
    },
  );

// ── project ─────────────────────────────────────────────────────────────────
// Reads and writes the registry in SQLite directly: these commands work with
// no server running (§47.5), which is the one adaptation the upstream CLI —
// a pure HTTP client — could not have.
const projectCommand = program
  .command('project')
  .description('Curate the projects the dashboard serves');

projectCommand
  .command('ls')
  .alias('list')
  .description('List known projects, curated and discovered')
  .option('--json', 'Emit the list as JSON')
  .action(async (options: { json?: boolean }) => {
    const { runProjectLs } = await import('./commands/project.js');
    process.exit(await runProjectLs(options));
  });

projectCommand
  .command('add')
  .description('Add a project (defaults to the current repository)')
  .argument('[path]', 'Repository path', '.')
  .action(async (path: string) => {
    const { runProjectAdd } = await import('./commands/project.js');
    process.exit(await runProjectAdd(path));
  });

projectCommand
  .command('rm')
  .alias('remove')
  .description('Stop curating a project; its runs and history are preserved')
  .argument('<project>', 'Project id, served prefix or path')
  .action(async (target: string) => {
    const { runProjectRm } = await import('./commands/project.js');
    process.exit(await runProjectRm(target));
  });

projectCommand
  .command('use')
  .description('Mark a project as the most recently used one')
  .argument('<project>', 'Project id, served prefix or path')
  .action(async (target: string) => {
    const { runProjectUse } = await import('./commands/project.js');
    process.exit(await runProjectUse(target));
  });

// ── session ─────────────────────────────────────────────────────────────────
// The one entry point that does not start from an Issue (§49, ADR-16): an
// agent, on a branch, in a worktree, with no plan and no workflow behind it.
// Like `project`, it reads and writes SQLite directly, so it works with no
// server running.
const sessionCommand = program
  .command('session')
  .description('Open and manage agent sessions, with or without an issue');

sessionCommand
  .command('new')
  .description('Open an agent session on a branch — no issue required')
  .option('--agent <id>', `Agent to open (${AGENT_PROVIDER_LIST})`)
  .option('--branch <name>', 'Branch to work on (generated when omitted)')
  .option('--profile <name>', 'Runtime profile to open with')
  .option('--prompt <text>', 'First turn, delivered in the agent argv')
  .option('--label <text>', 'Caption for the session, since no issue names it')
  .option('--permission <level>', 'read-only | workspace | autonomous (default: workspace)')
  .option('--model <name>', 'Model override for this session')
  .option('--project <path>', 'Repository to open the session in (default: the current one)')
  .option('--json', 'Emit the created session as JSON')
  .action(
    async (options: {
      agent?: string;
      branch?: string;
      profile?: string;
      prompt?: string;
      label?: string;
      permission?: string;
      model?: string;
      project?: string;
      json?: boolean;
    }) => {
      const { runSessionNew } = await import('./commands/session.js');
      process.exit(await runSessionNew(options));
    },
  );

sessionCommand
  .command('ls')
  .alias('list')
  .description('List free sessions; --all includes the ones a run owns')
  .option('--all', 'Include sessions bound to a run')
  .option('--project <path>', 'Repository to list (default: the current one)')
  .option('--json', 'Emit the list as JSON')
  .action(async (options: { all?: boolean; project?: string; json?: boolean }) => {
    const { runSessionLs } = await import('./commands/session.js');
    process.exit(await runSessionLs(options));
  });

sessionCommand
  .command('attach')
  .description("Attach this terminal to a session's tmux window")
  .argument('<id>', 'Session id')
  .option('--project <path>', 'Repository the session belongs to')
  .action(async (id: string, options: { project?: string }) => {
    const { runSessionAttach } = await import('./commands/session.js');
    process.exit(await runSessionAttach(id, options));
  });

sessionCommand
  .command('send')
  .description('Send a subsequent turn to a live session')
  .argument('<id>', 'Session id')
  .argument('<text>', 'Text to deliver')
  .option('--project <path>', 'Repository the session belongs to')
  .action(async (id: string, text: string, options: { project?: string }) => {
    const { runSessionSend } = await import('./commands/session.js');
    process.exit(await runSessionSend(id, text, options));
  });

sessionCommand
  .command('stop')
  .description('Stop a session; its worktree and branch survive by default')
  .argument('<id>', 'Session id')
  .option('--remove-worktree', 'Also remove the worktree and its branch')
  .option('--project <path>', 'Repository the session belongs to')
  .action(async (id: string, options: { removeWorktree?: boolean; project?: string }) => {
    const { runSessionStop } = await import('./commands/session.js');
    process.exit(await runSessionStop(id, options));
  });

sessionCommand
  .command('link')
  .description('Bind a free session to an existing run, promoting it to the workflow')
  .argument('<id>', 'Session id')
  .option('--issue <number>', 'Issue whose most recent run to link to')
  .option('--run <id>', 'Link to this run specifically')
  .option('--project <path>', 'Repository the session belongs to')
  .action(async (id: string, options: { issue?: string; run?: string; project?: string }) => {
    const { runSessionLink } = await import('./commands/session.js');
    process.exit(await runSessionLink(id, options));
  });

// ── tab ─────────────────────────────────────────────────────────────────────
// Tabs are AgentSessions in the same worktree. These commands call the same
// locked domain operations as the HTTP surface; the CLI is not a second model.
const tabCommand = program
  .command('tab')
  .description('List, fork, switch and close agent tabs in one worktree');

tabCommand
  .command('list')
  .alias('ls')
  .description('List tabs; the active AgentSession is marked with *')
  .argument('<branch>', 'Worktree branch')
  .option('--project <path>', 'Repository the worktree belongs to')
  .option('--json', 'Emit pure JSON')
  .action(async (branch: string, options: { project?: string; json?: boolean }) => {
    const { runTabList } = await import('./commands/tab.js');
    process.exit(await runTabList(branch, options));
  });

tabCommand
  .command('create')
  .description('Fork the root provider conversation into a new AgentSession')
  .argument('<branch>', 'Worktree branch')
  .option('--project <path>', 'Repository the worktree belongs to')
  .option('--json', 'Emit pure JSON')
  .action(async (branch: string, options: { project?: string; json?: boolean }) => {
    const { runTabCreate } = await import('./commands/tab.js');
    process.exit(await runTabCreate(branch, options));
  });

tabCommand
  .command('switch')
  .description('Bring an existing tab pane to the worktree window')
  .argument('<branch>', 'Worktree branch')
  .argument('<tab-id>', 'AgentSession id from `tab list`')
  .option('--project <path>', 'Repository the worktree belongs to')
  .option('--json', 'Emit pure JSON')
  .action(async (branch: string, tabId: string, options: { project?: string; json?: boolean }) => {
    const { runTabSwitch } = await import('./commands/tab.js');
    process.exit(await runTabSwitch(branch, tabId, options));
  });

tabCommand
  .command('close')
  .description('Stop and close one fork tab after confirmation')
  .argument('<branch>', 'Worktree branch')
  .argument('<tab-id>', 'Fork AgentSession id from `tab list`')
  .option('--yes', 'Confirm stopping the fork without prompting')
  .option('--project <path>', 'Repository the worktree belongs to')
  .option('--json', 'Emit pure JSON')
  .action(
    async (
      branch: string,
      tabId: string,
      options: { yes?: boolean; project?: string; json?: boolean },
    ) => {
      const { runTabClose } = await import('./commands/tab.js');
      process.exit(await runTabClose(branch, tabId, options));
    },
  );

// ── worktree ────────────────────────────────────────────────────────────────
// Durable worktree curation independent of the monitor. The command bodies use
// the same session/worktree control layer as the HTTP routes.
const worktreeCommand = program
  .command('worktree')
  .description('List and curate managed worktrees without a running monitor');

worktreeCommand
  .command('refresh')
  .description('Reattach the active terminal, or resume its same conversation if dead')
  .argument('<branch>', 'Worktree branch')
  .option('--project <path>', 'Repository the worktree belongs to')
  .option('--json', 'Emit pure JSON')
  .action(async (branch: string, options: { project?: string; json?: boolean }) => {
    const { runWorktreeRefresh } = await import('./commands/worktree.js');
    process.exit(await runWorktreeRefresh(branch, options));
  });

worktreeCommand
  .command('ls')
  .alias('list')
  .description('List managed worktrees; closed worktrees remain visible')
  .option('--all', 'Include archived worktrees')
  .option('--archived', 'Show only archived worktrees')
  .option('--project <path>', 'Repository to inspect (default: the current one)')
  .option('--json', 'Emit the list as JSON')
  .action(
    async (options: { all?: boolean; archived?: boolean; project?: string; json?: boolean }) => {
      const { runWorktreeLs } = await import('./commands/worktree.js');
      process.exit(await runWorktreeLs(options));
    },
  );

worktreeCommand
  .command('archive')
  .description('Archive a worktree and close its live sessions')
  .argument('<branch>', 'Worktree branch')
  .option('--project <path>', 'Repository the worktree belongs to')
  .action(async (branch: string, options: { project?: string }) => {
    const { runWorktreeArchive } = await import('./commands/worktree.js');
    process.exit(await runWorktreeArchive(branch, options));
  });

worktreeCommand
  .command('unarchive')
  .description('Return an archived worktree to the active list')
  .argument('<branch>', 'Worktree branch')
  .option('--project <path>', 'Repository the worktree belongs to')
  .action(async (branch: string, options: { project?: string }) => {
    const { runWorktreeUnarchive } = await import('./commands/worktree.js');
    process.exit(await runWorktreeUnarchive(branch, options));
  });

worktreeCommand
  .command('label')
  .description('Set or clear a worktree caption')
  .argument('<branch>', 'Worktree branch')
  .argument('[label]', 'Caption (80 characters maximum)')
  .option('--clear', 'Clear the caption')
  .option('--project <path>', 'Repository the worktree belongs to')
  .action(
    async (
      branch: string,
      label: string | undefined,
      options: { clear?: boolean; project?: string },
    ) => {
      const { runWorktreeLabel } = await import('./commands/worktree.js');
      process.exit(await runWorktreeLabel(branch, label, options));
    },
  );

worktreeCommand
  .command('remove')
  .description('Remove a worktree and its branch after confirmation')
  .argument('<branch>', 'Worktree branch')
  .option('--yes', 'Confirm deletion without prompting')
  .option('--project <path>', 'Repository the worktree belongs to')
  .action(async (branch: string, options: { yes?: boolean; project?: string }) => {
    const { runWorktreeRemove } = await import('./commands/worktree.js');
    process.exit(await runWorktreeRemove(branch, options));
  });

worktreeCommand
  .command('merge')
  .description('Merge into the base branch and remove the worktree')
  .argument('<branch>', 'Worktree branch')
  .option('--yes', 'Confirm merge and cleanup without prompting')
  .option('--project <path>', 'Repository the worktree belongs to')
  .action(async (branch: string, options: { yes?: boolean; project?: string }) => {
    const { runWorktreeMerge } = await import('./commands/worktree.js');
    process.exit(await runWorktreeMerge(branch, options));
  });

worktreeCommand
  .command('prune')
  .description('Preview closed-worktree cleanup; --yes applies the shown plan')
  .option('--dry-run', 'Only show the cleanup plan (the default)')
  .option('--yes', 'Remove every worktree shown by the plan')
  .option('--project <path>', 'Repository whose closed worktrees to prune')
  .action(async (options: { dryRun?: boolean; yes?: boolean; project?: string }) => {
    const { runWorktreePrune } = await import('./commands/worktree.js');
    process.exit(await runWorktreePrune(options));
  });

// ── web ─────────────────────────────────────────────────────────────────────
const webCommand = program.command('web').description('Manage the web monitoring server');

webCommand
  .command('serve')
  .description('Alias of `issue-flow serve` (internal — spawned detached by --web)')
  .option('--port <n>', 'Web server port (default: 3737)', parseInteger)
  .option('--host <h>', 'Web server host (default: 0.0.0.0)')
  .option('--refresh <s>', 'Suggested UI polling interval in seconds', parseInteger)
  .option(
    '--project <path>',
    'Serve an extra repository for this process only (repeatable)',
    (value: string, previous: string[] = []) => [...previous, value],
  )
  .action(
    async (options: { port?: number; host?: string; refresh?: number; project?: string[] }) => {
      const { runWebServe } = await import('./commands/web.js');
      const code = await runWebServe(options);
      // On success this process stays alive for as long as the server is bound
      // (server.ts binds it with unref: false) — only a failure exits here.
      if (code !== 0) {
        process.exit(code);
      }
    },
  );

webCommand
  .command('stop')
  .description('Stop the running web monitor server')
  .action(async () => {
    const { runWebStop } = await import('./commands/web.js');
    const code = await runWebStop();
    process.exit(code);
  });

// ── policy ──────────────────────────────────────────────────────────────
withGlobalOptions(
  program
    .command('policy')
    .description('Inspect the policies discovered in this repository and their provenance')
    .option('--scope <dir>', 'Resolve the policy for a subdirectory (monorepo)')
    .option('--json', 'Emit the resolved policy as JSON'),
).action(async (options: { scope?: string; json?: boolean }) => {
  const { runPolicy } = await import('./commands/policy.js');
  const code = await runPolicy(options);
  process.exit(code);
});

const routingCommand = withGlobalOptions(
  program.command('routing').description('Inspect and configure adaptive harness/model routing'),
);
routingCommand
  .option('--json', 'Emit the resolved routing config as JSON')
  .action(async (_options: unknown, command: Command) => {
    const { runRoutingInspect } = await import('./commands/routing.js');
    process.exit(await runRoutingInspect(command.opts()));
  });
routingCommand
  .command('explain')
  .description('Explain the resolved routing target for every phase')
  .option('--json', 'Emit JSON')
  .action(async (_options: unknown, command: Command) => {
    const { runRoutingExplain } = await import('./commands/routing.js');
    process.exit(await runRoutingExplain(command.optsWithGlobals()));
  });
routingCommand
  .command('use')
  .description('Enable an embedded routing policy')
  .argument('<policy>', 'Policy name (recommended)')
  .option('--global', 'Write ~/.issue-flow/config.json (default)')
  .option('--project', 'Write .issue-flow.json instead')
  .option('--active', 'Apply the policy to future runs instead of leaving routing in shadow mode')
  .action(async (policy: string, _options: unknown, command: Command) => {
    const { runRoutingUse } = await import('./commands/routing.js');
    process.exit(await runRoutingUse(policy, command.optsWithGlobals()));
  });
routingCommand
  .command('report')
  .description('Shadow agreement between selected and actual harness')
  .option('--issue <n>', 'Issue number')
  .option('--json', 'Emit JSON')
  .action(async (_options: unknown, command: Command) => {
    const { runRoutingReport } = await import('./commands/routing.js');
    process.exit(await runRoutingReport(command.optsWithGlobals()));
  });

const conventionsCommand = withGlobalOptions(
  program
    .command('conventions')
    .description('Compute the repository Git convention (branch, commit, PR title)'),
);
conventionsCommand
  .command('branch')
  .description('Print the deterministic branch name for an issue')
  .option('--issue <n>', 'Issue number')
  .option('--title <text>', 'Issue title, when the issue cannot be resolved')
  .option('--json', 'Emit JSON')
  .action(async (options: { issue?: string; title?: string; json?: boolean }) => {
    const { runConventionsBranch } = await import('./commands/conventions.js');
    process.exit(await runConventionsBranch(options));
  });
conventionsCommand
  .command('commit')
  .description('Print a Conventional Commit message')
  .requiredOption('--type <type>', 'Change type (feat, fix, docs, …)')
  .option('--scope <scope>', 'Optional scope')
  .requiredOption('--subject <text>', 'Commit subject')
  .option('--issue <n>', 'Issue number for the Refs trailer')
  .option('--breaking <text>', 'Breaking change description')
  .option('--json', 'Emit JSON')
  .action(
    async (options: {
      type: string;
      scope?: string;
      subject: string;
      issue?: string;
      breaking?: string;
      json?: boolean;
    }) => {
      const { runConventionsCommit } = await import('./commands/conventions.js');
      process.exit(await runConventionsCommit(options));
    },
  );
conventionsCommand
  .command('pr-title')
  .description('Print the Conventional Commit Pull Request title')
  .option('--issue <n>', 'Issue number')
  .option('--title <text>', 'Issue title, when the issue cannot be resolved')
  .option('--json', 'Emit JSON')
  .action(async (options: { issue?: string; title?: string; json?: boolean }) => {
    const { runConventionsPrTitle } = await import('./commands/conventions.js');
    process.exit(await runConventionsPrTitle(options));
  });

// ── agent ───────────────────────────────────────────────────────────────
const agentCommand = withGlobalOptions(
  program
    .command('agent')
    .description('Inspect the resolved agent and model for each phase')
    .option('--json', 'Emit the resolved agent configuration as JSON'),
);
agentCommand.action(async (options: { json?: boolean }) => {
  const { runAgent } = await import('./commands/agent.js');
  const code = await runAgent(options);
  process.exit(code);
});

agentCommand
  .command('use')
  .description('Write an agent preference to config.json or .issue-flow.json')
  .addArgument(
    new Argument('<provider>', 'claude, codex, cursor, antigravity or opencode').choices(
      AGENT_PROVIDER_IDS,
    ),
  )
  .option('--model <model>', 'Model identifier for this preference')
  .option('--global', 'Write to ~/.issue-flow/config.json (default)')
  .option('--project', 'Write to .issue-flow.json in the repository')
  .addOption(
    new Option('--phase <phase>', 'Write only the override for this phase').choices(AGENT_PHASES),
  )
  .action(
    async (
      provider: string,
      options: { model?: string; global?: boolean; project?: boolean; phase?: string },
    ) => {
      const { runAgentUse } = await import('./commands/agent.js');
      const code = await runAgentUse(provider, options);
      process.exit(code);
    },
  );

// ── pr-review ───────────────────────────────────────────────────────────────
withGlobalOptions(
  program
    .command('pr-review')
    .description('Review a Pull Request as a whole with the configured agent')
    .argument('[pr]', 'Pull Request number (discovered from the session when omitted)')
    .option('--issue <n>', 'Issue the Pull Request belongs to')
    .option('--round <n>', 'Rewrite a specific review round instead of appending a new one')
    .option('--yes', 'Skip the confirmation of the discovered Pull Request')
    .option(
      '--fail-on <level>',
      'Verdict that fails the command: request-changes | suggestions | none',
    ),
).action(
  async (
    pr: string | undefined,
    options: { issue?: string; round?: string; yes?: boolean; failOn?: string },
  ) => {
    const { runPrReview } = await import('./commands/pr-review.js');
    const code = await runPrReview(pr, options);
    process.exit(code);
  },
);

// ── bench ───────────────────────────────────────────────────────────────────
withGlobalOptions(
  program
    .command('bench')
    .description('Measure the corpus: synthetic (CI) or real (paid, on demand)')
    .addOption(
      new Option('--mode <mode>', 'synthetic (default, free) or real (fixtures + harness)').choices(
        BENCH_MODES,
      ),
    )
    .addOption(
      new Option('--task <class>', 'Corpus class (repeatable): trivial, small, medium, analysis')
        .choices(TASK_CLASSES)
        .argParser(collectString)
        .default([]),
    )
    .option('--arm <name>', 'Experiment arm (repeatable). Default: baseline', collectString, [])
    .option('--repeats <n>', 'Repetitions per cell (default 5)', parseInteger)
    // Campaign-wide ceilings, distinct from the per-issue `--max-cost` /
    // `--max-duration` of `withGlobalOptions`: one campaign runs many issues,
    // and the two budgets are not the same number. The names differ because
    // the flags coexist on this command — and because the units differ too.
    .option(
      '--campaign-max-cost <usd>',
      'Campaign cost ceiling in USD (evaluateCeilings)',
      parseUsd,
    )
    .option(
      '--campaign-max-duration <ms>',
      'Campaign duration ceiling in milliseconds',
      parseInteger,
    )
    .option('--out <path>', 'Write the markdown report to this path')
    .option('--yes', 'Skip the paid-campaign confirmation')
    .option('--repo <path>', 'Investigation escape; does not produce a publishable row')
    .option('--json', 'Also emit the campaign JSON'),
).action(
  async (options: {
    mode?: (typeof BENCH_MODES)[number];
    task?: string[];
    arm?: string[];
    repeats?: number;
    campaignMaxCost?: number;
    campaignMaxDuration?: number;
    out?: string;
    yes?: boolean;
    repo?: string;
    json?: boolean;
  }) => {
    if (options.mode !== undefined && !(BENCH_MODES as readonly string[]).includes(options.mode)) {
      printError(`Unknown bench mode. Use one of: ${BENCH_MODES.join(', ')}.`);
      process.exit(1);
    }
    const { runBench } = await import('./commands/bench.js');
    process.exit(
      await runBench({
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.task === undefined || options.task.length === 0 ? {} : { task: options.task }),
        ...(options.arm === undefined || options.arm.length === 0 ? {} : { arm: options.arm }),
        ...(options.repeats === undefined ? {} : { repeats: options.repeats }),
        ...(options.campaignMaxCost === undefined ? {} : { maxCost: options.campaignMaxCost }),
        ...(options.campaignMaxDuration === undefined
          ? {}
          : { maxDuration: options.campaignMaxDuration }),
        ...(options.out === undefined ? {} : { out: options.out }),
        ...(options.yes === undefined ? {} : { yes: options.yes }),
        ...(options.repo === undefined ? {} : { repo: options.repo }),
        ...(options.json === undefined ? {} : { json: options.json }),
      }),
    );
  },
);

program.action(() => program.help());

attachCompletion(program);

function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) program.parse();
