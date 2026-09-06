import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, IssueSource, ResolvedIssue } from './types.js';

vi.mock('../ui/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/logger.js')>();
  return { ...actual, printError: vi.fn(), printWarning: vi.fn() };
});

vi.mock('./resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./resolver.js')>();
  return { ...actual, resolveIssue: vi.fn() };
});

import { printError, printWarning } from '../ui/logger.js';
import { issuePlaceholders, localIssueRef, resolveCommandIssue } from './context.js';
import { IssueResolutionError, resolveIssue } from './resolver.js';

const mockedResolve = vi.mocked(resolveIssue);
const mockedPrintError = vi.mocked(printError);
const mockedPrintWarning = vi.mocked(printWarning);

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: '23',
    number: 23,
    title: 'Add Issue providers',
    body: 'Line one\nLine two',
    labels: ['enhancement', 'core'],
    state: 'open',
    source: 'github',
    remoteRef: 'https://github.com/acme/repo/issues/23',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    contentHash: 'sha256:abc',
    ...overrides,
  };
}

function makeResolved(issue: Issue, source: IssueSource = issue.source): ResolvedIssue {
  return {
    issue,
    source,
    local: source === 'local' ? issue : null,
    github: source === 'github' ? issue : null,
    divergent: false,
  };
}

describe('issuePlaceholders', () => {
  it('maps a GitHub Issue to the prompt placeholders', () => {
    const vars = issuePlaceholders(makeResolved(makeIssue()));

    expect(vars).toEqual({
      __ISSUE_TITLE__: 'Add Issue providers',
      __ISSUE_BODY__: 'Line one\nLine two',
      __ISSUE_LABELS__: 'enhancement, core',
      __ISSUE_SOURCE__: 'github',
      __ISSUE_URL__: 'https://github.com/acme/repo/issues/23',
    });
  });

  it('points __ISSUE_URL__ at the markdown file for a local Issue', () => {
    const issue = makeIssue({ id: '42', number: 42, source: 'local', remoteRef: null });
    const vars = issuePlaceholders(makeResolved(issue, 'local'));

    expect(vars.__ISSUE_SOURCE__).toBe('local');
    expect(vars.__ISSUE_URL__).toBe('issues/42/issue.md');
  });

  it('uses the active storage path when the resolver supplies it', () => {
    const issue = makeIssue({ id: '42', number: 42, source: 'local', remoteRef: null });
    const vars = issuePlaceholders(makeResolved(issue, 'local'), '/tmp/state/issues/42/issue.md');

    expect(vars.__ISSUE_URL__).toBe('/tmp/state/issues/42/issue.md');
  });

  it('keeps the remote URL for a local mirror that has one', () => {
    const issue = makeIssue({ source: 'local', remoteRef: 'https://example.com/issues/23' });
    const vars = issuePlaceholders(makeResolved(issue, 'local'));

    expect(vars.__ISSUE_URL__).toBe('https://example.com/issues/23');
  });

  it('renders an explicit marker when the Issue has no labels', () => {
    const vars = issuePlaceholders(makeResolved(makeIssue({ labels: [] })));

    expect(vars.__ISSUE_LABELS__).toBe('(none)');
  });

  it('uses the resolved source, not the source the provider reported', () => {
    const issue = makeIssue({ source: 'github' });
    const vars = issuePlaceholders(makeResolved(issue, 'local'));

    expect(vars.__ISSUE_SOURCE__).toBe('local');
  });
});

describe('localIssueRef', () => {
  it('builds the repository-relative path of the Issue file', () => {
    expect(localIssueRef('7')).toBe('issues/7/issue.md');
  });
});

describe('resolveCommandIssue', () => {
  beforeEach(() => {
    mockedResolve.mockReset();
    mockedPrintError.mockReset();
  });

  it('returns the pre-resolved Issue without querying the providers', async () => {
    const resolved = makeResolved(makeIssue());

    const outcome = await resolveCommandIssue('23', resolved);

    expect(outcome).toEqual({ ok: true, resolved });
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it('resolves through the resolver when nothing was pre-resolved', async () => {
    const resolved = makeResolved(makeIssue());
    mockedResolve.mockResolvedValue(resolved);

    const outcome = await resolveCommandIssue('23');

    expect(outcome).toEqual({ ok: true, resolved });
    expect(mockedResolve).toHaveBeenCalledWith('23', undefined);
  });

  it('forwards resolver options so the configuration is loaded only once', async () => {
    const resolved = makeResolved(makeIssue());
    mockedResolve.mockResolvedValue(resolved);
    const config = {
      defaultGenerateTarget: 'github',
      preferredProvider: 'local',
      conflictPolicy: 'ask',
      requireConfirmation: true,
    } as const;

    const outcome = await resolveCommandIssue('23', undefined, { config });

    expect(outcome).toEqual({ ok: true, resolved });
    expect(mockedResolve).toHaveBeenCalledWith('23', { config });
  });

  it('propagates the exit code carried by IssueResolutionError', async () => {
    mockedResolve.mockRejectedValue(new IssueResolutionError('Issue not found anywhere', 3));

    const outcome = await resolveCommandIssue('23');

    expect(outcome).toEqual({ ok: false, code: 3 });
    expect(mockedPrintError).toHaveBeenCalledWith('Issue not found anywhere');
  });

  it('reports an unexpected failure as exit code 1', async () => {
    mockedResolve.mockRejectedValue(new Error('boom'));

    const outcome = await resolveCommandIssue('23');

    expect(outcome).toEqual({ ok: false, code: 1 });
    expect(mockedPrintError).toHaveBeenCalledWith("Could not resolve issue '23': boom");
  });
});

describe('resolveCommandIssue — a failure that needs a human (US-014)', () => {
  beforeEach(() => {
    mockedPrintWarning.mockClear();
  });

  it('prints the action the resolver attached to the error', async () => {
    mockedResolve.mockRejectedValue(
      new IssueResolutionError("Cannot read issue '42' from GitHub: bad credentials", 1, {
        action: 'Run `gh auth login` to authenticate the GitHub CLI',
      }),
    );

    await expect(resolveCommandIssue('42')).resolves.toEqual({ ok: false, code: 1 });

    expect(mockedPrintError).toHaveBeenCalledWith(
      "Cannot read issue '42' from GitHub: bad credentials",
    );
    expect(mockedPrintWarning).toHaveBeenCalledWith(
      'Action required: Run `gh auth login` to authenticate the GitHub CLI',
    );
  });

  it('classifies an unexpected error and names the action when one applies', async () => {
    mockedResolve.mockRejectedValue(new Error('gh: Bad credentials'));

    await expect(resolveCommandIssue('42')).resolves.toEqual({ ok: false, code: 1 });

    expect(mockedPrintWarning).toHaveBeenCalledWith(
      'Action required: Run `gh auth login` to authenticate the GitHub CLI',
    );
  });

  it('says nothing about actions for a failure waiting could have fixed', async () => {
    // The retry budget is spent inside the provider; by the time it reaches
    // here it is final, but it is not a failure a person can act on.
    mockedResolve.mockRejectedValue(new IssueResolutionError("Issue '42' not found", 1));

    await expect(resolveCommandIssue('42')).resolves.toEqual({ ok: false, code: 1 });
    expect(mockedPrintWarning).not.toHaveBeenCalled();
  });
});
