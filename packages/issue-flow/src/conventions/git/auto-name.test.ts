import { describe, expect, it, vi } from 'vitest';
import {
  AUTO_NAME_TIMEOUT_MS,
  type AutoNameRequest,
  autoNameBranch,
  autoNameSystemPrompt,
  autoNameUserPrompt,
  DEFAULT_AUTO_NAME_SYSTEM_PROMPT,
  generateFallbackBranchName,
  normalizeGeneratedBranchName,
} from './auto-name.js';
import { isValidBranchName, sanitizeBranchName } from './slug.js';

/**
 * Ported from `backend/src/__tests__/auto-name-service.test.ts` @ d8c9d5f.
 *
 * This file is where **C2** of §34 lives — "generate a branch from a
 * description: kebab-case, at most 40 characters, no prefix; timeout →
 * `change-<uuid8>`". Both halves are asserted below, the length and shape by
 * the normalization cases and the fallback by the G3 group, so the
 * characterization has no separate file of its own.
 *
 * Nine of the seventeen upstream cases carry over. The eight that do not all
 * assert the argv of `claude -p` / `codex exec`, which this directory cannot
 * build: the provider lives outside the convention layer, behind the injected
 * generator. Three more are adapted rather than dropped — upstream throws where
 * Issue Flow degrades, and the assertion moves from `rejects.toThrow` to the
 * deterministic fallback.
 */

function record(): { calls: AutoNameRequest[]; generate: (r: AutoNameRequest) => Promise<string> } {
  const calls: AutoNameRequest[] = [];
  return {
    calls,
    generate: async (request) => {
      calls.push(request);
      return 'fix-login-flow';
    },
  };
}

describe('the prompt handed to the generator', () => {
  it('uses the default system prompt when the repository declares none', async () => {
    const { calls, generate } = record();
    await autoNameBranch('Fix the login flow', generate);

    expect(calls[0]?.system).toBe(DEFAULT_AUTO_NAME_SYSTEM_PROMPT);
    expect(calls[0]?.system).toContain('Generate a concise git branch name');
    // The clause that stops a model from re-adding the prefix the flat form exists to avoid.
    expect(calls[0]?.system).toContain('Do not include quotes, code fences, or prefixes');
  });

  it('uses the declared system prompt when there is one', () => {
    expect(autoNameSystemPrompt({ systemPrompt: 'Generate a branch name' })).toBe(
      'Generate a branch name',
    );
    expect(autoNameSystemPrompt({ systemPrompt: '   ' })).toBe(DEFAULT_AUTO_NAME_SYSTEM_PROMPT);
  });

  it('builds the user prompt literally, as upstream does', async () => {
    const { calls, generate } = record();
    await autoNameBranch('Fix the login flow', generate);

    expect(calls[0]?.user).toBe(
      'Here is the task description: Fix the login flow. You MUST return the branch name only, no other text or comments. Be fast, make it simple, and concise.',
    );
    expect(autoNameUserPrompt('x')).toContain('You MUST return the branch name only');
  });

  it('passes the configured timeout through to the generator', async () => {
    const { calls, generate } = record();
    await autoNameBranch('Test timeout wiring', generate, { timeoutMs: 1234 });
    expect(calls[0]?.timeoutMs).toBe(1234);

    const other = record();
    await autoNameBranch('Test the default', other.generate);
    expect(other.calls[0]?.timeoutMs).toBe(AUTO_NAME_TIMEOUT_MS);
  });
});

describe('normalizeGeneratedBranchName', () => {
  it('normalizes messy output into a valid branch name', () => {
    expect(normalizeGeneratedBranchName('```\n"Fix-Login-Flow"\n```')).toBe('fix-login-flow');
    expect(normalizeGeneratedBranchName('Branch name: Add Search')).toBe('add-search');
    expect(normalizeGeneratedBranchName('feature/add-search\nand some commentary')).toBe(
      'feature-add-search',
    );
  });

  it('truncates names longer than the ceiling', () => {
    const branch = normalizeGeneratedBranchName(
      'this-is-a-very-long-branch-name-that-exceeds-the-forty-character-limit',
    );
    expect(branch).toBe('this-is-a-very-long-branch-name-that-exc');
    expect(branch?.length).toBeLessThanOrEqual(40);
  });

  it('removes the trailing hyphen truncation can leave behind', () => {
    const branch = normalizeGeneratedBranchName('add-feature-to-handle-user-authentication-flow');
    expect(branch).not.toMatch(/-$/);
    expect(branch?.length).toBeLessThanOrEqual(40);
  });

  it('returns null when nothing usable remains', () => {
    expect(normalizeGeneratedBranchName('')).toBeNull();
    expect(normalizeGeneratedBranchName('   \n  ')).toBeNull();
    expect(normalizeGeneratedBranchName('///...///')).toBeNull();
  });

  it('honours a declared ceiling', () => {
    expect(normalizeGeneratedBranchName('refresh-expired-sessions', 12)).toBe('refresh-expi');
  });
});

describe('failure handling — adapted from upstream', () => {
  it('falls back instead of throwing when the generator is missing', async () => {
    const result = await autoNameBranch('Fix bug', async () => {
      throw new Error("'claude' CLI not found. Install it or check your PATH.");
    });
    expect(result).toEqual({ branch: result.branch, source: 'fallback' });
    expect(result.branch).toMatch(/^change-[a-f0-9]{8}$/);
  });

  it('falls back instead of throwing when the generator fails', async () => {
    const result = await autoNameBranch('Fix bug', async () => {
      throw new Error('codex failed: authentication required');
    });
    expect(result.source).toBe('fallback');
  });

  it('falls back on empty output', async () => {
    const result = await autoNameBranch('Fix bug', async () => '');
    expect(result.source).toBe('fallback');
    expect(result.branch).toMatch(/^change-[a-f0-9]{8}$/);
  });

  it('falls back on an empty task description without calling the generator', async () => {
    const generate = vi.fn(async () => 'never-used');
    const result = await autoNameBranch('   ', generate);
    expect(generate).not.toHaveBeenCalled();
    expect(result.source).toBe('fallback');
  });

  it('enforces the deadline itself, so a generator that ignores it cannot hang a run', async () => {
    const started = Date.now();
    const result = await autoNameBranch('Fix bug', () => new Promise<string>(() => undefined), {
      timeoutMs: 30,
    });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.branch).toMatch(/^change-[a-f0-9]{8}$/);
  });

  it('aborts the signal it handed the generator once the deadline passes', async () => {
    let aborted = false;
    await autoNameBranch(
      'Fix bug',
      (request) =>
        new Promise<string>(() => {
          request.signal.addEventListener('abort', () => {
            aborted = true;
          });
        }),
      { timeoutMs: 20 },
    );
    expect(aborted).toBe(true);
  });
});

describe('generateFallbackBranchName', () => {
  it('is always a legal branch name', () => {
    for (let n = 0; n < 20; n += 1) {
      const name = generateFallbackBranchName();
      expect(name).toMatch(/^change-[a-f0-9]{8}$/);
      expect(isValidBranchName(name)).toBe(true);
    }
  });
});

describe('sanitizeBranchName', () => {
  it.each([
    ['Fix Login Flow', 'fix-login-flow'],
    ['feat/63-slug', 'feat/63-slug'],
    ['bad~name^with:junk', 'badnamewithjunk'],
    ['a@{b', 'ab'],
    ['double..dot', 'double.dot'],
    ['a//b', 'a/b'],
    ['--edges--', 'edges'],
    ['cache.lock', 'cache'],
  ])('%s → %s', (raw, expected) => {
    expect(sanitizeBranchName(raw)).toBe(expected);
  });

  it('accepts exactly the names it leaves untouched', () => {
    expect(isValidBranchName('feat/63-slug')).toBe(true);
    expect(isValidBranchName('Fix Login')).toBe(false);
    expect(isValidBranchName('')).toBe(false);
  });
});
