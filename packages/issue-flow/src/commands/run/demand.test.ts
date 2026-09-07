import { describe, expect, it } from 'vitest';
import { IssueArgumentError } from '../../issues/args.js';
import { RunDemandError, resolveAutoCloseFlag, resolveRunDemand } from './demand.js';

/**
 * Parity suite for the entry half of §17's convergence, against
 * `.references/webmux-main/bin/src/oneshot.test.ts` @ d8c9d5f
 * (`parseOneshotArgs`, 17 cases).
 *
 * Three of the seventeen carry over. The other fourteen belong to surfaces
 * this repository deliberately does not have:
 *
 * - eight are `--linear` / `--branch` (Linear posting/pickup is a separate
 *   integration surface, and a `run` derives its branch from the plan, never
 *   from a flag);
 * - four are `--resume`, which is `issue-flow resume` here — a second resume
 *   path inside `run` would be exactly the duplication invariant 13 forbids;
 * - one is `--agent/--base/--profile/--env`, which are worktree-creation
 *   options, not demand options;
 * - one is `--help`, which commander owns.
 */
describe('run demand', () => {
  // Upstream: "requires --prompt for new oneshots".
  it('requires a demand', () => {
    expect(() => resolveRunDemand({ issues: [] })).toThrow(RunDemandError);
    expect(() => resolveRunDemand({})).toThrow(/--prompt/);
  });

  // Upstream: "parses positional branch and prompt" — where the positional is
  // a *branch*, so the two coexist. Here the positional is the demand itself,
  // so the two are contradictory and saying so is better than picking one.
  it('rejects an issue and a prompt in the same invocation', () => {
    expect(() => resolveRunDemand({ issues: ['42'], prompt: 'fix the flaky test' })).toThrow(
      /Cannot pass both an issue \(42\) and --prompt/,
    );
  });

  // Upstream: "parses --keep-open".
  it('reads --keep-open as an explicit refusal to close', () => {
    expect(resolveAutoCloseFlag({ keepOpen: true })).toBe(false);
    expect(resolveAutoCloseFlag({ autoClose: true })).toBe(true);
    expect(resolveAutoCloseFlag({})).toBeUndefined();
  });

  it('rejects --auto-close together with --keep-open', () => {
    expect(() => resolveAutoCloseFlag({ autoClose: true, keepOpen: true })).toThrow(
      /mutually exclusive/,
    );
  });

  it('rejects a prompt that is only whitespace', () => {
    expect(() => resolveRunDemand({ prompt: '   \n ' })).toThrow(/--prompt requires a value/);
  });

  it('keeps the historical issue forms untouched', () => {
    expect(resolveRunDemand({ issues: ['42'] })).toEqual({ kind: 'issues', ids: ['42'] });
    expect(resolveRunDemand({ issues: ['42,43'] })).toEqual({
      kind: 'issues',
      ids: ['42', '43'],
    });
    expect(resolveRunDemand({ issues: ['#42', '43'] })).toEqual({
      kind: 'issues',
      ids: ['42', '43'],
    });
  });

  it('still rejects a malformed identifier through the existing parser', () => {
    expect(() => resolveRunDemand({ issues: ['42,,43'] })).toThrow(IssueArgumentError);
  });

  it('carries a multi-line prompt through whole', () => {
    const prompt = 'Rewrite the cache\n\n- keep the API\n- add a test';
    expect(resolveRunDemand({ prompt })).toEqual({ kind: 'prompt', prompt });
  });
});
