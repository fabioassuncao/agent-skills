import { PassThrough, Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrDiscoveryError, type PrDiscoverySources, resolvePullRequest } from './discovery.js';

/** Every source empty: each test opts into the one it exercises. */
function makeSources(overrides: Partial<PrDiscoverySources> = {}): Partial<PrDiscoverySources> {
  return {
    sessionPullRequests: () => [],
    planPullRequest: async () => null,
    currentBranch: async () => 'issue/25-pr-review-phase',
    branchPullRequests: async () => [],
    ...overrides,
  };
}

/** Discards everything readline writes while prompting. */
function sinkStream(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

/** A stdin that answers the confirmation with `answer`, then ends. */
function answering(answer: string): PassThrough {
  const stream = new PassThrough();
  stream.end(`${answer}\n`);
  return stream;
}

describe('resolvePullRequest', () => {
  let info: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    info = vi.fn();
    warn = vi.fn();
  });

  describe('explicit argument (source 1)', () => {
    it('accepts a plain number without consulting any other source', async () => {
      const sessionPullRequests = vi.fn(() => []);
      const resolved = await resolvePullRequest('184', {
        sources: makeSources({ sessionPullRequests }),
        info,
        warn,
      });

      expect(resolved).toEqual({
        number: 184,
        url: null,
        title: null,
        headBranch: null,
        source: 'argument',
      });
      expect(sessionPullRequests).not.toHaveBeenCalled();
    });

    it('accepts `#184` and a Pull Request URL', async () => {
      const hash = await resolvePullRequest('#184', { sources: makeSources(), info, warn });
      expect(hash.number).toBe(184);

      const url = await resolvePullRequest('https://github.com/acme/repo/pull/184', {
        sources: makeSources(),
        info,
        warn,
      });
      expect(url.number).toBe(184);
      expect(url.url).toBe('https://github.com/acme/repo/pull/184');
    });

    it('rejects an unparsable reference instead of coercing it', async () => {
      await expect(
        resolvePullRequest('feature-branch', { sources: makeSources(), info, warn }),
      ).rejects.toBeInstanceOf(PrDiscoveryError);
    });
  });

  describe('session snapshot (source 2)', () => {
    it('uses the most recent PR of the active session', async () => {
      const planPullRequest = vi.fn(async () => null);
      const resolved = await resolvePullRequest(undefined, {
        issue: '25',
        yes: true,
        sources: makeSources({
          sessionPullRequests: () => [
            { number: 180, url: 'https://github.com/acme/repo/pull/180', title: 'Older' },
            { number: 184, url: 'https://github.com/acme/repo/pull/184', title: 'PR review phase' },
          ],
          planPullRequest,
        }),
        info,
        warn,
      });

      expect(resolved).toEqual({
        number: 184,
        url: 'https://github.com/acme/repo/pull/184',
        title: 'PR review phase',
        headBranch: null,
        source: 'session',
      });
      // Source 2 hit: the later sources are never consulted.
      expect(planPullRequest).not.toHaveBeenCalled();
    });
  });

  describe('tasks.json (source 3)', () => {
    it('uses plan.pullRequest when the session knows nothing', async () => {
      const branchPullRequests = vi.fn(async () => []);
      const resolved = await resolvePullRequest(undefined, {
        issue: '25',
        yes: true,
        sources: makeSources({
          planPullRequest: async () => ({
            number: 184,
            url: 'https://github.com/acme/repo/pull/184',
            headBranch: 'issue/25-pr-review-phase',
            createdAt: '2026-08-03T21:00:00Z',
          }),
          branchPullRequests,
        }),
        info,
        warn,
      });

      expect(resolved).toEqual({
        number: 184,
        url: 'https://github.com/acme/repo/pull/184',
        title: null,
        headBranch: 'issue/25-pr-review-phase',
        source: 'plan',
      });
      expect(branchPullRequests).not.toHaveBeenCalled();
    });

    it('is skipped when there is no associated issue', async () => {
      const planPullRequest = vi.fn(async () => null);
      await expect(
        resolvePullRequest(undefined, {
          yes: true,
          sources: makeSources({ planPullRequest }),
          info,
          warn,
        }),
      ).rejects.toBeInstanceOf(PrDiscoveryError);
      expect(planPullRequest).not.toHaveBeenCalled();
    });
  });

  describe('current branch (source 4)', () => {
    it('uses the most recent PR whose head is the current branch', async () => {
      const branchPullRequests = vi.fn(async (_branch: string) => [
        { number: 12, url: 'https://github.com/acme/repo/pull/12', title: 'Draft' },
        { number: 19, url: 'https://github.com/acme/repo/pull/19', title: 'Reopened' },
      ]);
      const resolved = await resolvePullRequest(undefined, {
        issue: '25',
        yes: true,
        sources: makeSources({ currentBranch: async () => 'issue/25-x', branchPullRequests }),
        info,
        warn,
      });

      expect(branchPullRequests).toHaveBeenCalledWith('issue/25-x');
      expect(resolved).toEqual({
        number: 19,
        url: 'https://github.com/acme/repo/pull/19',
        title: 'Reopened',
        headBranch: 'issue/25-x',
        source: 'branch',
      });
    });

    it('does not query gh in detached HEAD (empty branch)', async () => {
      const branchPullRequests = vi.fn(async () => []);
      await expect(
        resolvePullRequest(undefined, {
          yes: true,
          sources: makeSources({ currentBranch: async () => '', branchPullRequests }),
          info,
          warn,
        }),
      ).rejects.toBeInstanceOf(PrDiscoveryError);
      expect(branchPullRequests).not.toHaveBeenCalled();
    });

    it('warns and fails instead of throwing when the branch cannot be detected', async () => {
      await expect(
        resolvePullRequest(undefined, {
          yes: true,
          sources: makeSources({
            currentBranch: async () => {
              throw new Error('not a git repository');
            },
          }),
          info,
          warn,
        }),
      ).rejects.toBeInstanceOf(PrDiscoveryError);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a git repository'));
    });
  });

  describe('no Pull Request at all (source 5)', () => {
    it('fails with an actionable message and never invents a number', async () => {
      await expect(
        resolvePullRequest(undefined, {
          issue: '25',
          yes: true,
          sources: makeSources(),
          info,
          warn,
        }),
      ).rejects.toThrow(/issue-flow pr-review <number>/);
    });

    it('carries exit code 1', async () => {
      const error = await resolvePullRequest(undefined, {
        yes: true,
        sources: makeSources(),
        info,
        warn,
      }).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(PrDiscoveryError);
      expect((error as PrDiscoveryError).exitCode).toBe(1);
    });
  });

  describe('confirmation', () => {
    const discovered = makeSources({
      planPullRequest: async () => ({
        number: 184,
        url: 'https://github.com/acme/repo/pull/184',
        headBranch: 'issue/25-pr-review-phase',
        createdAt: '2026-08-03T21:00:00Z',
      }),
    });

    it('accepts an empty answer as yes and shows number, title and branch', async () => {
      const resolved = await resolvePullRequest(undefined, {
        issue: '25',
        interactive: true,
        stdin: answering(''),
        stdout: sinkStream(),
        sources: discovered,
        info,
        warn,
      });

      expect(resolved.number).toBe(184);
      const shown = info.mock.calls.map((call) => String(call[0])).join('\n');
      expect(shown).toContain('#184');
      expect(shown).toContain('title:');
      expect(shown).toContain('issue/25-pr-review-phase');
    });

    it('cancels when the user answers n', async () => {
      await expect(
        resolvePullRequest(undefined, {
          issue: '25',
          interactive: true,
          stdin: answering('n'),
          stdout: sinkStream(),
          sources: discovered,
          info,
          warn,
        }),
      ).rejects.toThrow(/Cancelled/);
    });

    it('re-asks on an invalid answer and cancels on EOF', async () => {
      await expect(
        resolvePullRequest(undefined, {
          issue: '25',
          interactive: true,
          stdin: answering('maybe'),
          stdout: sinkStream(),
          sources: discovered,
          info,
          warn,
        }),
      ).rejects.toThrow(/Cancelled/);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Enter y or n'));
    });

    it('is skipped with --yes, logging the discovered number instead', async () => {
      const stdin = answering('n');
      const resolved = await resolvePullRequest(undefined, {
        issue: '25',
        yes: true,
        interactive: true,
        stdin,
        stdout: sinkStream(),
        sources: discovered,
        info,
        warn,
      });

      expect(resolved.number).toBe(184);
      expect(info).toHaveBeenCalledWith(expect.stringContaining('#184'));
    });

    it('never prompts for an explicit argument', async () => {
      const resolved = await resolvePullRequest('184', {
        issue: '25',
        interactive: true,
        stdin: answering('n'),
        stdout: sinkStream(),
        sources: discovered,
        info,
        warn,
      });

      expect(resolved.source).toBe('argument');
    });
  });
});
