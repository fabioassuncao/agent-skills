import { createRequire } from 'node:module';
import { Command, InvalidArgumentError } from 'commander';
import { setIssuesCliOverrides, setWebCliOverrides } from './config.js';
import { setGlobalTimeout, setVerbose } from './core/verbose.js';
import { IssueFlagError, resolveIssuesOverrides } from './issues/cli-flags.js';
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

/**
 * Add shared options (--verbose) to a subcommand.
 */
function withGlobalOptions(cmd: Command): Command {
  return cmd
    .option('-v, --verbose', 'Show Claude progress output in real time')
    .option(
      '-t, --timeout <seconds>',
      'Override headless timeout in seconds (0 = no limit)',
      parseInteger,
    );
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
    'Unified CLI for orchestrating the full issue-flow pipeline via Claude Code Headless.',
  )
  .version(version);

program.hook('preAction', (_thisCommand, actionCommand) => {
  const opts = actionCommand.opts();
  if (opts.verbose) {
    setVerbose(true);
  }
  if (opts.timeout !== undefined) {
    setGlobalTimeout(opts.timeout * 1000);
  }
  setWebCliOverrides(resolveWebOverrides(opts));
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
    program.command('init').description('Verify that all prerequisites (claude, gh, git) are met'),
  ),
).action(async () => {
  const { loadIssuesConfig } = await import('./config.js');
  const { runInit } = await import('./commands/init.js');
  const { preferredProvider } = await loadIssuesConfig();
  const code = await runInit(preferredProvider);
  process.exit(code);
});

// ── generate ────────────────────────────────────────────────────────────────
withGlobalOptions(
  program
    .command('generate')
    .description('Create a GitHub issue via Claude Code Headless')
    .requiredOption('--prompt <text>', 'Issue description text'),
).action(async (options: { prompt: string }) => {
  const { runGenerate } = await import('./commands/generate.js');
  const code = await runGenerate(options.prompt);
  process.exit(code);
});

// ── run ─────────────────────────────────────────────────────────────────────
withWebOptions(
  withIssueOptions(
    withGlobalOptions(
      program
        .command('run')
        .description('Execute the full pipeline: prd → plan → execute → review → pr')
        .argument('<issue>', 'Issue number')
        .option('--mode <mode>', 'Execution mode: auto | manual', 'auto')
        .option('--from <phase>', 'Resume from a specific phase')
        .option(
          '--no-branch',
          'Run pipeline on current branch without creating a new branch or PR',
        ),
    ),
  ),
).action(async (issue: string, options: { mode: string; from?: string; noBranch?: boolean }) => {
  const { runPipeline } = await import('./commands/run.js');
  const code = await runPipeline(issue, options.mode, options.from, options.noBranch);
  process.exit(code);
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
withIssueOptions(
  withGlobalOptions(
    program
      .command('plan')
      .description('Convert a PRD to a tasks.json task plan via Claude Code Headless')
      .argument('<issue>', 'Issue number'),
  ),
).action(async (issue: string) => {
  const { runPlan } = await import('./commands/plan.js');
  const code = await runPlan(issue);
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

program.parse();
