import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GLOBAL_ROOT_ENV } from '../../storage/paths.js';
import { resetStorageResolutionCache } from '../../storage/resolve.js';
import type { ExecResult } from '../../utils/shell.js';

vi.mock('../../utils/shell.js', () => ({ run: vi.fn() }));

const { run } = await import('../../utils/shell.js');
const { InlineIssueProvider, inlineIssueId, inlineIssueTitle, isInlineIssueId, mintInlineIssue } =
  await import('./inline.js');

const mockRun = vi.mocked(run);

function result(overrides?: Partial<ExecResult>): ExecResult {
  return { stdout: '', stderr: '', exitCode: 0, ...overrides };
}

let root: string;
let home: string;
let previousHome: string | undefined;
let provider: InstanceType<typeof InlineIssueProvider>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'issue-flow-inline-repo-'));
  home = await mkdtemp(join(tmpdir(), 'issue-flow-inline-home-'));
  previousHome = process.env[GLOBAL_ROOT_ENV];
  process.env[GLOBAL_ROOT_ENV] = home;
  mockRun.mockReset();
  mockRun.mockImplementation(async (cmd: string, args: string[] = []) => {
    // The repository root, with no remote — so the project identity is derived
    // from this temporary path and nothing escapes it.
    if (cmd === 'git' && args[0] === 'rev-parse') return result({ stdout: `${root}\n` });
    return result({ exitCode: 1 });
  });
  resetStorageResolutionCache();
  provider = new InlineIssueProvider();
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env[GLOBAL_ROOT_ENV];
  else process.env[GLOBAL_ROOT_ENV] = previousHome;
  resetStorageResolutionCache();
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

/**
 * The `inline` origin — the entry half of §17's convergence: a free prompt is
 * accepted **as an Issue**, so nothing downstream needs a second code path.
 */
describe('inline issue origin', () => {
  it('derives a stable identifier from the prompt itself', () => {
    expect(inlineIssueId('Fix the flaky cache test')).toBe(
      inlineIssueId('  Fix the flaky cache test\n'),
    );
    expect(inlineIssueId('Fix the flaky cache test')).not.toBe(inlineIssueId('Something else'));
    expect(isInlineIssueId(inlineIssueId('anything'))).toBe(true);
  });

  it('claims only its own identifiers, so no origin answers for another', () => {
    expect(isInlineIssueId('42')).toBe(false);
    expect(isInlineIssueId('inline-')).toBe(false);
    expect(isInlineIssueId('inline-not-hex-here')).toBe(false);
  });

  it('titles a demand by its first meaningful line', () => {
    expect(inlineIssueTitle('# Rewrite the cache\n\nDetails follow.')).toBe('Rewrite the cache');
    expect(inlineIssueTitle('\n\n  keep the API  \nmore')).toBe('keep the API');
    expect(inlineIssueTitle('   ')).toBe('Inline prompt');
    expect(inlineIssueTitle('x'.repeat(200))).toHaveLength(72);
  });

  it('records a demand and reads it back as an Issue', async () => {
    const issue = await mintInlineIssue('Fix the flaky cache test\n\nIt fails on CI only.');
    expect(issue.source).toBe('inline');
    expect(issue.number).toBeNull();
    expect(issue.state).toBe('open');
    expect(issue.title).toBe('Fix the flaky cache test');
    expect(issue.body).toContain('It fails on CI only.');

    const readBack = await provider.get(issue.id);
    expect(readBack?.contentHash).toBe(issue.contentHash);
    expect(readBack?.body).toBe(issue.body);
  });

  it('is idempotent: the same demand is the same Issue', async () => {
    const first = await mintInlineIssue('Fix the flaky cache test');
    const second = await mintInlineIssue('Fix the flaky cache test');
    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('answers null for an identifier that is not its own, without touching storage', async () => {
    expect(await provider.get('42')).toBeNull();
    expect(await provider.get('inline-zzzzzzzzzzzz')).toBeNull();
  });

  it('answers null for an inline id this project never recorded', async () => {
    expect(await provider.get(inlineIssueId('never asked for'))).toBeNull();
  });

  it('closes a demand and reports the new state', async () => {
    const issue = await mintInlineIssue('Fix the flaky cache test');
    await provider.close(issue.id);
    expect((await provider.get(issue.id))?.state).toBe('closed');
  });

  it('refuses to close something that is not an inline demand', async () => {
    await expect(provider.close('42')).rejects.toThrow(/Not an inline Issue identifier/);
  });

  it('reports itself unavailable outside a repository instead of throwing', async () => {
    mockRun.mockImplementation(async () => result({ exitCode: 1 }));
    resetStorageResolutionCache();
    expect(await provider.isAvailable()).toBe(false);
    expect(await provider.get('inline-000000000000')).toBeNull();
  });
});
