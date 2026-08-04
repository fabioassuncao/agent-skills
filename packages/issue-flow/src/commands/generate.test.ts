import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssueProvider } from '../issues/provider.js';
import { clearProviders, registerProvider } from '../issues/registry.js';
import type { Issue, IssueDraft, IssuesConfig } from '../issues/types.js';

const loadIssuesConfig = vi.fn();
vi.mock('../config.js', () => ({ loadIssuesConfig: () => loadIssuesConfig() }));

const runHeadless = vi.fn();
vi.mock('../core/headless.js', () => ({ runHeadless: (opts: unknown) => runHeadless(opts) }));

vi.mock('../core/prompt-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/prompt-resolver.js')>();
  return { ...actual, loadPrompt: vi.fn(async () => 'Draft this: __USER_PROMPT__') };
});

import { runGenerate } from './generate.js';

const DRAFT_OUTPUT = [
  '<issue-draft>',
  '<title>Add retries</title>',
  '<labels>bug</labels>',
  '<body>Because it fails.</body>',
  '</issue-draft>',
].join('\n');

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: '42',
    number: 42,
    title: 'Add retries',
    body: 'Because it fails.',
    labels: ['bug'],
    state: 'open',
    source: 'github',
    remoteRef: 'https://github.com/acme/app/issues/42',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    contentHash: 'sha256:abc',
    ...overrides,
  };
}

function config(overrides: Partial<IssuesConfig> = {}): IssuesConfig {
  return {
    defaultGenerateTarget: 'github',
    preferredProvider: 'github',
    conflictPolicy: 'ask',
    requireConfirmation: true,
    ...overrides,
  };
}

/** Records every draft it is asked to create, so assertions read the payload. */
function fakeProvider(name: 'github' | 'local', created: Issue): IssueProvider {
  return {
    name,
    isAvailable: vi.fn(async () => true),
    get: vi.fn(async () => null),
    create: vi.fn(async (_draft: IssueDraft) => created),
  };
}

let github: IssueProvider;
let local: IssueProvider;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  clearProviders();

  github = fakeProvider('github', issue());
  local = fakeProvider(
    'local',
    issue({ source: 'local', remoteRef: null, contentHash: 'sha256:abc' }),
  );
  registerProvider(github);
  registerProvider(local);

  loadIssuesConfig.mockResolvedValue(config());
  runHeadless.mockResolvedValue({
    success: true,
    result: DRAFT_OUTPUT,
    cost: null,
    error: null,
  });

  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  clearProviders();
});

function output(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

describe('runGenerate destinations', () => {
  it('uses defaultGenerateTarget when no flag is passed', async () => {
    expect(await runGenerate('add retries')).toBe(0);

    expect(github.create).toHaveBeenCalledTimes(1);
    expect(local.create).not.toHaveBeenCalled();
  });

  it('honours a defaultGenerateTarget of local from the config file', async () => {
    loadIssuesConfig.mockResolvedValue(config({ defaultGenerateTarget: 'local' }));

    expect(await runGenerate('add retries')).toBe(0);

    expect(local.create).toHaveBeenCalledTimes(1);
    expect(github.create).not.toHaveBeenCalled();
  });

  it('lets an explicit target override the config file', async () => {
    loadIssuesConfig.mockResolvedValue(config({ defaultGenerateTarget: 'local' }));

    expect(await runGenerate('add retries', 'github')).toBe(0);

    expect(github.create).toHaveBeenCalledTimes(1);
    expect(local.create).not.toHaveBeenCalled();
  });

  it('creates only locally with target local, without touching GitHub', async () => {
    expect(await runGenerate('add retries', 'local')).toBe(0);

    expect(local.create).toHaveBeenCalledWith({
      title: 'Add retries',
      body: 'Because it fails.',
      labels: ['bug'],
    });
    expect(github.create).not.toHaveBeenCalled();
    expect(output()).toContain('issues/42/issue.md');
  });

  it('reports the remote URL for a GitHub creation', async () => {
    await runGenerate('add retries', 'github');

    expect(output()).toContain('https://github.com/acme/app/issues/42');
  });
});

describe('runGenerate --both', () => {
  it('mirrors the GitHub issue locally under the same identifier', async () => {
    expect(await runGenerate('add retries', 'both')).toBe(0);

    expect(github.create).toHaveBeenCalledTimes(1);
    expect(local.create).toHaveBeenCalledTimes(1);

    const mirror = vi.mocked(local.create).mock.calls[0][0];
    expect(mirror.id).toBe('42');
    expect(mirror.title).toBe('Add retries');
    expect(mirror.remote).toEqual({
      provider: 'github',
      ref: 'https://github.com/acme/app/issues/42',
      syncedAt: expect.any(String),
      syncedContentHash: 'sha256:abc',
    });
    expect(Date.parse(mirror.remote?.syncedAt ?? '')).not.toBeNaN();
  });

  it('creates the remote before the mirror', async () => {
    const order: string[] = [];
    vi.mocked(github.create).mockImplementation(async () => {
      order.push('github');
      return issue();
    });
    vi.mocked(local.create).mockImplementation(async () => {
      order.push('local');
      return issue({ source: 'local', remoteRef: null });
    });

    await runGenerate('add retries', 'both');

    expect(order).toEqual(['github', 'local']);
  });

  it('leaves no local artifact when the remote creation fails', async () => {
    vi.mocked(github.create).mockRejectedValue(new Error('gh: authentication required'));

    expect(await runGenerate('add retries', 'both')).toBe(1);
    expect(local.create).not.toHaveBeenCalled();
  });

  it('reports the exact persisted state when the mirror fails', async () => {
    vi.mocked(local.create).mockRejectedValue(new Error('disk full'));

    expect(await runGenerate('add retries', 'both')).toBe(1);

    expect(output()).toContain('https://github.com/acme/app/issues/42');
    expect(output()).toContain('disk full');
  });
});

describe('runGenerate failures', () => {
  it('returns 1 and creates nothing when the headless run fails', async () => {
    runHeadless.mockResolvedValue({
      success: false,
      result: '',
      cost: null,
      error: 'timed out',
    });

    expect(await runGenerate('add retries')).toBe(1);
    expect(github.create).not.toHaveBeenCalled();
  });

  it('returns 1 and creates nothing when the draft cannot be parsed', async () => {
    runHeadless.mockResolvedValue({
      success: true,
      result: 'I created the issue at https://github.com/acme/app/issues/9',
      cost: null,
      error: null,
    });

    expect(await runGenerate('add retries')).toBe(1);
    expect(github.create).not.toHaveBeenCalled();
    expect(local.create).not.toHaveBeenCalled();
  });

  it('returns 1 when a single-destination creation fails', async () => {
    vi.mocked(local.create).mockRejectedValue(new Error('issues/42 already exists'));

    expect(await runGenerate('add retries', 'local')).toBe(1);
  });
});

describe('runGenerate prompt', () => {
  // The duplicate check reads the local issues, which moved out of the working
  // directory: the prompt has to carry the resolved path, and `claude` has to be
  // allowed into it.
  it('hands the global issues directory to the agent', async () => {
    const { loadPrompt } = await import('../core/prompt-resolver.js');
    vi.mocked(loadPrompt).mockResolvedValueOnce(
      'Duplicates in __LOCAL_ISSUES_DIR__/*/metadata.json',
    );

    const { resolveProjectPaths } = await import('../storage/resolve.js');
    const { issuesDir } = await resolveProjectPaths();

    expect(await runGenerate('add retries')).toBe(0);

    const options = runHeadless.mock.calls.at(-1)?.[0];
    expect(options.prompt).toBe(`Duplicates in ${issuesDir}/*/metadata.json`);
    expect(options.addDirs).toEqual([issuesDir]);
  });
});
