import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_PROVIDER_IDS } from './agents/types.js';
import { BENCH_MODES, TASK_CLASSES } from './benchmark/corpus.js';
import { QUEUE_FAILURE_MODES, RUNNABLE_PHASES_WITH_PR_REVIEW } from './commands/run/types.js';
import { VERIFICATION_LEVELS } from './verify/types.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const requireAllShells = process.env.ISSUE_FLOW_REQUIRE_ALL_COMPLETION_SHELLS === '1';
const shellParsers = {
  zsh: { executable: 'zsh', args: ['-n'] },
  bash: { executable: 'bash', args: ['-n'] },
  // Fish needs the explicit stdin operand; without it, recent builds can try
  // to validate the current directory instead of the piped completion script.
  fish: { executable: 'fish', args: ['-n', '-'] },
  powershell: {
    executable: 'pwsh',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$tokens = $null; $errors = $null; ' +
        '[System.Management.Automation.Language.Parser]::ParseInput(' +
        '[Console]::In.ReadToEnd(), [ref]$tokens, [ref]$errors) | Out-Null; ' +
        'if ($errors.Count -gt 0) { ' +
        '$errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }',
    ],
  },
} as const;

let buildDirectory: string;
let cliPath: string;
let sandbox: string;
const generatedScripts = new Map<string, string>();

function executableAvailable(executable: string): boolean {
  return spawnSync(executable, ['--version'], { stdio: 'ignore' }).error === undefined;
}

function runCli(args: string[]): string {
  expect(readdirSync(sandbox)).toEqual([]);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: '1',
    HOME: join(sandbox, 'home'),
    ISSUE_FLOW_HOME: join(sandbox, 'store'),
    PATH: '',
  };
  for (const key of [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CODEX_API_KEY',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'OPENAI_API_KEY',
  ]) {
    delete env[key];
  }

  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: sandbox,
    env,
    encoding: 'utf8',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`CLI exited ${result.status}: ${result.stderr}`);
  }

  expect(result.stderr).toBe('');
  expect(readdirSync(sandbox)).toEqual([]);
  expect(existsSync(join(sandbox, 'store'))).toBe(false);
  return result.stdout;
}

function protocol(...args: string[]): string[] {
  return runCli(['complete', '--', ...args])
    .trimEnd()
    .split('\n');
}

function generatedScript(shell: string): string {
  const cached = generatedScripts.get(shell);
  if (cached !== undefined) return cached;
  const script = runCli(['complete', shell]);
  generatedScripts.set(shell, script);
  return script;
}

beforeAll(() => {
  buildDirectory = mkdtempSync(join(packageRoot, 'node_modules/.completion-build-'));
  sandbox = mkdtempSync(join(tmpdir(), 'issue-flow-completion-run-'));

  const tsup = join(
    packageRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsup.cmd' : 'tsup',
  );
  const build = spawnSync(
    tsup,
    ['src/cli.ts', '--out-dir', buildDirectory, '--clean', '--silent'],
    { cwd: packageRoot, encoding: 'utf8' },
  );
  if (build.error !== undefined) throw build.error;
  if (build.status !== 0) throw new Error(`Test CLI build failed: ${build.stderr}`);

  cliPath = join(buildDirectory, 'cli.js');
  if (!existsSync(cliPath)) throw new Error(`Test CLI build did not create ${cliPath}`);
});

afterAll(() => {
  rmSync(buildDirectory, { recursive: true, force: true });
  rmSync(sandbox, { recursive: true, force: true });
});

describe('Commander completion integration', () => {
  it('launches the actual CLI tree without Git, tools, authentication, or initialized storage', () => {
    const output = protocol('');

    expect(output).toContain(
      'run\tExecute the full pipeline: prd → plan → execute → review → pr (→ pr-review, optional)',
    );
    expect(output).toContain('runs\tHistory of the runs of this project, with how each ended');
    expect(output).toContain(
      'logs\tRead the execution journal (events.jsonl), filtered and readable',
    );
    expect(output.at(-1)).toBe(':4');
  });

  it('derives root and nested suggestions with descriptions from the registered tree', () => {
    expect(protocol('db', '')).toContain('export\tExport structured SQLite state as readable JSON');
    expect(protocol('web', '')).toContain(
      'serve\tAlias of `issue-flow serve` (internal — spawned detached by --web)',
    );
    // The multi-project surface completes too, and `project ls` is the one
    // subcommand that has to work with no server running.
    expect(protocol('project', '')).toContain('ls\tList known projects, curated and discovered');
    expect(protocol('routing', '')).toContain('use\tEnable an embedded routing policy');
    expect(protocol('run', '--a')).toContain(
      '--agent\tRun every phase on this agent (claude|codex|cursor|antigravity|opencode)',
    );
  });

  it('omits hidden commands and options', () => {
    expect(protocol('').join('\n')).not.toContain('Generate completion suggestions');
    expect(protocol('run', '--')).not.toContain(
      '--detached-child\tInternal: this process owns one queue item',
    );
  });

  it.each([
    ['run', '--agent', AGENT_PROVIDER_IDS],
    ['run', '--from', RUNNABLE_PHASES_WITH_PR_REVIEW],
    ['run', '--verify-level', VERIFICATION_LEVELS],
    ['run', '--on-issue-failure', QUEUE_FAILURE_MODES],
    ['bench', '--mode', BENCH_MODES],
    ['bench', '--task', TASK_CLASSES],
  ] as const)('completes canonical values for %s %s', (command, option, values) => {
    const output = protocol(command, option, '');
    for (const value of values) {
      expect(output).toContain(`${value}\t`);
    }
  });

  it('completes positional values from the registered Commander choices', () => {
    const output = protocol('agent', 'use', '');
    for (const provider of AGENT_PROVIDER_IDS) {
      expect(output).toContain(`${provider}\t`);
    }
  });

  const unavailableShells = Object.entries(shellParsers)
    .filter(([, parser]) => !executableAvailable(parser.executable))
    .map(([shell]) => shell);

  it.runIf(requireAllShells)('has every shell parser required by the CI validation job', () => {
    expect(unavailableShells).toEqual([]);
  });

  it.each(
    Object.keys(shellParsers),
  )('emits a non-empty %s script without creating files or storage', (shell) => {
    expect(generatedScript(shell).length).toBeGreaterThan(500);
  });

  for (const [shell, parser] of Object.entries(shellParsers)) {
    it.skipIf(!executableAvailable(parser.executable))(
      `emits a ${shell} script accepted by the native parser`,
      () => {
        const script = generatedScript(shell);

        const validation = spawnSync(parser.executable, parser.args, {
          input: script,
          encoding: 'utf8',
        });
        if (validation.error !== undefined) throw validation.error;
        if (validation.status !== 0) {
          throw new Error(`${shell} rejected its generated script: ${validation.stderr}`);
        }
      },
    );
  }
});
