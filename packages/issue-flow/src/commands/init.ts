import { execa } from 'execa';
import type { IssueSource } from '../issues/types.js';
import type { ScaffoldActionKind, ScaffoldPlan } from '../scaffold/plan.js';
import { printError, printInfo, printSuccess, printWarning } from '../ui/logger.js';

/** Stable identifier of a check, used to decide whether it blocks. */
type CheckKey = 'claude' | 'gh' | 'git';

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
}

const ACTION_ICON: Record<ScaffoldActionKind, string> = {
  create: '+',
  keep: '=',
  review: '!',
};

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

  if (!json) {
    printInfo('Checking prerequisites...\n');
  }

  const results = await Promise.all([checkClaude(), checkGh(), checkGit()]);
  const isBlocking = (r: CheckResult): boolean => r.key !== 'gh' || source === 'github';

  if (!json) {
    for (const r of results) {
      if (r.passed) {
        printSuccess(`${r.name}: ${r.detail}`);
      } else if (isBlocking(r)) {
        printError(`${r.name}: ${r.detail}`);
        if (r.hint) {
          console.log(`    ${r.hint}`);
        }
      } else {
        printWarning(`${r.name}: ${r.detail} (not required for ${source} issues)`);
      }
    }
  }

  const allPassed = results.filter(isBlocking).every((r) => r.passed);

  if (!json) {
    console.log('');
    if (allPassed) {
      printSuccess('All prerequisites met. Ready to run the pipeline.');
    } else {
      printError('Some prerequisites are missing. Please fix the issues above.');
    }
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

  renderPlan(plan, options.apply === true);

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

  return allPassed ? 0 : 1;
}
