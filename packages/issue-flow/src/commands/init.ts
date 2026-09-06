import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { execa } from 'execa';
import { hasExplicitAgentSelection } from '../agents/resolve.js';
import { AGENT_PHASES, type AgentProviderId } from '../agents/types.js';
import { getAgentCliOverrides, loadAgentConfig, loadRoutingConfig } from '../config.js';
import type { IssueSource } from '../issues/types.js';
import type { ScaffoldActionKind, ScaffoldPlan } from '../scaffold/plan.js';
import { printError, printInfo, printSuccess, printWarning } from '../ui/logger.js';
import { isInteractive, promptSelect } from '../ui/prompts.js';

/** Stable identifier of a check, used to decide whether it blocks. */
type CheckKey = 'claude' | 'codex' | 'gh' | 'git';

interface CheckResult {
  key: CheckKey;
  name: string;
  passed: boolean;
  detail: string;
  hint?: string;
}

async function checkClaude(): Promise<CheckResult> {
  try {
    const proc = await execa('claude', ['--version'], { reject: false, timeout: 10_000 });
    if (proc.exitCode === 0) {
      const version = proc.stdout?.toString().trim() ?? 'unknown';
      return { key: 'claude', name: 'claude CLI', passed: true, detail: version };
    }
    return {
      key: 'claude',
      name: 'claude CLI',
      passed: false,
      detail: 'claude command failed',
      hint: 'Install Claude Code: https://docs.anthropic.com/en/docs/claude-code',
    };
  } catch {
    return {
      key: 'claude',
      name: 'claude CLI',
      passed: false,
      detail: 'claude not found',
      hint: 'Install Claude Code: https://docs.anthropic.com/en/docs/claude-code',
    };
  }
}

async function checkGh(): Promise<CheckResult> {
  try {
    const proc = await execa('gh', ['--version'], { reject: false, timeout: 10_000 });
    if (proc.exitCode !== 0) {
      return {
        key: 'gh',
        name: 'gh CLI',
        passed: false,
        detail: 'gh command failed',
        hint: 'Install GitHub CLI: https://cli.github.com/',
      };
    }
    const version = proc.stdout?.toString().split('\n')[0]?.trim() ?? 'unknown';

    // Check auth status
    const auth = await execa('gh', ['auth', 'status'], { reject: false, timeout: 10_000 });
    if (auth.exitCode !== 0) {
      return {
        key: 'gh',
        name: 'gh CLI',
        passed: false,
        detail: `${version} (not authenticated)`,
        hint: 'Run: gh auth login',
      };
    }
    return { key: 'gh', name: 'gh CLI', passed: true, detail: `${version} (authenticated)` };
  } catch {
    return {
      key: 'gh',
      name: 'gh CLI',
      passed: false,
      detail: 'gh not found',
      hint: 'Install GitHub CLI: https://cli.github.com/',
    };
  }
}

async function checkCodex(): Promise<CheckResult> {
  try {
    const proc = await execa('codex', ['--version'], { reject: false, timeout: 10_000 });
    if (proc.exitCode !== 0) {
      return {
        key: 'codex',
        name: 'codex CLI',
        passed: false,
        detail: 'codex command failed',
        hint: 'Install Codex CLI: https://developers.openai.com/codex/noninteractive',
      };
    }
    const version = proc.stdout?.toString().trim() ?? 'unknown';
    const auth = await execa('codex', ['login', 'status'], { reject: false, timeout: 10_000 });
    if (auth.exitCode !== 0) {
      return {
        key: 'codex',
        name: 'codex CLI',
        passed: false,
        detail: `${version} (not authenticated)`,
        hint: 'Run: codex login --with-api-key  (or set CODEX_API_KEY)',
      };
    }
    return { key: 'codex', name: 'codex CLI', passed: true, detail: `${version} (authenticated)` };
  } catch {
    return {
      key: 'codex',
      name: 'codex CLI',
      passed: false,
      detail: 'codex not found',
      hint: 'Install Codex CLI: https://developers.openai.com/codex/noninteractive',
    };
  }
}

async function checkGit(): Promise<CheckResult> {
  try {
    const proc = await execa('git', ['--version'], { reject: false, timeout: 10_000 });
    if (proc.exitCode !== 0) {
      return {
        key: 'git',
        name: 'git',
        passed: false,
        detail: 'git command failed',
        hint: 'Install git: https://git-scm.com/',
      };
    }
    const version = proc.stdout?.toString().trim() ?? 'unknown';

    // Check if current directory is a git repo
    const repo = await execa('git', ['rev-parse', '--is-inside-work-tree'], {
      reject: false,
      timeout: 5_000,
    });
    if (repo.exitCode !== 0) {
      return {
        key: 'git',
        name: 'git',
        passed: false,
        detail: `${version} (not a git repository)`,
        hint: 'Run this command inside a git repository',
      };
    }
    return { key: 'git', name: 'git', passed: true, detail: `${version} (inside repo)` };
  } catch {
    return {
      key: 'git',
      name: 'git',
      passed: false,
      detail: 'git not found',
      hint: 'Install git: https://git-scm.com/',
    };
  }
}

export interface InitOptions {
  /** Write the missing files instead of only reporting them. */
  apply?: boolean;
  /** Emit the plan as JSON — the bridge the initialization skill reads. */
  json?: boolean;
  /** Subdirectory the conventions apply to, in a monorepo. */
  scope?: string;
  /** Skip the convention report entirely and only check prerequisites. */
  checkOnly?: boolean;
  /** Skip the first-run agent choice. */
  noAgentPrompt?: boolean;
  /**
   * One-line preflight for `issue-flow run` in clean mode. `issue-flow init`
   * itself never passes this — its product is the full report.
   */
  compact?: boolean;
  /** Injectable terminal streams used by the interactive first-run choice. */
  stdin?: Readable;
  stdout?: Writable;
  /** Abort the first-agent prompt without persisting a fallback. */
  signal?: AbortSignal;
  /** Explicit interactivity override for embedders and tests. */
  interactive?: boolean;
}

const ACTION_ICON: Record<ScaffoldActionKind, string> = {
  create: '+',
  keep: '=',
  review: '!',
};

/**
 * One-line preflight for the clean terminal. The full report stays on
 * `issue-flow init` and on `--verbose`.
 */
export function summarizePreflight(
  results: ReadonlyArray<{ passed: boolean }>,
  plan: { actions: ReadonlyArray<{ kind: string }> },
): string {
  const kept = plan.actions.filter((action) => action.kind === 'keep').length;
  const creates = plan.actions.filter((action) => action.kind === 'create').length;
  const env = results.every((result) => result.passed) ? 'environment ok' : 'environment failed';
  const createBit = creates === 0 ? 'nothing to create' : `${creates} to create`;
  return `Preflight: ${env} · ${kept} conventions kept · ${createBit}`;
}

/**
 * Render the plan for a human.
 *
 * `keep` lines are printed, not hidden: the most valuable thing this report
 * says is usually *what it is not going to touch*, and a list of only the
 * missing files would read as if the repository had nothing.
 */
function renderPlan(plan: ScaffoldPlan, apply: boolean): void {
  const creates = plan.actions.filter((a) => a.kind === 'create');
  const reviews = plan.actions.filter((a) => a.kind === 'review');

  console.log('');
  printInfo(`Repository conventions (${plan.root})\n`);

  for (const item of plan.actions) {
    console.log(`  ${ACTION_ICON[item.kind]} ${item.path}`);
    console.log(`      ${item.reason}`);
  }

  if (plan.notes.length > 0) {
    console.log('');
    for (const note of plan.notes) {
      printWarning(note);
    }
  }

  console.log('');
  if (creates.length === 0 && reviews.length === 0) {
    printSuccess('This repository already declares everything Issue Flow would add.');
    return;
  }
  if (creates.length === 0) {
    printSuccess('Nothing to create.');
    return;
  }
  if (!apply) {
    printInfo(`${creates.length} file(s) would be created. Re-run with --apply to write them.`);
  }
}

/**
 * Verify the prerequisites of the pipeline and report the repository's
 * conventions.
 *
 * `source` is the Issue origin the run is headed for. `gh` only blocks when
 * that origin is GitHub: no other origin shells out to it, so a missing or
 * unauthenticated gh is reported as a warning instead of failing the
 * environment. `claude` and `git` stay blocking for every origin, and the
 * default ('github') keeps the previous behaviour byte for byte.
 *
 * The convention report is additive: the prerequisite checks run first and still
 * decide the exit code, so an existing script calling `issue-flow init` sees the
 * same pass/fail it always did. Nothing is written without `--apply`.
 */
export async function runInit(
  source: IssueSource = 'github',
  options: InitOptions = {},
): Promise<number> {
  const json = options.json === true;
  const compact = options.compact === true;

  if (!json && !compact) {
    printExperimentalNotice();
    printInfo('Checking prerequisites...\n');
  }

  const agent = await loadAgentConfig();
  const usesCodex =
    agent.provider === 'codex' ||
    AGENT_PHASES.some((phase) => agent.phases[phase]?.provider === 'codex');

  const checks = [checkClaude(), checkGh(), checkGit()];
  if (usesCodex) checks.push(checkCodex());
  const results = await Promise.all(checks);
  const isBlocking = (r: CheckResult): boolean => {
    if (r.key === 'gh') return source === 'github';
    if (r.key === 'codex') return usesCodex;
    if (r.key === 'claude') return agent.provider === 'claude' || !usesCodex;
    return true;
  };

  if (!json && (!compact || !results.every((r) => r.passed || !isBlocking(r)))) {
    for (const r of results) {
      if (r.passed) {
        if (!compact) printSuccess(`${r.name}: ${r.detail}`);
      } else if (isBlocking(r)) {
        printError(`${r.name}: ${r.detail}`);
        if (r.hint) {
          console.log(`    ${r.hint}`);
        }
      } else if (!compact) {
        printWarning(`${r.name}: ${r.detail} (not required for ${source} issues)`);
      }
    }
  }

  const allPassed = results.filter(isBlocking).every((r) => r.passed);

  if (!json && !compact) {
    console.log('');
    if (allPassed) {
      printSuccess('All prerequisites met. Ready to run the pipeline.');
    } else {
      printError('Some prerequisites are missing. Please fix the issues above.');
    }
  } else if (!json && compact && !allPassed) {
    printError('Prerequisites not met. Fix the issues above and try again.');
  }

  if (usesCodex) {
    await warnEscalatingCodexConfig();
  }

  if (options.checkOnly === true) {
    return allPassed ? 0 : 1;
  }

  // The conventions half. It never changes the exit code: a repository missing
  // a template is not a broken environment, and failing here would break every
  // script that treats `init` as a prerequisite gate.
  let plan: ScaffoldPlan;
  try {
    const { planRepositoryScaffold } = await import('../scaffold/apply.js');
    plan = await planRepositoryScaffold({ scope: options.scope ?? null });
  } catch (err) {
    if (json) {
      console.log(
        JSON.stringify(
          { schemaVersion: 1, error: err instanceof Error ? err.message : String(err) },
          null,
          2,
        ),
      );
      return allPassed ? 0 : 1;
    }
    printWarning(
      `Could not inspect the repository conventions: ${err instanceof Error ? err.message : String(err)}`,
    );
    return allPassed ? 0 : 1;
  }

  let applied: { written: string[]; skipped: string[] } | null = null;
  if (options.apply === true) {
    const { applyScaffoldPlan } = await import('../scaffold/apply.js');
    applied = await applyScaffoldPlan(plan);
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          prerequisites: results.map((r) => ({
            key: r.key,
            passed: r.passed,
            detail: r.detail,
            blocking: isBlocking(r),
          })),
          root: plan.root,
          // Content is omitted: a skill decides from the actions, and the bodies
          // would make the payload unreadable for no gain.
          actions: plan.actions.map(({ path, kind, tier, reason }) => ({
            path,
            kind,
            tier,
            reason,
          })),
          notes: plan.notes,
          applied,
        },
        null,
        2,
      ),
    );
    return allPassed ? 0 : 1;
  }

  if (compact) {
    printInfo(summarizePreflight(results, plan));
  } else {
    renderPlan(plan, options.apply === true);
  }

  if (applied !== null) {
    console.log('');
    for (const path of applied.written) {
      printSuccess(`Created ${path}`);
    }
    for (const path of applied.skipped) {
      printWarning(`Skipped ${path}: it already exists.`);
    }
    if (applied.written.length === 0) {
      printInfo('Nothing was written — the repository already had everything.');
    }
  }

  await maybeOfferAgentChoice(options, agent);

  if (!json) {
    try {
      const { resolveContract } = await import('../verify/contract.js');
      const { getProjectRoot } = await import('../utils/git.js');
      const { loadVerifyConfig } = await import('../config.js');
      const cwd = await getProjectRoot();
      const verify = await loadVerifyConfig({ projectRoot: cwd });
      const contract = await resolveContract({ cwd, declared: verify.contract });
      if (contract.source === 'empty') {
        printWarning(
          'No acceptance contract declared or discovered — runs will finish unverified.',
        );
      }
    } catch {
      // Observational: init still reports prerequisites if discovery fails.
    }
  }

  return allPassed ? 0 : 1;
}

/**
 * `init` is the first command a new user runs, so it is where the maturity of
 * the project is stated. The full notice lives in `docs/project-status.md`; this
 * is the short form, printed only on the human path — `--json` is consumed by
 * tooling and `--compact` is the preflight inside `run`.
 */
function printExperimentalNotice(): void {
  printWarning(
    'Issue Flow is experimental and under active development, built mostly with AI coding agents and not audited.',
  );
  for (const line of [
    'Expect bugs, incomplete implementations, regressions and possibly undiscovered security flaws.',
    'Not recommended for real projects, production environments, critical systems or repositories',
    'with sensitive information. Keep backups, use a dedicated branch and review every change it makes.',
    'Token consumption is not optimized yet: a run may use significantly more tokens than necessary.',
    'https://github.com/fabioassuncao/issue-flow/blob/main/docs/project-status.md',
  ]) {
    console.log(`    ${line}`);
  }
  console.log('');
}

const ESCALATING_CODEX_KEYS = ['approvals_reviewer', 'sandbox_mode', 'sandbox_workspace_write'];

async function warnEscalatingCodexConfig(): Promise<void> {
  const configPath = join(homedir(), '.codex', 'config.toml');
  try {
    const raw = await readFile(configPath, 'utf-8');
    const hits = ESCALATING_CODEX_KEYS.filter((key) => raw.includes(key));
    if (hits.length === 0) return;
    printWarning(
      `$CODEX_HOME/config.toml contains ${hits.join(', ')}, which can escalate --sandbox. Set agent.codex.ignoreUserConfig: true for reproducible runs (recommended in CI). Claude's equivalent is --setting-sources project (agent.claude.ignoreUserConfig).`,
    );
  } catch {
    // Absence is the common case.
  }
}

/**
 * An active router owns the per-phase harness choice, so asking for one agent
 * at startup would immediately contradict the resolved configuration.
 */
export function shouldOfferAgentPrompt(
  hasExplicitSelection: boolean,
  routingMode: string,
  options: { json?: boolean; noAgentPrompt?: boolean; interactive?: boolean } = {},
): boolean {
  return (
    options.json !== true &&
    options.noAgentPrompt !== true &&
    options.interactive !== false &&
    !hasExplicitSelection &&
    routingMode !== 'active'
  );
}

async function maybeOfferAgentChoice(
  options: InitOptions,
  agent: Awaited<ReturnType<typeof loadAgentConfig>>,
): Promise<void> {
  if (options.json === true || options.noAgentPrompt === true) return;
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const interactive = options.interactive ?? isInteractive({ stdin, stdout, ci: process.env.CI });
  if (!interactive) return;
  const routing = await loadRoutingConfig();
  if (
    !shouldOfferAgentPrompt(
      hasExplicitAgentSelection(agent, getAgentCliOverrides()),
      routing.mode,
      {
        json: options.json,
        noAgentPrompt: options.noAgentPrompt,
        interactive,
      },
    )
  ) {
    return;
  }

  await promptInitialAgentChoice({ ...options, stdin, stdout });
}

interface InitialAgentChoiceOptions {
  apply?: boolean;
  stdin?: Readable;
  stdout?: Writable;
  signal?: AbortSignal;
  persist?: (provider: AgentProviderId) => Promise<string>;
  info?: (message: string) => void;
  success?: (message: string) => void;
}

/** Run only the first-agent select after the caller has applied prompt policy. */
export async function promptInitialAgentChoice(
  options: InitialAgentChoiceOptions = {},
): Promise<'claude' | 'codex' | null> {
  const result = await promptSelect<'claude' | 'codex'>({
    message: 'Which agent should Issue Flow use?',
    options: [
      { value: 'claude', label: 'Claude' },
      { value: 'codex', label: 'Codex' },
    ],
    initialValue: 'claude',
    stdin: options.stdin,
    stdout: options.stdout,
    signal: options.signal,
  });
  if (result.status === 'cancelled') return null;

  const chosen = result.value;

  if (options.apply === true) {
    const persist = options.persist ?? (await import('./agent.js')).persistFirstAgentChoice;
    const path = await persist(chosen);
    (options.success ?? printSuccess)(`Saved agent '${chosen}' to ${path}`);
    return chosen;
  }
  (options.info ?? printInfo)(
    `Using ${chosen} for this check. Persist with: issue-flow agent use ${chosen} --global`,
  );
  return chosen;
}
