import { describe, expect, it } from 'vitest';
import {
  classify,
  type FailureKind,
  type FailureSignal,
  isRetryableKind,
  requiresHumanAction,
} from './errors.js';

/**
 * The contract of this module *is* the table: one realistic signal per row,
 * and the kind it must resolve to. A new classification rule earns a row here
 * before it earns a line of code.
 */
const TABLE: readonly {
  name: string;
  signal: FailureSignal;
  kind: FailureKind;
  retryable: boolean;
}[] = [
  // ── step 1: errno wins over everything ──────────────────────────────────
  {
    name: 'ENOTFOUND is a network failure',
    signal: { source: 'github', errno: 'ENOTFOUND', exitCode: 1 },
    kind: 'network',
    retryable: true,
  },
  {
    name: 'EAI_AGAIN is a network failure',
    signal: { source: 'git', errno: 'EAI_AGAIN' },
    kind: 'network',
    retryable: true,
  },
  {
    name: 'ETIMEDOUT is a timeout, not a network failure',
    signal: { source: 'github', errno: 'ETIMEDOUT' },
    kind: 'timeout',
    retryable: true,
  },
  {
    name: 'ENOENT — the binary is not installed — is configuration',
    signal: { source: 'agent', errno: 'ENOENT', exitCode: 127 },
    kind: 'configuration',
    retryable: false,
  },
  {
    name: 'errno outranks a text pattern that says otherwise',
    signal: { source: 'github', errno: 'ECONNRESET', stderr: 'tests failed' },
    kind: 'network',
    retryable: true,
  },

  // ── step 2: HTTP status ─────────────────────────────────────────────────
  {
    name: 'HTTP 429 is a rate limit',
    signal: { source: 'github', httpStatus: 429, retryAfter: 60 },
    kind: 'rate_limit',
    retryable: true,
  },
  {
    name: 'HTTP 503 is a provider that is down',
    signal: { source: 'agent', httpStatus: 503, stderr: 'Service overloaded' },
    kind: 'provider_down',
    retryable: true,
  },
  {
    name: 'HTTP 401 is an authentication failure',
    signal: { source: 'github', httpStatus: 401 },
    kind: 'authentication',
    retryable: false,
  },
  {
    name: "HTTP 403 is authentication when it is not GitHub's secondary rate limit",
    signal: { source: 'github', httpStatus: 403, stderr: 'Resource not accessible' },
    kind: 'authentication',
    retryable: false,
  },
  {
    name: 'HTTP 403 naming a rate limit is a rate limit',
    signal: {
      source: 'github',
      httpStatus: 403,
      stderr: 'You have exceeded a secondary rate limit',
    },
    kind: 'rate_limit',
    retryable: true,
  },
  {
    name: 'HTTP 404 is configuration',
    signal: { source: 'github', httpStatus: 404, stderr: 'Could not resolve to a Repository' },
    kind: 'configuration',
    retryable: false,
  },
  {
    name: 'a 2xx status decides nothing and falls through to the text',
    signal: { source: 'github', httpStatus: 200, stderr: 'connection reset by peer' },
    kind: 'network',
    retryable: true,
  },

  // ── step 3: how the process ended ───────────────────────────────────────
  {
    name: 'exitCode 143 with timedOut is a timeout',
    signal: { source: 'agent', exitCode: 143, timedOut: true },
    kind: 'timeout',
    retryable: true,
  },
  {
    name: 'a SIGTERM with no timedOut flag is still a timeout',
    signal: { source: 'agent', exitCode: 143, signal: 'SIGTERM' },
    kind: 'timeout',
    retryable: true,
  },
  {
    name: 'a SIGKILL the watchdog did not ask for is a provider crash',
    signal: { source: 'agent', exitCode: 137, signal: 'SIGKILL' },
    kind: 'provider_crash',
    retryable: true,
  },
  {
    name: 'the watchdog flag makes a stall a stall, not a timeout',
    signal: { source: 'agent', stalled: true, timedOut: true },
    kind: 'stalled',
    retryable: true,
  },

  // ── step 4: exit codes we know the meaning of ───────────────────────────
  {
    name: 'exit code 75 (EX_TEMPFAIL) is a provider that is down',
    signal: { source: 'agent', exitCode: 75 },
    kind: 'provider_down',
    retryable: true,
  },
  {
    name: 'exit code 127 is configuration',
    signal: { source: 'agent', exitCode: 127 },
    kind: 'configuration',
    retryable: false,
  },
  {
    name: 'a bare 143 decides nothing — Ctrl+C and our timeout leave the same code',
    signal: { source: 'agent', exitCode: 143, stderr: 'claude exited with code 143' },
    kind: 'unknown',
    retryable: false,
  },

  // ── step 5: text, the last resort ───────────────────────────────────────
  {
    name: 'an overloaded provider is provider_down',
    signal: { source: 'agent', exitCode: 1, stderr: 'API Error: the model is overloaded' },
    kind: 'provider_down',
    retryable: true,
  },
  {
    name: 'a DNS failure as gh actually prints it is a network failure',
    signal: {
      source: 'github',
      exitCode: 1,
      stderr: 'error connecting to api.github.com: dial tcp: lookup api.github.com: no such host',
    },
    kind: 'network',
    retryable: true,
  },
  {
    name: 'a Go i/o timeout from gh is a network failure',
    signal: { source: 'github', exitCode: 1, stderr: 'Post "https://api.github.com": i/o timeout' },
    kind: 'network',
    retryable: true,
  },
  {
    name: 'an agent that went silent is stalled, not merely timed out',
    signal: {
      source: 'agent',
      exitCode: 143,
      stderr: 'claude produced no output for 600s and was stopped (stalled)',
    },
    kind: 'stalled',
    retryable: true,
  },
  {
    name: 'an expired gh credential is an authentication failure',
    signal: {
      source: 'github',
      exitCode: 1,
      stderr: 'gh: To get started with GitHub CLI, please run: gh auth login',
    },
    kind: 'authentication',
    retryable: false,
  },
  {
    name: 'a broken test suite is task_execution',
    signal: {
      source: 'agent',
      exitCode: 1,
      stdout: 'Test Files 1 failed (12)\n Tests 3 failed | 41 passed',
    },
    kind: 'task_execution',
    retryable: false,
  },
  {
    name: 'a network failure surfacing inside a test run is still a network failure',
    signal: {
      source: 'agent',
      exitCode: 1,
      stdout: 'Tests failed: getaddrinfo ENOTFOUND registry.npmjs.org',
    },
    kind: 'network',
    retryable: true,
  },
  {
    name: 'a repository mid-merge is repository_state',
    signal: { source: 'git', exitCode: 1, stderr: 'error: you have unmerged paths.' },
    kind: 'repository_state',
    retryable: false,
  },
  {
    name: 'an unreadable failure is unknown, and unknown is not retried',
    signal: { source: 'agent', exitCode: 1, stderr: 'SyntaxError: Unexpected token' },
    kind: 'task_execution',
    retryable: false,
  },
  {
    name: 'a signal with nothing in it at all is unknown',
    signal: { source: 'internal' },
    kind: 'unknown',
    retryable: false,
  },
];

describe('classify — the taxonomy table', () => {
  for (const row of TABLE) {
    it(row.name, () => {
      const failure = classify(row.signal);
      expect(failure.kind).toBe(row.kind);
      expect(failure.retryable).toBe(row.retryable);
      expect(failure.source).toBe(row.signal.source);
    });
  }
});

describe('classify — precedence', () => {
  it('prefers errno over the HTTP status', () => {
    expect(classify({ source: 'github', errno: 'ECONNRESET', httpStatus: 401 }).kind).toBe(
      'network',
    );
  });

  it('prefers the HTTP status over how the process ended', () => {
    expect(classify({ source: 'github', httpStatus: 429, timedOut: true }).kind).toBe('rate_limit');
  });

  it('prefers how the process ended over a known exit code', () => {
    expect(classify({ source: 'agent', exitCode: 75, timedOut: true }).kind).toBe('timeout');
  });

  it('prefers a known exit code over the text', () => {
    expect(classify({ source: 'agent', exitCode: 75, stderr: 'tests failed' }).kind).toBe(
      'provider_down',
    );
  });
});

describe('classify — retryAfterMs', () => {
  it('carries the Retry-After the server sent, in milliseconds', () => {
    const failure = classify({ source: 'github', httpStatus: 429, retryAfter: 60 });
    expect(failure.kind).toBe('rate_limit');
    expect(failure.retryAfterMs).toBe(60_000);
  });

  it('accepts Retry-After as a string of seconds', () => {
    expect(classify({ source: 'github', httpStatus: 429, retryAfter: '120' }).retryAfterMs).toBe(
      120_000,
    );
  });

  it('accepts Retry-After as an HTTP date, against an injected clock', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const failure = classify(
      { source: 'github', httpStatus: 503, retryAfter: 'Thu, 01 Jan 2026 00:02:00 GMT' },
      { now: () => now },
    );
    expect(failure.retryAfterMs).toBe(120_000);
  });

  it('ignores a Retry-After date already in the past', () => {
    const now = Date.parse('2026-01-01T00:10:00Z');
    const failure = classify(
      { source: 'github', httpStatus: 503, retryAfter: 'Thu, 01 Jan 2026 00:02:00 GMT' },
      { now: () => now },
    );
    expect(failure.retryAfterMs).toBeUndefined();
  });

  it('falls back to a Retry-After spelled out in the output', () => {
    const failure = classify({
      source: 'github',
      exitCode: 1,
      stderr: 'API rate limit exceeded. Retry after: 30 seconds',
    });
    expect(failure.kind).toBe('rate_limit');
    expect(failure.retryAfterMs).toBe(30_000);
  });

  it('omits retryAfterMs entirely when the server said nothing', () => {
    expect(classify({ source: 'github', httpStatus: 429 })).not.toHaveProperty('retryAfterMs');
  });
});

describe('classify — message', () => {
  it('keeps the output verbatim, stderr first', () => {
    const failure = classify({ source: 'agent', stderr: 'boom', stdout: 'context' });
    expect(failure.message).toBe('boom\ncontext');
  });

  it('synthesises a line when there is no output at all', () => {
    expect(classify({ source: 'agent', exitCode: 2 }).message).toBe('agent exited with code 2');
    expect(classify({ source: 'github', errno: 'ENOTFOUND' }).message).toBe(
      'github failed with ENOTFOUND',
    );
    expect(classify({ source: 'internal' }).message).toBe(
      'internal failed for an unreported reason',
    );
  });
});

describe('the golden rule', () => {
  it('never marks task_execution retryable', () => {
    expect(isRetryableKind('task_execution')).toBe(false);
    expect(requiresHumanAction('task_execution')).toBe(true);
  });

  it('keeps every failure that only a human can fix out of the retryable set', () => {
    for (const kind of [
      'authentication',
      'configuration',
      'repository_state',
      'task_execution',
    ] as const) {
      expect(requiresHumanAction(kind)).toBe(true);
      expect(isRetryableKind(kind)).toBe(false);
    }
  });

  it('leaves internal and unknown unretried — the conservative default of today', () => {
    expect(isRetryableKind('internal')).toBe(false);
    expect(isRetryableKind('unknown')).toBe(false);
  });
});
