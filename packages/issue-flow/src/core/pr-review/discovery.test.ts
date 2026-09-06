import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function outputStream(isTTY = true): { stdout: Writable; written: () => string } {
  let output = '';
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      output += String(chunk);
      callback();
    },
  });
  Object.defineProperty(stdout, 'isTTY', { value: isTTY });
  return { stdout, written: () => output };
}

/** A TTY stdin whose raw answer is buffered before prompt creation. */
function answering(answer: string, isTTY = true): PassThrough {
  const stream = new PassThrough();
  Object.defineProperty(stream, 'isTTY', { value: isTTY });
  Object.defineProperty(stream, 'setRawMode', { value: () => stream });
  stream.write(answer);
  return stream;
}

describe('resolvePullRequest', () => {
  let info: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    info = vi.fn();
    warn = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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

  describe('tasks.json (source 2)', () => {
    it('uses plan.pullRequest when present', async () => {
      const sessionPullRequests = vi.fn(() => [
        { number: 999, url: 'https://github.com/acme/repo/pull/999', title: 'Stale session PR' },
      ]);
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
          sessionPullRequests,
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
      // Plan wins over a higher-numbered (or stale) session PR.
      expect(sessionPullRequests).not.toHaveBeenCalled();
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

  describe('session snapshot (source 3)', () => {
    it('uses the most recent PR of the active session when the plan has none', async () => {
      const branchPullRequests = vi.fn(async () => []);
      const resolved = await resolvePullRequest(undefined, {
        issue: '25',
        yes: true,
        sources: makeSources({
          sessionPullRequests: () => [
            { number: 180, url: 'https://github.com/acme/repo/pull/180', title: 'Older' },
            { number: 184, url: 'https://github.com/acme/repo/pull/184', title: 'PR review phase' },
          ],
          branchPullRequests,
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
      expect(branchPullRequests).not.toHaveBeenCalled();
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

    it('warns and fails instead of throwing when listing PRs fails', async () => {
      await expect(
        resolvePullRequest(undefined, {
          yes: true,
          sources: makeSources({
            branchPullRequests: async () => {
              throw new Error('gh unavailable');
            },
          }),
          info,
          warn,
        }),
      ).rejects.toBeInstanceOf(PrDiscoveryError);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('gh unavailable'));
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

    it('accepts the initially suggested yes with Enter and shows the discovered PR', async () => {
      const { stdout } = outputStream();
      const resolved = await resolvePullRequest(undefined, {
        issue: '25',
        interactive: true,
        stdin: answering('\r'),
        stdout,
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

    it('accepts pre-buffered y input', async () => {
      const { stdout } = outputStream();
      await expect(
        resolvePullRequest(undefined, {
          issue: '25',
          interactive: true,
          stdin: answering('y'),
          stdout,
          sources: discovered,
          info,
          warn,
        }),
      ).resolves.toMatchObject({ number: 184 });
    });

    it('refuses pre-buffered n input', async () => {
      const { stdout } = outputStream();
      await expect(
        resolvePullRequest(undefined, {
          issue: '25',
          interactive: true,
          stdin: answering('n'),
          stdout,
          sources: discovered,
          info,
          warn,
        }),
      ).rejects.toThrow(/Cancelled/);
    });

    it('refuses EOF instead of accepting the suggested yes', async () => {
      const stdin = answering('');
      const { stdout } = outputStream();
      const resolution = resolvePullRequest(undefined, {
        issue: '25',
        interactive: true,
        stdin,
        stdout,
        sources: discovered,
        info,
        warn,
      });
      stdin.end();

      await expect(resolution).rejects.toThrow(/Cancelled/);
    });

    it.each([
      ['Esc', '\u001b'],
      ['Ctrl+C', '\u0003'],
    ])('refuses %s cancellation', async (_label, key) => {
      const { stdout } = outputStream();
      await expect(
        resolvePullRequest(undefined, {
          issue: '25',
          interactive: true,
          stdin: answering(key),
          stdout,
          sources: discovered,
          info,
          warn,
        }),
      ).rejects.toThrow(/Cancelled/);
    });

    it('refuses an aborted confirmation', async () => {
      const stdin = answering('');
      const { stdout } = outputStream();
      const controller = new AbortController();
      const resolution = resolvePullRequest(undefined, {
        issue: '25',
        interactive: true,
        stdin,
        stdout,
        signal: controller.signal,
        sources: discovered,
        info,
        warn,
      });
      controller.abort();

      await expect(resolution).rejects.toThrow(/Cancelled/);
    });

    it('is skipped with --yes, logging the discovered number instead', async () => {
      const stdin = answering('n');
      const { stdout, written } = outputStream();
      const resolved = await resolvePullRequest(undefined, {
        issue: '25',
        yes: true,
        interactive: true,
        stdin,
        stdout,
        sources: discovered,
        info,
        warn,
      });

      expect(resolved.number).toBe(184);
      expect(info).toHaveBeenCalledWith(expect.stringContaining('#184'));
      expect(written()).toBe('');
    });

    it('never prompts for an explicit argument', async () => {
      const { stdout, written } = outputStream();
      const resolved = await resolvePullRequest('184', {
        issue: '25',
        interactive: true,
        stdin: answering('n'),
        stdout,
        sources: discovered,
        info,
        warn,
      });

      expect(resolved.source).toBe('argument');
      expect(written()).toBe('');
    });

    it.each([
      ['CI=1', true, true, '1'],
      ['non-TTY stdin', false, true, undefined],
      ['non-TTY stdout', true, false, undefined],
    ])('renders no prompt for %s and requires an explicit policy', async (_label, stdinTty, stdoutTty, ci) => {
      if (ci !== undefined) vi.stubEnv('CI', ci);
      else vi.stubEnv('CI', '');
      const stdin = answering('y', stdinTty);
      const { stdout, written } = outputStream(stdoutTty);

      await expect(
        resolvePullRequest(undefined, {
          issue: '25',
          stdin,
          stdout,
          sources: discovered,
          info,
          warn,
        }),
      ).rejects.toThrow(/--yes|specific Pull Request/);
      expect(written()).toBe('');
    });
  });
});
