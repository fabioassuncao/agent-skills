import { PassThrough, Writable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashIssueContent } from './hash.js';
import type { IssueProvider } from './provider.js';
import { clearProviders, registerProvider } from './registry.js';
import { IssueResolutionError, resolveIssue } from './resolver.js';
import type { Issue, IssueSource, IssuesConfig } from './types.js';

const BOTH: IssueSource[] = ['local', 'github'];

function makeIssue(source: IssueSource, title: string, body: string): Issue {
  return {
    id: '23',
    number: 23,
    title,
    body,
    labels: ['enhancement'],
    state: 'open',
    source,
    remoteRef: source === 'github' ? 'https://github.com/acme/repo/issues/23' : null,
    createdAt: '2026-08-01T10:00:00Z',
    updatedAt: source === 'github' ? '2026-08-02T10:00:00Z' : '2026-08-03T10:00:00Z',
    contentHash: hashIssueContent(title, body),
  };
}

interface FakeOptions {
  issue?: Issue | null;
  available?: boolean;
  getError?: Error;
}

function fakeProvider(name: IssueSource, options: FakeOptions = {}): IssueProvider {
  return {
    name,
    isAvailable: async () => options.available ?? true,
    get: async () => {
      if (options.getError) {
        throw options.getError;
      }
      return options.issue ?? null;
    },
    create: async () => {
      throw new Error('not implemented');
    },
  };
}

function makeConfig(overrides: Partial<IssuesConfig> = {}): IssuesConfig {
  return {
    defaultGenerateTarget: 'github',
    preferredProvider: 'github',
    conflictPolicy: 'ask',
    requireConfirmation: true,
    ...overrides,
  };
}

/** Discards everything Clack writes while prompting. */
function sinkStream(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

describe('resolveIssue', () => {
  let info: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearProviders();
    info = vi.fn();
    warn = vi.fn();
  });

  describe('single origin', () => {
    it('uses the local Issue when only local has it', async () => {
      const local = makeIssue('local', 'Local title', 'Local body');
      registerProvider(fakeProvider('local', { issue: local }));
      registerProvider(fakeProvider('github'));

      const resolved = await resolveIssue('23', {
        config: makeConfig(),
        sources: BOTH,
        info,
        warn,
      });

      expect(resolved.source).toBe('local');
      expect(resolved.issue).toBe(local);
      expect(resolved.github).toBeNull();
      expect(resolved.divergent).toBe(false);
    });

    it('uses the GitHub Issue when only GitHub has it, even if local is preferred', async () => {
      const github = makeIssue('github', 'Remote title', 'Remote body');
      registerProvider(fakeProvider('local'));
      registerProvider(fakeProvider('github', { issue: github }));

      const resolved = await resolveIssue('23', {
        config: makeConfig({ preferredProvider: 'local' }),
        sources: BOTH,
        info,
        warn,
      });

      expect(resolved.source).toBe('github');
      expect(resolved.issue).toBe(github);
      expect(resolved.local).toBeNull();
      expect(resolved.divergent).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    });

    it('skips an unavailable provider instead of failing', async () => {
      const local = makeIssue('local', 'Local title', 'Local body');
      registerProvider(fakeProvider('local', { issue: local }));
      registerProvider(fakeProvider('github', { available: false }));

      const resolved = await resolveIssue('23', {
        config: makeConfig(),
        sources: BOTH,
        info,
        warn,
      });

      expect(resolved.source).toBe('local');
    });

    it('warns and continues when one origin fails but the other answers', async () => {
      const local = makeIssue('local', 'Local title', 'Local body');
      registerProvider(fakeProvider('local', { issue: local }));
      registerProvider(fakeProvider('github', { getError: new Error('network unreachable') }));

      const resolved = await resolveIssue('23', {
        config: makeConfig(),
        sources: BOTH,
        info,
        warn,
      });

      expect(resolved.source).toBe('local');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('network unreachable'));
    });
  });

  describe('no origin', () => {
    it('throws IssueResolutionError with a non-zero exit code', async () => {
      registerProvider(fakeProvider('local'));
      registerProvider(fakeProvider('github'));

      const error = await resolveIssue('23', {
        config: makeConfig(),
        sources: BOTH,
        info,
        warn,
      }).catch((err) => err);

      expect(error).toBeInstanceOf(IssueResolutionError);
      expect((error as IssueResolutionError).exitCode).toBe(1);
      expect((error as IssueResolutionError).message).toContain("Issue '23' not found");
    });

    it('reports why each origin produced nothing', async () => {
      registerProvider(fakeProvider('local'));
      registerProvider(fakeProvider('github', { getError: new Error('gh auth required') }));

      const error = await resolveIssue('23', {
        config: makeConfig(),
        sources: BOTH,
        info,
        warn,
      }).catch((err) => err as IssueResolutionError);

      expect((error as IssueResolutionError).message).toContain('gh auth required');
      expect((error as IssueResolutionError).message).toContain('local: not found');
    });
  });

  describe('both origins with identical content', () => {
    beforeEach(() => {
      registerProvider(fakeProvider('local', { issue: makeIssue('local', 'Same', 'Same body') }));
      registerProvider(fakeProvider('github', { issue: makeIssue('github', 'Same', 'Same body') }));
    });

    it('reports the equivalence and follows the preferred provider', async () => {
      const resolved = await resolveIssue('23', {
        config: makeConfig({ preferredProvider: 'github' }),
        sources: BOTH,
        info,
        warn,
      });

      expect(resolved.source).toBe('github');
      expect(resolved.divergent).toBe(false);
      expect(info).toHaveBeenCalledWith(expect.stringContaining('identical content'));
    });

    it('never prompts, even with conflictPolicy ask on a TTY', async () => {
      const stdin = new PassThrough();
      const resolved = await resolveIssue('23', {
        config: makeConfig({ preferredProvider: 'local', conflictPolicy: 'ask' }),
        sources: BOTH,
        interactive: true,
        stdin,
        stdout: sinkStream(),
        info,
        warn,
      });

      expect(resolved.source).toBe('local');
      expect(resolved.divergent).toBe(false);
    });
  });

  describe('both origins with divergent content', () => {
    beforeEach(() => {
      registerProvider(
        fakeProvider('local', { issue: makeIssue('local', 'Local title', 'Local body') }),
      );
      registerProvider(
        fakeProvider('github', { issue: makeIssue('github', 'Remote title', 'Remote body') }),
      );
    });

    it('reports the divergence with both versions', async () => {
      await resolveIssue('23', {
        config: makeConfig({ conflictPolicy: 'prefer-github' }),
        sources: BOTH,
        info,
        warn,
      });

      const reported = info.mock.calls.map((call) => call[0] as string).join('\n');
      expect(reported).toContain('differs between origins');
      expect(reported).toContain('Local title');
      expect(reported).toContain('Remote title');
    });

    it('prefer-local uses the local version without prompting', async () => {
      const resolved = await resolveIssue('23', {
        config: makeConfig({ conflictPolicy: 'prefer-local' }),
        sources: BOTH,
        interactive: true,
        stdin: new PassThrough(),
        stdout: sinkStream(),
        info,
        warn,
      });

      expect(resolved.source).toBe('local');
      expect(resolved.divergent).toBe(true);
    });

    it('prefer-github uses the remote version without prompting', async () => {
      const resolved = await resolveIssue('23', {
        config: makeConfig({ conflictPolicy: 'prefer-github', preferredProvider: 'local' }),
        sources: BOTH,
        interactive: true,
        stdin: new PassThrough(),
        stdout: sinkStream(),
        info,
        warn,
      });

      expect(resolved.source).toBe('github');
      expect(resolved.divergent).toBe(true);
    });

    it('falls back to the preferred provider outside a TTY, with a warning', async () => {
      const resolved = await resolveIssue('23', {
        config: makeConfig({ conflictPolicy: 'ask', preferredProvider: 'github' }),
        sources: BOTH,
        interactive: false,
        info,
        warn,
      });

      expect(resolved.source).toBe('github');
      expect(resolved.divergent).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('non-interactive'));
    });

    it('honours preferredProvider local in a non-interactive environment', async () => {
      const resolved = await resolveIssue('23', {
        config: makeConfig({ conflictPolicy: 'ask', preferredProvider: 'local' }),
        sources: BOTH,
        interactive: false,
        info,
        warn,
      });

      expect(resolved.source).toBe('local');
    });

    describe('interactive prompt', () => {
      function answer(input: string): PassThrough {
        const stdin = new PassThrough();
        stdin.write(input);
        return stdin;
      }

      it('an arrow key selects the local version from the preferred GitHub option', async () => {
        const resolved = await resolveIssue('23', {
          config: makeConfig({ conflictPolicy: 'ask' }),
          sources: BOTH,
          interactive: true,
          stdin: answer('\u001b[A\r'),
          stdout: sinkStream(),
          info,
          warn,
        });

        expect(resolved.source).toBe('local');
        expect(resolved.divergent).toBe(true);
      });

      it('Enter selects the initially preferred local version', async () => {
        const resolved = await resolveIssue('23', {
          config: makeConfig({ conflictPolicy: 'ask', preferredProvider: 'local' }),
          sources: BOTH,
          interactive: true,
          stdin: answer('\r'),
          stdout: sinkStream(),
          info,
          warn,
        });

        expect(resolved.source).toBe('local');
      });

      it('the explicit cancel option exits with a non-zero code', async () => {
        const error = await resolveIssue('23', {
          config: makeConfig({ conflictPolicy: 'ask' }),
          sources: BOTH,
          interactive: true,
          stdin: answer('\u001b[B\r'),
          stdout: sinkStream(),
          info,
          warn,
        }).catch((err) => err as IssueResolutionError);

        expect(error).toBeInstanceOf(IssueResolutionError);
        expect((error as IssueResolutionError).exitCode).not.toBe(0);
        expect((error as IssueResolutionError).message).toContain('Cancelled');
      });

      it('does not interpret numeric line input as a supported selection', async () => {
        const stdin = new PassThrough();
        stdin.write('2\n');
        setImmediate(() => stdin.write('\u001b'));

        const error = await resolveIssue('23', {
          config: makeConfig({ conflictPolicy: 'ask', preferredProvider: 'local' }),
          sources: BOTH,
          interactive: true,
          stdin,
          stdout: sinkStream(),
          info,
          warn,
        }).catch((err) => err as IssueResolutionError);

        expect(error).toBeInstanceOf(IssueResolutionError);
        expect(error.message).toContain('Cancelled');
      });

      it('cancels when stdin closes without an answer', async () => {
        const stdin = new PassThrough();
        stdin.end();

        const error = await resolveIssue('23', {
          config: makeConfig({ conflictPolicy: 'ask' }),
          sources: BOTH,
          interactive: true,
          stdin,
          stdout: sinkStream(),
          info,
          warn,
        }).catch((err) => err as IssueResolutionError);

        expect(error).toBeInstanceOf(IssueResolutionError);
        expect((error as IssueResolutionError).message).toContain('Cancelled');
      });

      it('cancels when the injected signal aborts', async () => {
        const stdin = new PassThrough();
        const controller = new AbortController();
        const resolution = resolveIssue('23', {
          config: makeConfig({ conflictPolicy: 'ask' }),
          sources: BOTH,
          interactive: true,
          stdin,
          stdout: sinkStream(),
          signal: controller.signal,
          info,
          warn,
        });
        controller.abort();

        await expect(resolution).rejects.toThrow(/Cancelled/);
      });
    });
  });

  /**
   * The matrix is written against the origins that answered, not against the
   * two built-in ones, so a provider registered from outside takes part in it
   * like any other.
   */
  describe('origins beyond the built-in two', () => {
    const THREE: IssueSource[] = ['local', 'github', 'memory'];

    it('uses a third origin when it is the only one with the Issue', async () => {
      const memory = makeIssue('memory', 'From memory', 'Body');
      registerProvider(fakeProvider('local'));
      registerProvider(fakeProvider('github'));
      registerProvider(fakeProvider('memory', { issue: memory }));

      const resolved = await resolveIssue('23', {
        config: makeConfig(),
        sources: THREE,
        info,
        warn,
      });

      expect(resolved.source).toBe('memory');
      expect(resolved.issue).toBe(memory);
      expect(resolved.divergent).toBe(false);
    });

    it('reports every divergent origin, not just local and GitHub', async () => {
      registerProvider(fakeProvider('local', { issue: makeIssue('local', 'Local', 'A') }));
      registerProvider(fakeProvider('github', { issue: makeIssue('github', 'Remote', 'B') }));
      registerProvider(fakeProvider('memory', { issue: makeIssue('memory', 'Memory', 'C') }));

      const resolved = await resolveIssue('23', {
        config: makeConfig({ conflictPolicy: 'prefer-github' }),
        sources: THREE,
        info,
        warn,
      });

      expect(resolved.source).toBe('github');
      const reported = info.mock.calls.map((call) => call[0] as string).join('\n');
      expect(reported).toContain('Memory');
    });

    it('the prompt lists and can select every origin that answered', async () => {
      registerProvider(fakeProvider('local', { issue: makeIssue('local', 'Local', 'A') }));
      registerProvider(fakeProvider('github', { issue: makeIssue('github', 'Remote', 'B') }));
      registerProvider(fakeProvider('memory', { issue: makeIssue('memory', 'Memory', 'C') }));

      const asked: string[] = [];
      const stdout = new Writable({
        write(chunk, _encoding, callback) {
          asked.push(String(chunk));
          callback();
        },
      });
      const stdin = new PassThrough();
      stdin.write('\u001b[B\r');

      const resolved = await resolveIssue('23', {
        config: makeConfig({ conflictPolicy: 'ask' }),
        sources: THREE,
        interactive: true,
        stdin,
        stdout,
        info,
        warn,
      });

      expect(resolved.source).toBe('memory');
      expect(asked.join('')).toContain('Memory');
      expect(asked.join('')).toContain('Cancel');
    });

    it('can select an external provider named cancel without cancelling', async () => {
      const sources: IssueSource[] = ['local', 'github', 'cancel'];
      registerProvider(fakeProvider('local', { issue: makeIssue('local', 'Local', 'A') }));
      registerProvider(fakeProvider('github', { issue: makeIssue('github', 'Remote', 'B') }));
      registerProvider(fakeProvider('cancel', { issue: makeIssue('cancel', 'External', 'C') }));
      const stdin = new PassThrough();
      stdin.write('\u001b[B\r');

      const resolved = await resolveIssue('23', {
        config: makeConfig({ conflictPolicy: 'ask' }),
        sources,
        interactive: true,
        stdin,
        stdout: sinkStream(),
        info,
        warn,
      });

      expect(resolved.source).toBe('cancel');
      expect(resolved.issue.title).toBe('External');
    });

    it('warns when the conflict policy names an origin that has no version', async () => {
      registerProvider(fakeProvider('local'));
      registerProvider(fakeProvider('github', { issue: makeIssue('github', 'Remote', 'B') }));
      registerProvider(fakeProvider('memory', { issue: makeIssue('memory', 'Memory', 'C') }));

      const resolved = await resolveIssue('23', {
        config: makeConfig({ conflictPolicy: 'prefer-local', preferredProvider: 'github' }),
        sources: THREE,
        info,
        warn,
      });

      // Silently picking under the name of an origin that has nothing would be
      // the one thing the resolver must never do.
      expect(resolved.source).toBe('github');
      expect(resolved.divergent).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('does not apply'));
    });

    it('identical content across three origins never prompts', async () => {
      registerProvider(fakeProvider('local', { issue: makeIssue('local', 'Same', 'Body') }));
      registerProvider(fakeProvider('github', { issue: makeIssue('github', 'Same', 'Body') }));
      registerProvider(fakeProvider('memory', { issue: makeIssue('memory', 'Same', 'Body') }));

      const resolved = await resolveIssue('23', {
        config: makeConfig({ preferredProvider: 'local', conflictPolicy: 'ask' }),
        sources: THREE,
        interactive: true,
        stdin: new PassThrough(),
        stdout: sinkStream(),
        info,
        warn,
      });

      expect(resolved.source).toBe('local');
      expect(resolved.divergent).toBe(false);
      expect(info).toHaveBeenCalledWith(expect.stringContaining('local, GitHub and memory'));
    });
  });
});

describe('an origin that needs a human (US-014)', () => {
  beforeEach(() => {
    clearProviders();
  });

  const unauthenticated: IssueProvider = {
    name: 'github',
    isAvailable: async () => false,
    checkAvailability: async () => ({
      available: false,
      failure: {
        kind: 'authentication',
        message: 'gh: Bad credentials',
        retryable: false,
        source: 'github',
      },
      action: 'Run `gh auth login` to authenticate the GitHub CLI',
    }),
    get: async () => null,
    create: async () => {
      throw new Error('not implemented');
    },
  };

  it('is reported as itself, not as a missing Issue', async () => {
    registerProvider(unauthenticated);
    registerProvider(fakeProvider('local', { issue: null }));

    const error = await resolveIssue('23', { sources: BOTH, config: makeConfig() }).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(IssueResolutionError);
    const resolution = error as IssueResolutionError;
    expect(resolution.message).toContain("Cannot read issue '23' from GitHub");
    expect(resolution.message).toContain('Bad credentials');
    expect(resolution.failure?.kind).toBe('authentication');
    expect(resolution.action).toBe('Run `gh auth login` to authenticate the GitHub CLI');
  });

  it('never wins over an origin that actually has the Issue', async () => {
    registerProvider(unauthenticated);
    const issue = makeIssue('local', 'Local title', 'Local body');
    registerProvider(fakeProvider('local', { issue }));

    const resolved = await resolveIssue('23', { sources: BOTH, config: makeConfig() });

    expect(resolved.source).toBe('local');
  });

  it('leaves a transient unavailability as a plain miss, with no action', async () => {
    registerProvider({
      name: 'github',
      isAvailable: async () => false,
      checkAvailability: async () => ({
        available: false,
        failure: {
          kind: 'network',
          message: 'dial tcp: lookup api.github.com: no such host',
          retryable: true,
          source: 'github',
        },
      }),
      get: async () => null,
      create: async () => {
        throw new Error('not implemented');
      },
    });
    registerProvider(fakeProvider('local', { issue: null }));

    const error = await resolveIssue('23', { sources: BOTH, config: makeConfig() }).catch(
      (err: unknown) => err,
    );

    const resolution = error as IssueResolutionError;
    expect(resolution.message).toContain('not found in any registered origin');
    // The classified reason replaces the flat "provider unavailable".
    expect(resolution.message).toContain('no such host');
    expect(resolution.action).toBeUndefined();
  });
});

/**
 * An origin may own an identifier namespace no other one could produce — the
 * `inline-<hash>` of §17 is minted by Issue Flow itself. `claims()` lets it say
 * so, and the resolver then leaves every other origin alone.
 */
describe('an origin that claims its own identifiers', () => {
  const info = vi.fn();
  const warn = vi.fn();

  beforeEach(() => {
    clearProviders();
    info.mockClear();
    warn.mockClear();
  });

  it('queries only the claimant, sparing the other origins a round-trip', async () => {
    const asked: IssueSource[] = [];
    const watched = (name: IssueSource): IssueProvider => ({
      ...fakeProvider(name, { issue: null }),
      get: async () => {
        asked.push(name);
        return null;
      },
    });
    registerProvider(watched('github'));
    registerProvider(watched('local'));
    const mine = makeIssue('inline', 'Typed demand', 'Body');
    registerProvider({
      ...fakeProvider('inline', { issue: { ...mine, id: 'inline-abcdef012345' } }),
      claims: (id) => id.startsWith('inline-'),
      get: async () => {
        asked.push('inline');
        return { ...mine, id: 'inline-abcdef012345', source: 'inline' };
      },
    });

    const resolved = await resolveIssue('inline-abcdef012345', {
      config: makeConfig(),
      info,
      warn,
    });

    expect(resolved.source).toBe('inline');
    expect(asked).toEqual(['inline']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('changes nothing for an identifier nobody claims', async () => {
    const asked: IssueSource[] = [];
    const watched = (name: IssueSource): IssueProvider => ({
      ...fakeProvider(name, { issue: null }),
      get: async () => {
        asked.push(name);
        return null;
      },
    });
    registerProvider(watched('github'));
    registerProvider({
      ...watched('inline'),
      claims: (id) => id.startsWith('inline-'),
    });

    await resolveIssue('23', { config: makeConfig(), info, warn }).catch(() => null);

    expect(asked.sort()).toEqual(['github', 'inline']);
  });

  it('treats a claims() that throws as no claim rather than as a missing Issue', async () => {
    const issue = makeIssue('github', 'GitHub title', 'Body');
    registerProvider(fakeProvider('github', { issue }));
    registerProvider({
      ...fakeProvider('inline', { issue: null }),
      claims: () => {
        throw new Error('boom');
      },
    });

    const resolved = await resolveIssue('23', { config: makeConfig(), info, warn });
    expect(resolved.source).toBe('github');
  });
});
