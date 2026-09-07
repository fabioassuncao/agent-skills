import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { program } from './cli.js';
import { buildRootHelp, HELP_ENVIRONMENT_VARIABLES, ROOT_HELP_COMMANDS } from './cli-help.js';

describe('root CLI help', () => {
  it('groups every command and keeps one command per line', () => {
    const help = buildRootHelp();

    expect(help).toContain('Issue Flow — Take an issue from statement to a reviewed Pull Request.');
    for (const group of [
      'Pipeline:',
      'Sessions and worktrees:',
      'Monitor:',
      'Configuration and diagnostics:',
      'Skills:',
    ]) {
      expect(help).toContain(group);
    }

    const commandLines = help.split('\n').filter((line) => line.startsWith('  issue-flow '));
    expect(commandLines).toHaveLength(ROOT_HELP_COMMANDS.length);
    expect(new Set(commandLines).size).toBe(commandLines.length);
    for (const command of ROOT_HELP_COMMANDS) {
      expect(
        commandLines.filter((line) => line.startsWith(`  issue-flow ${command.name} `)),
      ).toHaveLength(1);
    }
  });

  it('matches the real Commander tree, including every worktree operation', () => {
    const actualRootCommands = program.commands.map((command) => command.name()).sort();
    expect(ROOT_HELP_COMMANDS.map((command) => command.name).sort()).toEqual(actualRootCommands);

    const worktree = program.commands.find((command) => command.name() === 'worktree');
    expect(worktree).toBeDefined();
    expect(worktree?.commands.map((command) => command.name()).sort()).toEqual([
      'archive',
      'label',
      'ls',
      'merge',
      'prune',
      'refresh',
      'remove',
      'unarchive',
    ]);
    const prune = worktree?.commands.find((command) => command.name() === 'prune');
    expect(prune?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--dry-run', '--yes', '--project']),
    );
    expect(program.helpInformation()).toContain('issue-flow worktree');

    const tab = program.commands.find((command) => command.name() === 'tab');
    expect(tab?.commands.map((command) => command.name()).sort()).toEqual([
      'close',
      'create',
      'list',
      'switch',
    ]);
  });

  it('documents the real user-facing environment configuration', () => {
    const help = buildRootHelp();

    const required = [
      'ISSUE_FLOW_HOME',
      'ISSUE_FLOW_PROJECT_DIR',
      'ISSUE_FLOW_RUNTIME_MAX_CONCURRENT',
      'ISSUE_FLOW_RUN_AUTO_CLOSE',
      'ISSUE_FLOW_RUNTIME_PROFILE',
      'ISSUE_FLOW_GITHUB_LINKED_REPOS',
      'ISSUE_FLOW_E2E_BENCH',
    ];
    for (const variable of HELP_ENVIRONMENT_VARIABLES) {
      expect(help).toContain(variable);
    }
    expect(HELP_ENVIRONMENT_VARIABLES).toEqual(expect.arrayContaining(required));
    expect(HELP_ENVIRONMENT_VARIABLES).not.toContain('ISSUE_FLOW_POLICY_*');
    expect(HELP_ENVIRONMENT_VARIABLES).not.toContain('ISSUE_FLOW_RESILIENCE_*');
  });

  it('matches every public environment read in configuration entry points', () => {
    const configDirectory = join(import.meta.dirname, 'config');
    const sourceFiles = readdirSync(configDirectory)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => join(configDirectory, name))
      .concat([
        join(import.meta.dirname, 'storage/paths.ts'),
        join(import.meta.dirname, 'commands/serve.ts'),
        join(import.meta.dirname, 'benchmark/live.ts'),
      ]);
    const publicReads = new Set(
      sourceFiles
        .flatMap((file) =>
          Array.from(readFileSync(file, 'utf8').matchAll(/ISSUE_FLOW_[A-Z0-9_]+/g), (match) =>
            String(match[0]),
          ),
        )
        .filter((name) => !name.endsWith('_')),
    );

    expect(new Set(HELP_ENVIRONMENT_VARIABLES)).toEqual(publicReads);
  });

  it('never wraps a command summary onto another line', () => {
    const commandLines = buildRootHelp()
      .split('\n')
      .filter((line) => line.startsWith('  issue-flow '));

    expect(commandLines.every((line) => line.length <= 100)).toBe(true);
  });
});
