import { createRequire } from 'node:module';
import { Command, InvalidArgumentError } from 'commander';
import { parseAgentPhaseFlag } from './agents/resolve.js';
import { type AgentCliOverrides, isAgentProviderId } from './agents/types.js';
import {
  CliFlagError,
  resolveQueueScopeFlags,
  resolveRunPhaseFlags,
  resolveUserStoryNumberingFlags,
} from './cli-options.js';
import {
  setAgentCliOverrides,
  setIssuesCliOverrides,
  setResilienceCliOverrides,
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
import type { WebConfig } from './schemas.js';
import { printError } from './ui/logger.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

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

/** Parse `--on-issue-failure <mode>`, rejecting anything but the three modes. */
function parseQueueFailureMode(value: string): 'stop' | 'skip' | 'block' {
  if (value === 'stop' || value === 'skip' || value === 'block') return value;
  throw new InvalidArgumentError('Must be one of: stop, skip, block.');
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
      .option('--agent <provider>', 'Run every phase on this agent (claude|codex)')
      .option('--agent-model <model>', 'Override the model for every phase')
      .option(
        '--agent-phase <phase>=<provider>[:<model>]',
        'Override one phase (repeatable)',
        collectAgentPhase,
        {} as AgentCliOverrides['phases'],
      )
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
      throw new InvalidArgumentError('Must be one of: claude, codex.');
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

/**
 * Extract the web-related CLI flags from a command's options, keeping only
 * the ones the user actually set.
 */
function resolveWebOverrides(opts: Record<string, unknown>): Partial<WebConfig> {
  const overrides: Partial<WebConfig> = {};
  if (opts.web === true || opts.serve === true) {
    overrides.enabled = true;
  }
  if (opts.port !== undefined) {
    overrides.port = opts.port as number;
  }
  if (opts.host !== undefined) {
    overrides.host = opts.host as string;
  }
  if (opts.refresh !== undefined) {
    overrides.refreshSeconds = opts.refresh as number;
  }
  if (opts.webLogLimit !== undefined) {
    overrides.logLimit = opts.webLogLimit as number;
  }
  if (opts.webNoLogs === true) {
    overrides.includeLogs = false;
  }
  return overrides;
}

const program = new Command();

program
  .name('issue-flow')
  .description(
    'Unified CLI for orchestrating the full issue-flow pipeline via Claude Code or Codex CLI.',
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
    setAgentCliOverrides(resolveAgentOverrides(opts));
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
    .description('Draft an issue via Claude Code Headless and create it')
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
            .argument('<issues...>', 'Issue number(s): 42, "42,43" or 42 43')
            .option('--mode <mode>', 'Execution mode: auto | manual', 'auto')
            .option('--from <phase>', 'Resume from a specific phase')
            .option(
              '--no-branch',
              'Run pipeline on current branch without creating a new branch or PR',
            )
            .option('--pr-review', 'Review the created Pull Request after the pr phase')
            .option('-y, --yes', 'Run the whole discovered hierarchy without confirmation')
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
            .option(
              '--on-issue-failure <mode>',
              'In a queue, on a failing issue: stop | skip | block',
              parseQueueFailureMode,
            ),
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
      yes?: boolean;
      only?: boolean;
      continue?: boolean;
      startUs?: number;
      retryLimit?: number;
      retryForever?: boolean;
      onIssueFailure?: 'stop' | 'skip' | 'block';
    },
  ) => {
    let phases: ReturnType<typeof resolveRunPhaseFlags>;
    let scope: ReturnType<typeof resolveQueueScopeFlags>;
    let numbering: ReturnType<typeof resolveUserStoryNumberingFlags>;
    try {
      phases = resolveRunPhaseFlags(options);
      scope = resolveQueueScopeFlags(options);
      numbering = resolveUserStoryNumberingFlags(options);
    } catch (error) {
      if (error instanceof CliFlagError) {
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
        yes: scope.yes,
        only: scope.only,
        continueNumbering: numbering.continueFlag,
        startUs: numbering.startUs,
        retryLimit: options.retryLimit,
        retryForever: options.retryForever,
        onIssueFailure: options.onIssueFailure,
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
      .option('--mode <mode>', 'Execution mode: auto | manual', 'auto'),
  ),
).action(async (issue: string | undefined, options: { all?: boolean; mode?: string }) => {
  const { runResume } = await import('./commands/resume.js');
  const code = await runResume(issue, {
    ...(options.all === undefined ? {} : { all: options.all }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  });
  process.exit(code);
});

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
  program.command('runs').description('History of the runs of this project, with how each ended'),
).action(async () => {
  const { runRuns } = await import('./commands/operations.js');
  process.exit(await runRuns());
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
      .description('Analyze an issue via Claude Code Headless')
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
      .description('Generate a PRD from an analyzed issue via Claude Code Headless')
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
        .description('Convert a PRD to a tasks.json task plan via Claude Code Headless')
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
      .description('Validate an issue resolution via Claude Code Headless')
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
      .description('Create a pull request via Claude Code Headless')
      .argument('<issue>', 'Issue number'),
  ),
).action(async (issue: string) => {
  const { runPr } = await import('./commands/pr.js');
  const code = await runPr(issue);
  process.exit(code);
});

// ── web ─────────────────────────────────────────────────────────────────────
const webCommand = program.command('web').description('Manage the web monitoring server');

webCommand
  .command('serve')
  .description(
    'Run the web monitor server in the foreground (internal — spawned detached by --web)',
  )
  .option('--port <n>', 'Web server port (default: 3737)', parseInteger)
  .option('--host <h>', 'Web server host (default: 0.0.0.0)')
  .option('--refresh <s>', 'Suggested UI polling interval in seconds', parseInteger)
  .action(async (options: { port?: number; host?: string; refresh?: number }) => {
    const { runWebServe } = await import('./commands/web.js');
    const code = await runWebServe(options);
    // On success this process stays alive for as long as the server is bound
    // (server.ts binds it with unref: false) — only a failure exits here.
    if (code !== 0) {
      process.exit(code);
    }
  });

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
  .argument('<provider>', 'claude or codex')
  .option('--model <model>', 'Model identifier for this preference')
  .option('--global', 'Write to ~/.issue-flow/config.json (default)')
  .option('--project', 'Write to .issue-flow.json in the repository')
  .option('--phase <phase>', 'Write only the override for this phase')
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
    .description('Review a Pull Request as a whole via Claude Code Headless')
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

program.parse();
