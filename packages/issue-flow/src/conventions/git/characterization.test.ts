import { describe, expect, it } from 'vitest';
import { autoNameBranch, generateFallbackBranchName } from './auto-name.js';
import { branchName, resolveBranchName } from './branch.js';
import { resolveChangeType } from './change-type.js';
import { commitMessage } from './commit.js';
import { issueReferenceLines, pullRequestTitle } from './pull-request.js';

/**
 * Characterization tests G1–G11 of the WebMux absorption (§34).
 *
 * They are the acceptance contract of the Git-convention phase: the pair
 * "input → expected output" was fixed before any production code changed, so a
 * regression is distinguishable from a deliberate reduction of policy.
 *
 * G4–G7 depend on repository discovery and live next to that code, in
 * `src/policy/characterization.test.ts`.
 */

describe('G1 — issue with a known number and type', () => {
  it('produces {type}/{N}-{slug}', () => {
    const change = resolveChangeType({ labels: ['enhancement'] });
    expect(change).toEqual({ type: 'feat', source: 'label' });
    expect(
      branchName({
        type: change.type,
        issueNumber: 63,
        title: 'Execução autônoma resiliente',
      }),
    ).toBe('feat/63-execucao-autonoma-resiliente');
  });

  it('falls back to feat when the repository declares no mapping for the issue', () => {
    const change = resolveChangeType({ labels: [] });
    expect(change).toEqual({ type: 'feat', source: 'fallback' });
    expect(branchName({ type: change.type, issueNumber: 63, title: 'Dark mode' })).toBe(
      'feat/63-dark-mode',
    );
  });
});

describe('G2 — free description, no issue', () => {
  it('generates a kebab-case name of at most 40 characters, with no prefix', async () => {
    const result = await autoNameBranch(
      'Fix the login flow so expired sessions are refreshed',
      async () => 'Fix-Login-Flow',
    );

    expect(result).toEqual({ branch: 'fix-login-flow', source: 'generated' });
    expect(result.branch).not.toMatch(/^(feat|fix|chore)\//);
    expect(result.branch.length).toBeLessThanOrEqual(40);
  });

  it('normalizes fenced, quoted and over-long output into one legal branch name', async () => {
    const messy = await autoNameBranch('Fix login', async () => '```\n"Fix-Login-Flow"\n```');
    expect(messy.branch).toBe('fix-login-flow');

    const long = await autoNameBranch(
      'A very long task description',
      async () => 'this-is-a-very-long-branch-name-that-exceeds-the-forty-character-limit',
    );
    expect(long.branch).toBe('this-is-a-very-long-branch-name-that-exc');
    expect(long.branch).not.toMatch(/-$/);
  });

  it('is the second path of resolveBranchName when there is no issue number', async () => {
    const resolved = await resolveBranchName({
      type: 'feat',
      description: 'Refresh expired sessions on the login screen',
      autoName: { generate: async () => 'refresh-expired-sessions' },
    });
    expect(resolved).toEqual({ branch: 'refresh-expired-sessions', source: 'generated' });
  });
});

describe('G3 — the generator is unavailable or times out', () => {
  it('returns change-<uuid8>', async () => {
    const timedOut = await autoNameBranch('Fix bug', () => new Promise<string>(() => undefined), {
      timeoutMs: 20,
    });
    expect(timedOut.source).toBe('fallback');
    expect(timedOut.branch).toMatch(/^change-[a-f0-9]{8}$/);

    const unavailable = await autoNameBranch('Fix bug', async () => {
      throw new Error('spawn claude ENOENT');
    });
    expect(unavailable.source).toBe('fallback');
    expect(unavailable.branch).toMatch(/^change-[a-f0-9]{8}$/);
  });

  it('is also the third path: no issue, no description', async () => {
    const resolved = await resolveBranchName({ type: 'feat', title: '🔥 !!!' });
    expect(resolved.source).toBe('fallback');
    expect(resolved.branch).toMatch(/^change-[a-f0-9]{8}$/);
  });

  it('produces a fresh identifier on every call', () => {
    expect(generateFallbackBranchName()).not.toBe(generateFallbackBranchName());
  });
});

describe('G8 — complete delivery', () => {
  it('closes the issue from the Pull Request body', () => {
    expect(issueReferenceLines({ references: [{ number: 63, complete: true }] })).toBe(
      'Closes #63',
    );
  });
});

describe('G9 — partial delivery', () => {
  it('references the issue instead of closing it', () => {
    expect(issueReferenceLines({ references: [{ number: 63, complete: false }] })).toBe('Refs #63');
  });
});

describe("G10 — commit.format: 'free'", () => {
  it('preserves the message the agent wrote, with no rewriting', () => {
    const written = 'Refresh expired sessions.';
    expect(commitMessage({ format: 'free', type: 'feat', subject: written })).toBe(written);
  });

  it('keeps the body unwrapped and the header unprefixed', () => {
    const body = `${'palavra '.repeat(20).trim()}`;
    const message = commitMessage({
      format: 'free',
      type: 'fix',
      scope: 'core',
      subject: 'Corrige o refresh de sessão',
      body,
    });
    expect(message).toBe(`Corrige o refresh de sessão\n\n${body}`);
    // The body is one line: `'conventional'` would have wrapped it at 72.
    expect(message.split('\n')).toHaveLength(3);
    expect(body.length).toBeGreaterThan(72);
  });

  it('still emits the Refs footer, which is a traceability guarantee', () => {
    expect(
      commitMessage({ format: 'free', type: 'feat', subject: 'Anything', issueNumber: 7 }),
    ).toBe('Anything\n\nRefs #7');
  });

  it("rewrites nothing that 'conventional' would have rewritten", () => {
    const conventional = commitMessage({ type: 'feat', scope: 'core', subject: 'Add probe.' });
    expect(conventional).toBe('feat(core): Add probe');
    expect(
      commitMessage({ format: 'free', type: 'feat', scope: 'core', subject: 'Add probe.' }),
    ).toBe('Add probe.');
  });
});

describe('G11 — provider token as scope', () => {
  it('drops it from the commit and from the Pull Request title', () => {
    for (const provider of ['claude', 'codex', 'cursor', 'antigravity', 'opencode'] as const) {
      expect(commitMessage({ type: 'feat', scope: provider, subject: 'add probe' })).toBe(
        'feat: add probe',
      );
      expect(pullRequestTitle({ type: 'feat', scope: provider, subject: 'add probe' })).toBe(
        'feat: add probe',
      );
    }
  });

  it('keeps a provider name that is genuinely the subject of the change', () => {
    expect(commitMessage({ type: 'feat', scope: 'agents', subject: 'add Cursor CLI runner' })).toBe(
      'feat(agents): add Cursor CLI runner',
    );
  });

  it('flattens a generated name so no token can become a type prefix', async () => {
    const resolved = await resolveBranchName({
      type: 'feat',
      description: 'Add a runner',
      autoName: { generate: async () => 'claude/add-runner' },
    });
    expect(resolved.branch).toBe('claude-add-runner');
    expect(resolved.branch).not.toContain('/');
  });
});
