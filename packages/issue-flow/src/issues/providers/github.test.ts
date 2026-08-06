import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecResult } from '../../utils/shell.js';
import { hashIssueContent } from '../hash.js';

vi.mock('../../utils/shell.js', () => ({ run: vi.fn() }));

const { run } = await import('../../utils/shell.js');
const { GitHubIssueProvider, githubIssueProvider } = await import('./github.js');

const mockRun = vi.mocked(run);

function result(overrides?: Partial<ExecResult>): ExecResult {
  return { stdout: '', stderr: '', exitCode: 0, ...overrides };
}

const VIEW_FIELDS = 'number,title,body,labels,state,url,createdAt,updatedAt';

const ghPayload = {
  number: 23,
  title: 'Abstract issue providers',
  body: 'Make the pipeline origin-agnostic.',
  labels: [{ name: 'enhancement' }, { name: 'architecture' }],
  state: 'OPEN',
  url: 'https://github.com/fabioassuncao/issue-flow/issues/23',
  createdAt: '2026-08-01T10:00:00Z',
  updatedAt: '2026-08-02T11:00:00Z',
};

let provider: InstanceType<typeof GitHubIssueProvider>;

beforeEach(() => {
  mockRun.mockReset();
  provider = new GitHubIssueProvider();
});

describe('GitHubIssueProvider', () => {
  it('is registered under the github source', () => {
    expect(provider.name).toBe('github');
    expect(githubIssueProvider.name).toBe('github');
  });
});

describe('get', () => {
  it('maps the gh payload into an Issue with remoteRef and contentHash', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: JSON.stringify(ghPayload) }));

    const issue = await provider.get('23');

    expect(mockRun).toHaveBeenCalledWith('gh', ['issue', 'view', '23', '--json', VIEW_FIELDS]);
    expect(issue).toMatchObject({
      id: '23',
      number: 23,
      title: 'Abstract issue providers',
      body: 'Make the pipeline origin-agnostic.',
      labels: ['enhancement', 'architecture'],
      state: 'open',
      source: 'github',
      remoteRef: 'https://github.com/fabioassuncao/issue-flow/issues/23',
      createdAt: '2026-08-01T10:00:00Z',
      updatedAt: '2026-08-02T11:00:00Z',
    });
    expect(issue?.contentHash).toBe(
      hashIssueContent('Abstract issue providers', 'Make the pipeline origin-agnostic.'),
    );
    expect(issue?.raw).toEqual(ghPayload);
  });

  it('normalizes CLOSED into the closed state', async () => {
    mockRun.mockResolvedValueOnce(
      result({ stdout: JSON.stringify({ ...ghPayload, state: 'CLOSED' }) }),
    );
    await expect(provider.get('23')).resolves.toMatchObject({ state: 'closed' });
  });

  it('accepts an id prefixed with #', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: JSON.stringify(ghPayload) }));
    await provider.get('#23');
    expect(mockRun).toHaveBeenCalledWith('gh', ['issue', 'view', '23', '--json', VIEW_FIELDS]);
  });

  it('tolerates an empty body and missing labels', async () => {
    mockRun.mockResolvedValueOnce(
      result({ stdout: JSON.stringify({ ...ghPayload, body: null, labels: null }) }),
    );

    const issue = await provider.get('23');

    expect(issue?.body).toBe('');
    expect(issue?.labels).toEqual([]);
  });

  it('returns null when the issue does not exist', async () => {
    mockRun.mockResolvedValueOnce(
      result({
        exitCode: 1,
        stderr:
          'GraphQL: Could not resolve to an Issue with the number of 9999. (repository.issue)',
      }),
    );

    await expect(provider.get('9999')).resolves.toBeNull();
  });

  it('throws when gh is not installed', async () => {
    mockRun.mockResolvedValueOnce(result({ exitCode: 127, stderr: 'gh: command not found' }));

    await expect(provider.get('23')).rejects.toThrow(/command not found/);
  });

  it('throws on authentication failures instead of reporting a missing issue', async () => {
    mockRun.mockResolvedValueOnce(
      result({
        exitCode: 1,
        stderr: 'gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN',
      }),
    );

    await expect(provider.get('23')).rejects.toThrow(/Failed to fetch GitHub issue #23/);
  });

  it('throws when gh returns unparseable output', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: 'not json' }));
    await expect(provider.get('23')).rejects.toThrow(/Failed to parse gh output/);
  });
});

describe('create', () => {
  it('passes one --label per label and reads the created issue back', async () => {
    mockRun.mockResolvedValueOnce(
      result({ stdout: 'https://github.com/fabioassuncao/issue-flow/issues/23\n' }),
    );
    mockRun.mockResolvedValueOnce(result({ stdout: JSON.stringify(ghPayload) }));

    const issue = await provider.create({
      title: 'Abstract issue providers',
      body: 'Make the pipeline origin-agnostic.',
      labels: ['enhancement', 'architecture'],
    });

    expect(mockRun).toHaveBeenNthCalledWith(1, 'gh', [
      'issue',
      'create',
      '--title',
      'Abstract issue providers',
      '--body',
      'Make the pipeline origin-agnostic.',
      '--label',
      'enhancement',
      '--label',
      'architecture',
    ]);
    expect(mockRun).toHaveBeenNthCalledWith(2, 'gh', [
      'issue',
      'view',
      '23',
      '--json',
      VIEW_FIELDS,
    ]);
    expect(issue).toMatchObject({ id: '23', number: 23, source: 'github' });
  });

  it('omits --label entirely when the draft has no labels', async () => {
    mockRun.mockResolvedValueOnce(
      result({ stdout: 'https://github.com/fabioassuncao/issue-flow/issues/23' }),
    );
    mockRun.mockResolvedValueOnce(result({ stdout: JSON.stringify(ghPayload) }));

    await provider.create({ title: 'T', body: 'B', labels: [] });

    expect(mockRun.mock.calls[0]?.[1]).not.toContain('--label');
  });

  it('throws when gh issue create fails', async () => {
    mockRun.mockResolvedValueOnce(
      result({ exitCode: 1, stderr: 'could not add label: not found' }),
    );

    await expect(provider.create({ title: 'T', body: 'B', labels: ['nope'] })).rejects.toThrow(
      /Failed to create GitHub issue/,
    );
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('throws when the output carries no issue URL', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: 'Creating issue...' }));

    await expect(provider.create({ title: 'T', body: 'B', labels: [] })).rejects.toThrow(
      /did not report an issue URL/,
    );
  });
});

describe('close', () => {
  it('runs gh issue close', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: 'Closed issue #23' }));

    await expect(provider.close('23')).resolves.toBeUndefined();
    expect(mockRun).toHaveBeenCalledWith('gh', ['issue', 'close', '23']);
  });

  it('throws when gh issue close fails', async () => {
    mockRun.mockResolvedValueOnce(result({ exitCode: 1, stderr: 'issue is already closed' }));

    await expect(provider.close('23')).rejects.toThrow(/Failed to close GitHub issue #23/);
  });
});

describe('isAvailable', () => {
  it('is true when gh exists and is authenticated', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: 'gh version 2.62.0' }));
    mockRun.mockResolvedValueOnce(result({ stdout: 'Logged in to github.com' }));

    await expect(provider.isAvailable()).resolves.toBe(true);
    expect(mockRun).toHaveBeenNthCalledWith(1, 'gh', ['--version'], { timeout: 10_000 });
    expect(mockRun).toHaveBeenNthCalledWith(2, 'gh', ['auth', 'status'], { timeout: 10_000 });
  });

  it('is false when gh is missing, without probing auth', async () => {
    mockRun.mockResolvedValueOnce(result({ exitCode: 127, stderr: 'gh: command not found' }));

    await expect(provider.isAvailable()).resolves.toBe(false);
    expect(mockRun).toHaveBeenCalledTimes(1);
  });

  it('is false when gh is not authenticated', async () => {
    mockRun.mockResolvedValueOnce(result({ stdout: 'gh version 2.62.0' }));
    mockRun.mockResolvedValueOnce(
      result({ exitCode: 1, stderr: 'You are not logged into any GitHub hosts' }),
    );

    await expect(provider.isAvailable()).resolves.toBe(false);
  });

  it('never throws when the probe itself explodes', async () => {
    mockRun.mockRejectedValueOnce(new Error('spawn ENOENT'));

    await expect(provider.isAvailable()).resolves.toBe(false);
  });
});

describe('fetchRelations', () => {
  /**
   * The five endpoints run concurrently, so the doubles are keyed by path
   * instead of by call order — `mockResolvedValueOnce` would bind an answer to
   * whichever promise happened to be created first.
   */
  function mockApi(answers: Record<string, unknown>, body = ''): void {
    mockRun.mockImplementation(async (_cmd: string, args: string[] = []) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return result({ stdout: JSON.stringify({ ...ghPayload, body }) });
      }
      const path = args[1] ?? '';
      for (const [suffix, payload] of Object.entries(answers)) {
        if (path.includes(suffix)) {
          return result({ stdout: JSON.stringify(payload) });
        }
      }
      return result({ exitCode: 1, stderr: 'Not Found (HTTP 404)' });
    });
  }

  it('returns empty relations when nothing answers', async () => {
    mockApi({});

    await expect(provider.fetchRelations('50')).resolves.toEqual({
      id: '50',
      parent: null,
      children: [],
      blockedBy: [],
      blocking: [],
      references: [],
      referencedBy: [],
      heuristic: [],
    });
  });

  it('queries the five relation endpoints of the issue', async () => {
    mockApi({});
    await provider.fetchRelations('#50');

    const paths = mockRun.mock.calls
      .filter(([, args]) => args?.[0] === 'api')
      .map(([, args]) => args?.[1]);
    expect(paths).toEqual([
      'repos/{owner}/{repo}/issues/50',
      'repos/{owner}/{repo}/issues/50/sub_issues?per_page=100',
      'repos/{owner}/{repo}/issues/50/dependencies/blocked_by?per_page=100',
      'repos/{owner}/{repo}/issues/50/dependencies/blocking?per_page=100',
      'repos/{owner}/{repo}/issues/50/timeline?per_page=100',
    ]);
  });

  it('maps sub-issues and the parent from the hierarchy endpoints', async () => {
    mockApi({
      '/sub_issues': [{ number: 51 }, { number: 52 }],
      'issues/50': { number: 50, body: '', parent: { number: 49 } },
    });

    await expect(provider.fetchRelations('50')).resolves.toMatchObject({
      parent: '49',
      children: ['51', '52'],
      heuristic: [],
    });
  });

  it('maps blocked_by and blocking from the dependencies endpoints', async () => {
    mockApi({
      '/dependencies/blocked_by': [{ number: 48 }],
      '/dependencies/blocking': [{ number: 53 }],
    });

    await expect(provider.fetchRelations('50')).resolves.toMatchObject({
      blockedBy: ['48'],
      blocking: ['53'],
    });
  });

  it('falls back to the body when the structured sources are unavailable', async () => {
    mockApi({ 'issues/50': { number: 50, body: 'Depends on #48\n- [ ] #51' } });

    await expect(provider.fetchRelations('50')).resolves.toMatchObject({
      blockedBy: ['48'],
      children: ['51'],
      heuristic: ['51', '48'],
    });
  });

  it('reads the body through gh issue view when the REST payload fails', async () => {
    mockApi({}, 'Blocked by #48');

    await expect(provider.fetchRelations('50')).resolves.toMatchObject({ blockedBy: ['48'] });
  });

  it('combines structured and textual sources without duplicating', async () => {
    mockApi({
      '/sub_issues': [{ number: 51 }],
      '/dependencies/blocked_by': [{ number: 48 }],
      'issues/50': { number: 50, body: '- [ ] #51\n- [ ] #52\nDepends on #48' },
    });

    await expect(provider.fetchRelations('50')).resolves.toMatchObject({
      children: ['51', '52'],
      blockedBy: ['48'],
      heuristic: ['52'],
    });
  });

  it('reads cross-references from the timeline, skipping Pull Requests', async () => {
    mockApi({
      '/timeline': [
        { event: 'labeled' },
        { event: 'cross-referenced', source: { issue: { number: 80 } } },
        {
          event: 'cross-referenced',
          source: { issue: { number: 81, pull_request: { url: 'https://…' } } },
        },
      ],
    });

    await expect(provider.fetchRelations('50')).resolves.toMatchObject({ referencedBy: ['80'] });
  });

  it('never throws when gh itself explodes', async () => {
    mockRun.mockRejectedValue(new Error('spawn ENOENT'));

    await expect(provider.fetchRelations('50')).resolves.toMatchObject({ id: '50', children: [] });
  });

  it('answers empty relations for a non-numeric identifier', async () => {
    await expect(provider.fetchRelations('auth-refactor')).resolves.toMatchObject({
      id: 'auth-refactor',
      children: [],
    });
    expect(mockRun).not.toHaveBeenCalled();
  });
});
