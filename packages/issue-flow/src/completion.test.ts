import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Argument, Command, Option } from 'commander';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AGENT_PROVIDER_IDS } from './agents/types.js';
import { BENCH_MODES, TASK_CLASSES } from './benchmark/corpus.js';
import { QUEUE_FAILURE_MODES, RUNNABLE_PHASES_WITH_PR_REVIEW } from './commands/run/types.js';
import { attachCompletion } from './completion.js';
import { VERIFICATION_LEVELS } from './verify/types.js';

let program: Command;
let originalCwd: string;
let sandbox: string;

function protocol(...args: string[]): string[] {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
    lines.push(String(value ?? ''));
  });

  program.parse(['node', 'issue-flow', 'complete', '--', ...args]);
  log.mockRestore();
  return lines;
}

function script(shell: string): string {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
    lines.push(String(value ?? ''));
  });

  program.parse(['node', 'issue-flow', 'complete', shell]);
  log.mockRestore();
  return lines.join('\n');
}

beforeAll(() => {
  originalCwd = process.cwd();
  sandbox = mkdtempSync(join(tmpdir(), 'issue-flow-completion-'));
  process.chdir(sandbox);

  program = new Command('issue-flow');
  program
    .command('run')
    .description('Execute the full pipeline')
    .addOption(
      new Option('--agent <provider>', 'Run every phase on this agent').choices(AGENT_PROVIDER_IDS),
    )
    .addOption(
      new Option('--from <phase>', 'Resume from a specific phase').choices(
        RUNNABLE_PHASES_WITH_PR_REVIEW,
      ),
    )
    .addOption(
      new Option('--verify-level <level>', 'Acceptance-contract level').choices(
        VERIFICATION_LEVELS,
      ),
    )
    .addOption(
      new Option('--on-issue-failure <mode>', 'Handle a failing queue issue').choices(
        QUEUE_FAILURE_MODES,
      ),
    )
    .addOption(new Option('--detached-child', 'Internal child marker').hideHelp());

  program
    .command('bench')
    .description('Measure the corpus')
    .addOption(new Option('--mode <mode>', 'Benchmark mode').choices(BENCH_MODES))
    .addOption(new Option('--task <class>', 'Corpus class').choices(TASK_CLASSES));

  program.command('runs').description('History of project runs');
  program.command('logs').description('Read a run execution journal');

  for (const [parent, child, description] of [
    ['db', 'export', 'Export structured SQLite state'],
    ['web', 'serve', 'Run the web monitor server'],
    ['routing', 'use', 'Enable an embedded routing policy'],
  ] as const) {
    const command =
      program.commands.find((candidate) => candidate.name() === parent) ?? program.command(parent);
    command.command(child).description(description);
  }

  program
    .command('agent')
    .description('Inspect agent configuration')
    .command('use')
    .addArgument(new Argument('<provider>', 'Agent provider').choices(AGENT_PROVIDER_IDS));
  program.command('internal', { hidden: true }).description('Not user-facing');

  attachCompletion(program);
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(sandbox, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Commander completion integration', () => {
  it.each([
    'zsh',
    'bash',
    'fish',
    'powershell',
  ])('emits a %s script without changing files', (shell) => {
    const output = script(shell);
    expect(output).toContain('issue-flow');
    expect(output).toContain('complete');
    expect(readdirSync(sandbox)).toEqual([]);
  });

  it('derives root and nested suggestions with descriptions from the Commander tree', () => {
    expect(protocol('')).toEqual(
      expect.arrayContaining([
        'db\t',
        'runs\tHistory of project runs',
        'logs\tRead a run execution journal',
        'web\t',
        'routing\t',
        'run\tExecute the full pipeline',
      ]),
    );
    expect(protocol('db', '')).toContain('export\tExport structured SQLite state');
    expect(protocol('web', '')).toContain('serve\tRun the web monitor server');
    expect(protocol('routing', '')).toContain('use\tEnable an embedded routing policy');
    expect(protocol('run', '--a')).toContain('--agent\tRun every phase on this agent');
  });

  it('omits hidden commands and options', () => {
    expect(protocol('')).not.toContain('internal\tNot user-facing');
    expect(protocol('run', '--')).not.toContain('--detached-child\tInternal child marker');
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

  it('completes positional values from Commander choices', () => {
    const output = protocol('agent', 'use', '');
    for (const provider of AGENT_PROVIDER_IDS) {
      expect(output).toContain(`${provider}\t`);
    }
  });
});
