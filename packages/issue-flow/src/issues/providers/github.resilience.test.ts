import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The network-policy half of the GitHub provider, tested through the real
 * `run()` — only `execa` is mocked.
 *
 * Mocking the shell layer, as `github.test.ts` does, would skip the very thing
 * under test: the classification and the retry live in `utils/shell.ts`, and a
 * test that stubs them proves nothing about a DNS blip.
 */
vi.mock('execa', () => ({ execa: vi.fn() }));

vi.mock('../../resilience/policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../resilience/policy.js')>();
  return { ...actual, abortableDelay: vi.fn(async () => true) };
});

const { execa } = await import('execa');
const { abortableDelay } = await import('../../resilience/policy.js');
const { setActiveResilienceConfig } = await import('../../config.js');
const { GitHubIssueProvider } = await import('./github.js');

const mockExeca = vi.mocked(execa);
const mockDelay = vi.mocked(abortableDelay);

function ok(stdout: string) {
  return { stdout, stderr: '', exitCode: 0 } as unknown as ReturnType<typeof execa>;
}

function failure(stderr: string, overrides: Record<string, unknown> = {}) {
  return {
    stdout: '',
    stderr,
    exitCode: 1,
    failed: true,
    ...overrides,
  } as unknown as ReturnType<typeof execa>;
}

/** What `gh` prints when the network is gone: a Go resolver error. */
const DNS_DOWN =
  'error connecting to api.github.com: dial tcp: lookup api.github.com: no such host';

const ISSUE_JSON = JSON.stringify({
  number: 42,
  title: 'Survive a short outage',
  body: 'body',
  labels: [],
  state: 'OPEN',
  url: 'https://github.com/acme/repo/issues/42',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-02T00:00:00Z',
});

/**
 * The base table jitters in full (`random(0, ceiling)`), so the assertion is
 * the *ceiling* sequence, not an equality: `computeDelayMs` is where the exact
 * curve is asserted with an injected RNG. What matters here is that a caller
 * never waits longer than the policy allows.
 */
function expectWithinCeilings(waited: number[], ceilings: number[]): void {
  expect(waited).toHaveLength(ceilings.length);
  for (const [index, ceiling] of ceilings.entries()) {
    expect(waited[index]).toBeGreaterThanOrEqual(0);
    expect(waited[index]).toBeLessThanOrEqual(ceiling);
  }
}

const waitedMs = (): number[] => mockDelay.mock.calls.map(([ms]) => ms);

let provider: GitHubIssueProvider;

beforeEach(() => {
  mockExeca.mockReset();
  mockDelay.mockClear();
  mockDelay.mockImplementation(async () => true);
  setActiveResilienceConfig({});
  provider = new GitHubIssueProvider();
});

describe('a short network outage', () => {
  it('survives two failed gh calls and reads the Issue on the third', async () => {
    mockExeca
      .mockResolvedValueOnce(failure(DNS_DOWN))
      .mockResolvedValueOnce(failure(DNS_DOWN))
      .mockResolvedValueOnce(ok(ISSUE_JSON));

    const issue = await provider.get('42');

    expect(issue).toMatchObject({ id: '42', number: 42, source: 'github' });
    expect(mockExeca).toHaveBeenCalledTimes(3);
    // The `network` row of the base table: a 2s ceiling, then 4s.
    expectWithinCeilings(waitedMs(), [2_000, 4_000]);
  });

  it('does not report GitHub as unavailable over a blip in the probes', async () => {
    mockExeca
      .mockResolvedValueOnce(failure(DNS_DOWN)) // gh --version, attempt 1
      .mockResolvedValueOnce(ok('gh version 2.0.0')) // attempt 2
      .mockResolvedValueOnce(failure(DNS_DOWN)) // gh auth status, attempt 1
      .mockResolvedValueOnce(ok('Logged in')); // attempt 2

    await expect(provider.checkAvailability()).resolves.toEqual({ available: true });
    expect(mockExeca).toHaveBeenCalledTimes(4);
  });

  it('caps the probe budget so an unreachable GitHub does not stall a local Issue', async () => {
    mockExeca.mockResolvedValue(failure(DNS_DOWN));

    const availability = await provider.checkAvailability();

    expect(availability.available).toBe(false);
    expect(availability.failure?.kind).toBe('network');
    // Three attempts, not the eight the full `network` policy grants, and no
    // action: waiting is exactly what would fix this one.
    expect(mockExeca).toHaveBeenCalledTimes(3);
    expect(availability.action).toBeUndefined();
    expectWithinCeilings(waitedMs(), [2_000, 4_000]);
  });
});

describe('a network that never comes back', () => {
  it('fails with a clear error after a bounded number of attempts', async () => {
    mockExeca.mockResolvedValue(failure(DNS_DOWN));

    await expect(provider.get('42')).rejects.toThrow(/Failed to fetch GitHub issue #42/);

    // The `network` budget of the default profile — eight attempts, not an
    // infinite loop. `retryForever` belongs to the `continuous` profile only.
    expect(mockExeca).toHaveBeenCalledTimes(8);
  });

  it('honours retryForever only when the continuous profile asks for it', async () => {
    setActiveResilienceConfig({ profile: 'continuous' });
    mockExeca.mockResolvedValue(failure(DNS_DOWN));
    // The loop would never end under `retryForever`; the abort is the exit.
    mockDelay.mockImplementation(async () => false);

    await expect(provider.get('42')).rejects.toThrow(/Failed to fetch GitHub issue #42/);
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it('never waits longer than the ceiling of the policy', async () => {
    mockExeca.mockResolvedValue(failure(DNS_DOWN));

    await expect(provider.get('42')).rejects.toThrow();

    // Seven waits for eight attempts, doubling until `maxDelayMs` (120s) caps
    // them — the ceiling holds even though every draw is jittered below it.
    expectWithinCeilings(waitedMs(), [2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 120_000]);
  });
});

describe('an authentication failure', () => {
  const AUTH_ERROR = 'gh: To get started with GitHub CLI, please run: gh auth login';

  it('is never retried, and comes back with the action to take', async () => {
    mockExeca
      .mockResolvedValueOnce(ok('gh version 2.0.0'))
      .mockResolvedValueOnce(failure(AUTH_ERROR));

    const availability = await provider.checkAvailability();

    expect(availability).toMatchObject({
      available: false,
      action: 'Run `gh auth login` to authenticate the GitHub CLI',
      failure: { kind: 'authentication', retryable: false },
    });
    // Two calls: the version probe and one — exactly one — auth probe.
    expect(mockExeca).toHaveBeenCalledTimes(2);
    expect(mockDelay).not.toHaveBeenCalled();
  });

  it('is not retried even under the continuous profile with retryForever', async () => {
    setActiveResilienceConfig({
      profile: 'continuous',
      retry: { authentication: { maxAttempts: 99, retryForever: true } },
    });
    mockExeca.mockResolvedValue(failure(AUTH_ERROR));

    await expect(provider.get('42')).rejects.toThrow(/Failed to fetch GitHub issue #42/);
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it('carries the classification through the throw, with the action', async () => {
    mockExeca.mockResolvedValue(failure(AUTH_ERROR));

    const error = await provider.get('42').catch((err: unknown) => err);

    const { actionOf, failureOf } = await import('../../resilience/errors.js');
    expect(failureOf(error)?.kind).toBe('authentication');
    expect(actionOf(error)).toBe('Run `gh auth login` to authenticate the GitHub CLI');
  });
});

describe('a GitHub rate limit', () => {
  it('waits exactly what the server asked for', async () => {
    mockExeca
      .mockResolvedValueOnce(
        failure('gh: API rate limit exceeded for user. Retry-After: 42', { exitCode: 1 }),
      )
      .mockResolvedValueOnce(ok(ISSUE_JSON));

    await expect(provider.get('42')).resolves.toMatchObject({ id: '42' });

    // Not the 60s the `rate_limit` row would have chosen: `Retry-After` wins
    // outright, un-jittered and uncapped.
    expect(waitedMs()).toEqual([42_000]);
  });

  it('falls back to the rate_limit budget when the server said nothing', async () => {
    // Jitter off so the number is assertable; the 60s is the base table's.
    setActiveResilienceConfig({ retry: { rateLimit: { jitter: 'none' } } });
    mockExeca
      .mockResolvedValueOnce(failure('gh: API rate limit exceeded for user'))
      .mockResolvedValueOnce(ok(ISSUE_JSON));

    await expect(provider.get('42')).resolves.toMatchObject({ id: '42' });
    expect(waitedMs()).toEqual([60_000]);
  });

  it('reads the budget from the resilience key when the project configured one', async () => {
    setActiveResilienceConfig({ retry: { rateLimit: { initialDelayMs: 5_000, jitter: 'none' } } });
    mockExeca
      .mockResolvedValueOnce(failure('gh: API rate limit exceeded for user'))
      .mockResolvedValueOnce(ok(ISSUE_JSON));

    await expect(provider.get('42')).resolves.toMatchObject({ id: '42' });
    expect(waitedMs()).toEqual([5_000]);
  });
});

describe('an Issue that simply does not exist', () => {
  it('is not a failure, and is not retried', async () => {
    mockExeca.mockResolvedValue(failure('GraphQL: Could not resolve to an Issue with the number'));

    await expect(provider.get('999')).resolves.toBeNull();
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });
});
