import { describe, expect, it, vi } from 'vitest';
import type { LabelDefinition } from '../policy/types.js';
import { createMissingLabels, reconcileLabels } from './label-policy.js';

vi.mock('../utils/shell.js', () => ({ run: vi.fn() }));

import { run } from '../utils/shell.js';

const mockRun = vi.mocked(run);

function labels(...names: string[]): LabelDefinition[] {
  return names.map((name) => ({ name, description: null, color: null }));
}

describe('reconcileLabels', () => {
  it('keeps the labels the repository has', () => {
    expect(reconcileLabels(['bug', 'infra'], labels('bug', 'infra', 'docs'))).toEqual({
      labels: ['bug', 'infra'],
      missing: [],
    });
  });

  it('drops a label the repository does not have, and reports it', () => {
    expect(reconcileLabels(['bug', 'high'], labels('bug'))).toEqual({
      labels: ['bug'],
      missing: ['high'],
    });
  });

  it("answers with the repository's casing, not the suggestion's", () => {
    // `gh issue create --label Bug` fails on a repository whose label is `bug`,
    // and the agent has no way to know which one it is.
    expect(reconcileLabels(['Bug', 'INFRA'], labels('bug', 'infra')).labels).toEqual([
      'bug',
      'infra',
    ]);
  });

  it('deduplicates', () => {
    expect(reconcileLabels(['bug', 'Bug', 'bug'], labels('bug')).labels).toEqual(['bug']);
    expect(reconcileLabels(['x', 'x'], labels('bug')).missing).toEqual(['x']);
  });

  it('passes everything through when the labels could not be read at all', () => {
    // An empty registry is "discovery was offline", not "the repository has no
    // labels" — refusing to label the issue would be the wrong failure.
    expect(reconcileLabels(['bug', 'high'], [])).toEqual({
      labels: ['bug', 'high'],
      missing: [],
    });
  });

  it('handles a draft that suggested nothing', () => {
    expect(reconcileLabels([], labels('bug'))).toEqual({ labels: [], missing: [] });
  });

  it('ignores surrounding whitespace in a suggestion', () => {
    expect(reconcileLabels(['  bug '], labels('bug')).labels).toEqual(['bug']);
  });
});

describe('createMissingLabels', () => {
  const warn = vi.fn();

  it('creates each label and reports the ones that now exist', async () => {
    mockRun.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    warn.mockClear();

    expect(await createMissingLabels(['high', 'low'], warn)).toEqual(['high', 'low']);
    expect(mockRun).toHaveBeenCalledWith('gh', ['label', 'create', 'high']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats an already-existing label as a success', async () => {
    mockRun.mockResolvedValue({
      stdout: '',
      stderr: 'label already exists; use `gh label edit`',
      exitCode: 1,
    });
    warn.mockClear();

    expect(await createMissingLabels(['bug'], warn)).toEqual(['bug']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips a label it cannot create without costing the others', async () => {
    warn.mockClear();
    mockRun
      .mockResolvedValueOnce({ stdout: '', stderr: 'HTTP 403', exitCode: 1 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 });

    expect(await createMissingLabels(['denied', 'allowed'], warn)).toEqual(['allowed']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Could not create label "denied"'));
  });
});
