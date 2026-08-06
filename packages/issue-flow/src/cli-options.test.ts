import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import {
  CliFlagError,
  resolveNoBranch,
  resolveQueueScopeFlags,
  resolveRunPhaseFlags,
  resolveUserStoryNumberingFlags,
} from './cli-options.js';

describe('resolveNoBranch', () => {
  it('reports no-branch mode when the flag is present', () => {
    expect(resolveNoBranch({ branch: false })).toBe(true);
  });

  it('stays undefined when the flag is absent so the persisted mode wins', () => {
    expect(resolveNoBranch({ branch: true })).toBeUndefined();
    expect(resolveNoBranch({})).toBeUndefined();
  });

  it('matches what commander actually parses for --no-branch', () => {
    // Guards the original defect: commander stores the negated option under
    // `branch`, never `noBranch`, so reading `noBranch` dropped the flag.
    const parse = (argv: string[]): Record<string, unknown> => {
      const program = new Command();
      program.exitOverride();
      let captured: Record<string, unknown> = {};
      program
        .command('run')
        .argument('<issue>')
        .option('--no-branch', 'Run on the current branch')
        .action((_issue: string, options: Record<string, unknown>) => {
          captured = options;
        });
      program.parse(['node', 'cli', 'run', '42', ...argv]);
      return captured;
    };

    const withFlag = parse(['--no-branch']);
    expect(withFlag.noBranch).toBeUndefined();
    expect(withFlag.branch).toBe(false);
    expect(resolveNoBranch(withFlag as { branch?: boolean })).toBe(true);

    const withoutFlag = parse([]);
    expect(resolveNoBranch(withoutFlag as { branch?: boolean })).toBeUndefined();
  });
});

describe('resolveRunPhaseFlags', () => {
  it('keeps both entries undefined when no flag is passed', () => {
    expect(resolveRunPhaseFlags({})).toEqual({ noBranch: undefined, prReview: undefined });
    expect(resolveRunPhaseFlags({ branch: true })).toEqual({
      noBranch: undefined,
      prReview: undefined,
    });
  });

  it('reports each flag on its own', () => {
    expect(resolveRunPhaseFlags({ branch: false })).toEqual({
      noBranch: true,
      prReview: undefined,
    });
    expect(resolveRunPhaseFlags({ prReview: true })).toEqual({
      noBranch: undefined,
      prReview: true,
    });
  });

  it('rejects --pr-review combined with --no-branch', () => {
    expect(() => resolveRunPhaseFlags({ branch: false, prReview: true })).toThrow(CliFlagError);
    expect(() => resolveRunPhaseFlags({ branch: false, prReview: true })).toThrow(
      /--no-branch skips the pr phase/,
    );
  });

  it('matches what commander actually parses for --pr-review and --no-branch', () => {
    const parse = (argv: string[]): Record<string, unknown> => {
      const program = new Command();
      program.exitOverride();
      let captured: Record<string, unknown> = {};
      program
        .command('run')
        .argument('<issue>')
        .option('--no-branch', 'Run on the current branch')
        .option('--pr-review', 'Review the created Pull Request')
        .action((_issue: string, options: Record<string, unknown>) => {
          captured = options;
        });
      program.parse(['node', 'cli', 'run', '42', ...argv]);
      return captured;
    };

    // Commander camel-cases the flag: `--pr-review` lands on `prReview`.
    expect(parse(['--pr-review']).prReview).toBe(true);
    expect(resolveRunPhaseFlags(parse(['--pr-review']))).toEqual({
      noBranch: undefined,
      prReview: true,
    });
    expect(resolveRunPhaseFlags(parse([]))).toEqual({ noBranch: undefined, prReview: undefined });
    expect(() => resolveRunPhaseFlags(parse(['--pr-review', '--no-branch']))).toThrow(CliFlagError);
  });
});

describe('resolveQueueScopeFlags', () => {
  it('leaves both undefined when neither flag is passed', () => {
    expect(resolveQueueScopeFlags({})).toEqual({ yes: undefined, only: undefined });
  });

  it('reports each flag on its own', () => {
    expect(resolveQueueScopeFlags({ yes: true })).toEqual({ yes: true, only: undefined });
    expect(resolveQueueScopeFlags({ only: true })).toEqual({ yes: undefined, only: true });
  });

  it('rejects the combination that answers the same question twice', () => {
    expect(() => resolveQueueScopeFlags({ yes: true, only: true })).toThrow(CliFlagError);
    expect(() => resolveQueueScopeFlags({ yes: true, only: true })).toThrow(
      /--yes cannot be combined with --only/,
    );
  });
});

describe('resolveUserStoryNumberingFlags', () => {
  it('reports neither flag as set when nothing is passed', () => {
    expect(resolveUserStoryNumberingFlags({})).toEqual({
      continueFlag: false,
      startUs: undefined,
    });
  });

  it('reports --continue on its own', () => {
    expect(resolveUserStoryNumberingFlags({ continue: true })).toEqual({
      continueFlag: true,
      startUs: undefined,
    });
  });

  it('reports --start-us on its own', () => {
    expect(resolveUserStoryNumberingFlags({ startUs: 27 })).toEqual({
      continueFlag: false,
      startUs: 27,
    });
  });

  it('rejects --continue combined with --start-us', () => {
    expect(() => resolveUserStoryNumberingFlags({ continue: true, startUs: 27 })).toThrow(
      CliFlagError,
    );
    expect(() => resolveUserStoryNumberingFlags({ continue: true, startUs: 27 })).toThrow(
      /--continue and --start-us cannot be combined/,
    );
  });

  it('matches what commander actually parses for --continue and --start-us', () => {
    const parse = (argv: string[]): Record<string, unknown> => {
      const program = new Command();
      program.exitOverride();
      let captured: Record<string, unknown> = {};
      program
        .command('plan')
        .argument('<issue>')
        .option('--continue', 'Continue User Story numbering')
        .option('--start-us <n>', 'Force User Story numbering to start at n', (value: string) =>
          Number.parseInt(value, 10),
        )
        .action((_issue: string, options: Record<string, unknown>) => {
          captured = options;
        });
      program.parse(['node', 'cli', 'plan', '42', ...argv]);
      return captured;
    };

    expect(parse(['--continue']).continue).toBe(true);
    expect(resolveUserStoryNumberingFlags(parse(['--continue']))).toEqual({
      continueFlag: true,
      startUs: undefined,
    });

    expect(parse(['--start-us', '27']).startUs).toBe(27);
    expect(resolveUserStoryNumberingFlags(parse(['--start-us', '27']))).toEqual({
      continueFlag: false,
      startUs: 27,
    });

    expect(() => resolveUserStoryNumberingFlags(parse(['--continue', '--start-us', '27']))).toThrow(
      CliFlagError,
    );
  });
});
