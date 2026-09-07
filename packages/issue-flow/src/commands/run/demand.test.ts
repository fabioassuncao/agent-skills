import { describe, expect, it } from 'vitest';
import { IssueArgumentError } from '../../issues/args.js';
import { RunDemandError, resolveAutoCloseFlag, resolveRunDemand } from './demand.js';

describe('run demand', () => {
  it('requires a demand', () => {
    expect(() => resolveRunDemand({ issues: [] })).toThrow(RunDemandError);
    expect(() => resolveRunDemand({})).toThrow(/--prompt/);
  });

  it('rejects an issue and a prompt in the same invocation', () => {
    expect(() => resolveRunDemand({ issues: ['42'], prompt: 'fix the flaky test' })).toThrow(
      /Cannot pass both an issue \(42\) and --prompt/,
    );
  });

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
