import { execa } from 'execa';
import type { IssueSource } from '../issues/types.js';
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

/**
 * Verify the prerequisites of the pipeline.
 *
 * `source` is the resolved Issue origin. With a local origin nothing in the
 * pipeline shells out to `gh`, so a missing or unauthenticated gh is reported
 * as a warning instead of failing the environment. `claude` and `git` stay
 * blocking for every origin, and the default ('github') keeps the previous
 * behaviour byte for byte.
 */
export async function runInit(source: IssueSource = 'github'): Promise<number> {
  printInfo('Checking prerequisites...\n');

  const results = await Promise.all([checkClaude(), checkGh(), checkGit()]);
  const isBlocking = (r: CheckResult): boolean => r.key !== 'gh' || source !== 'local';

  for (const r of results) {
    if (r.passed) {
      printSuccess(`${r.name}: ${r.detail}`);
    } else if (isBlocking(r)) {
      printError(`${r.name}: ${r.detail}`);
      if (r.hint) {
        console.log(`    ${r.hint}`);
      }
    } else {
      printWarning(`${r.name}: ${r.detail} (not required for local issues)`);
    }
  }

  const allPassed = results.filter(isBlocking).every((r) => r.passed);
  console.log('');
  if (allPassed) {
    printSuccess('All prerequisites met. Ready to run the pipeline.');
  } else {
    printError('Some prerequisites are missing. Please fix the issues above.');
  }

  return allPassed ? 0 : 1;
}
