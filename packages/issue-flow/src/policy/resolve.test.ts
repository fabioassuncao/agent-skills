import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_CONFIG_FILENAME, setPolicyCliOverrides } from '../config.js';
import { loadRepositoryPolicy, normalizeScope, resetPolicyCache } from './resolve.js';
import { POLICY_SCHEMA_VERSION, type PolicyExec } from './types.js';

let root: string;
const warn = vi.fn();

/** No git, no gh: the offline machine every degradation claim is about. */
const nothingAvailable = vi.fn<PolicyExec>(async () => ({
  stdout: '',
  stderr: 'command not found',
  exitCode: 127,
}));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'issue-flow-policy-resolve-'));
  warn.mockClear();
  nothingAvailable.mockClear();
  setPolicyCliOverrides({});
  resetPolicyCache();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(relPath: string, content: string): Promise<void> {
  const filePath = join(root, relPath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

async function writeProjectConfig(content: unknown): Promise<void> {
  await write(
    PROJECT_CONFIG_FILENAME,
    typeof content === 'string' ? content : JSON.stringify(content),
  );
}

function load(overrides: Parameters<typeof loadRepositoryPolicy>[0] = {}) {
  return loadRepositoryPolicy({
    root,
    env: {},
    cli: {},
    warn,
    exec: nothingAvailable,
    cache: false,
    ...overrides,
  });
}

describe('normalizeScope', () => {
  it.each([
    [undefined, null],
    [null, null],
    ['', null],
    ['.', null],
    ['apps/api', 'apps/api'],
    ['./apps/api/', 'apps/api'],
    ['apps//api', 'apps/api'],
    ['../outside', null],
    ['/etc', null],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeScope(input)).toBe(expected);
  });
});

describe('loadRepositoryPolicy', () => {
  it('returns an empty policy without error or warning for a bare repository', async () => {
    const policy = await load();

    expect(policy).toMatchObject({
      schemaVersion: POLICY_SCHEMA_VERSION,
      root,
      scope: null,
      enabled: true,
      issues: { templates: [], types: [], labels: [], titleConvention: null },
      pullRequests: { template: null, templates: [], baseBranch: null, titleConvention: null },
      git: { branchConvention: null, commitConvention: null },
      docs: [],
      codeowners: null,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('fills sources with the provenance of everything it found', async () => {
    await write('.github/ISSUE_TEMPLATE/bug.yml', 'name: Bug');
    await write('.github/PULL_REQUEST_TEMPLATE.md', '## What changed');
    await write('AGENTS.md', '# Agents');
    await write('.github/CODEOWNERS', '* @team');

    const { sources } = await load();

    expect(sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'issue-templates',
          path: '.github/ISSUE_TEMPLATE/bug.yml',
        }),
        expect.objectContaining({
          kind: 'pull-request-template',
          path: '.github/PULL_REQUEST_TEMPLATE.md',
        }),
        expect.objectContaining({ kind: 'docs', path: 'AGENTS.md' }),
        expect.objectContaining({ kind: 'codeowners', path: '.github/CODEOWNERS' }),
      ]),
    );
  });

  it('exposes the first Pull Request template as the default one', async () => {
    await write('.github/PULL_REQUEST_TEMPLATE/feature.md', 'feature body');
    await write('.github/PULL_REQUEST_TEMPLATE/hotfix.md', 'hotfix body');

    const { pullRequests } = await load();

    expect(pullRequests.template).toBe('feature body');
    expect(pullRequests.templates).toHaveLength(2);
  });

  it('degrades without error when gh is unavailable, recording the absence', async () => {
    const { issues, sources } = await load();

    expect(issues.labels).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'labels', origin: 'gh', status: 'unavailable' }),
      ]),
    );
  });

  it('composes the monorepo hierarchy for a scope, most specific last', async () => {
    await write('AGENTS.md', '# Root');
    await write('apps/api/AGENTS.md', '# API');

    const policy = await load({ scope: 'apps/api' });

    expect(policy.scope).toBe('apps/api');
    expect(policy.docs.map((d) => d.path)).toEqual(['AGENTS.md', 'apps/api/AGENTS.md']);
  });

  describe('precedence', () => {
    it('lets a discovered base branch beat the (null) default', async () => {
      const exec = vi.fn<PolicyExec>(async (command, args) =>
        command === 'git' && args[0] === 'symbolic-ref'
          ? { stdout: 'origin/develop', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: 'nope', exitCode: 1 },
      );

      expect((await load({ exec })).pullRequests.baseBranch).toBe('develop');
    });

    it('lets .issue-flow.json beat the discovery', async () => {
      await writeProjectConfig({ policy: { pullRequests: { baseBranch: 'develop' } } });
      const exec = vi.fn<PolicyExec>(async (command, args) =>
        command === 'git' && args[0] === 'symbolic-ref'
          ? { stdout: 'origin/main', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: 'nope', exitCode: 1 },
      );

      expect((await load({ exec })).pullRequests.baseBranch).toBe('develop');
    });

    it('lets ISSUE_FLOW_POLICY_BASE_BRANCH beat .issue-flow.json', async () => {
      await writeProjectConfig({ policy: { pullRequests: { baseBranch: 'develop' } } });

      const policy = await load({ env: { ISSUE_FLOW_POLICY_BASE_BRANCH: 'release' } });

      expect(policy.pullRequests.baseBranch).toBe('release');
    });

    it('lets a CLI override beat the environment', async () => {
      const policy = await load({
        env: { ISSUE_FLOW_POLICY_BASE_BRANCH: 'release' },
        cli: { pullRequests: { baseBranch: 'hotfix' } },
      });

      expect(policy.pullRequests.baseBranch).toBe('hotfix');
    });

    it('does not let an unset declaration erase what discovery found', async () => {
      await writeProjectConfig({ policy: { pullRequests: { baseBranch: null } } });
      const exec = vi.fn<PolicyExec>(async (command, args) =>
        command === 'git' && args[0] === 'symbolic-ref'
          ? { stdout: 'origin/develop', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: 'nope', exitCode: 1 },
      );

      expect((await load({ exec })).pullRequests.baseBranch).toBe('develop');
    });

    it('carries the declared conventions, which nothing discovers', async () => {
      await writeProjectConfig({
        policy: {
          issues: { titleConvention: '[Area] Title' },
          git: { branchConvention: 'feat/{slug}', commitConvention: 'conventional' },
          pullRequests: { titleConvention: 'type(scope): subject' },
        },
      });

      const policy = await load();

      expect(policy.issues.titleConvention).toBe('[Area] Title');
      expect(policy.git).toEqual({
        branchConvention: 'feat/{slug}',
        commitConvention: 'conventional',
        pullRequestTitleConvention: null,
        issueReference: null,
        typeMap: null,
        allowedTypes: null,
        scopes: null,
        commitTemplate: null,
        declared: true,
      });
      expect(policy.pullRequests.titleConvention).toBe('type(scope): subject');
      expect(policy.sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ origin: 'config', detail: 'git.branchConvention declared' }),
        ]),
      );
    });
  });

  describe('discovery toggles', () => {
    it('runs no discovery at all when policy.enabled is false', async () => {
      await write('AGENTS.md', '# Agents');
      await write('.github/ISSUE_TEMPLATE/bug.yml', 'name: Bug');
      await writeProjectConfig({ policy: { enabled: false } });

      const policy = await load();

      expect(policy.enabled).toBe(false);
      expect(policy.docs).toEqual([]);
      expect(policy.issues.templates).toEqual([]);
      expect(nothingAvailable).not.toHaveBeenCalled();
    });

    it('turns off a single pass with discovery.labels: false', async () => {
      await writeProjectConfig({ policy: { discovery: { labels: false } } });

      const { issues, sources } = await load();

      expect(issues.labels).toEqual([]);
      expect(sources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'labels', status: 'disabled', origin: 'config' }),
        ]),
      );
      expect(
        nothingAvailable.mock.calls.filter(
          ([command, args]) => command === 'gh' && args[0] === 'label',
        ),
      ).toHaveLength(0);
    });

    it('keeps the other passes running when one is disabled', async () => {
      await write('AGENTS.md', '# Agents');
      await writeProjectConfig({ policy: { discovery: { labels: false } } });

      expect((await load()).docs).toHaveLength(1);
    });
  });

  describe('gh budget', () => {
    it('asks gh at most once per kind of data', async () => {
      const exec = vi.fn<PolicyExec>(async (command, args) => {
        if (command === 'git' && args[0] === 'remote') {
          return { stdout: 'git@github.com:acme/widget.git', stderr: '', exitCode: 0 };
        }
        return { stdout: '[]', stderr: '', exitCode: 0 };
      });

      await load({ exec });

      const ghCalls = exec.mock.calls
        .filter(([command]) => command === 'gh')
        .map(([, args]) => args.join(' '));

      // Four, and no duplicates: labels, Issue Types, and the organization's
      // defaults — which cost two calls rather than one because GitHub exposes
      // them through different surfaces. `issueTemplates` covers only markdown
      // templates and is blind to Issue Forms, which exist solely as files in
      // the organization's `.github` repository.
      expect(ghCalls).toHaveLength(4);
      expect(new Set(ghCalls).size).toBe(4);
      expect(ghCalls).toEqual(
        expect.arrayContaining([
          expect.stringContaining('label list'),
          'api orgs/acme/issue-types',
          expect.stringContaining('issueTemplates'),
          expect.stringContaining('ISSUE_TEMPLATE'),
        ]),
      );
    });

    it('does not ask GitHub for templates the local tree already has', async () => {
      await write('.github/ISSUE_TEMPLATE/bug.yml', 'name: Bug');
      const exec = vi.fn<PolicyExec>(async (command, args) => {
        if (command === 'git' && args[0] === 'remote') {
          return { stdout: 'git@github.com:acme/widget.git', stderr: '', exitCode: 0 };
        }
        return { stdout: '[]', stderr: '', exitCode: 0 };
      });

      await load({ exec });

      expect(exec.mock.calls.some(([, args]) => args[1] === 'graphql')).toBe(false);
    });

    it('picks up the organization defaults when the repository has none', async () => {
      const exec = vi.fn<PolicyExec>(async (command, args) => {
        if (command === 'git' && args[0] === 'remote') {
          return { stdout: 'git@github.com:acme/widget.git', stderr: '', exitCode: 0 };
        }
        if (args[1] === 'graphql') {
          return {
            stdout: JSON.stringify({
              data: {
                repository: {
                  issueTemplates: [{ name: 'Bug Report', filename: 'bug.md', body: '## Steps' }],
                },
              },
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '[]', stderr: '', exitCode: 0 };
      });

      const { issues } = await load({ exec });

      expect(issues.templates).toHaveLength(1);
      expect(issues.templates[0]).toMatchObject({ name: 'Bug Report', origin: 'organization' });
    });

    it('never issues a network call without a timeout', async () => {
      const exec = vi.fn<PolicyExec>(async () => ({ stdout: '[]', stderr: '', exitCode: 0 }));

      await load({ exec });

      for (const [, , options] of exec.mock.calls) {
        expect(options.timeout).toBeGreaterThan(0);
      }
    });
  });

  describe('malformed configuration', () => {
    it('warns and degrades on invalid JSON, as every other key already does', async () => {
      await writeProjectConfig('{ not json');

      const policy = await load();

      expect(policy.enabled).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'));
    });

    it('warns and ignores an invalid "policy" key without losing the discovery', async () => {
      await write('AGENTS.md', '# Agents');
      await writeProjectConfig({ policy: { enabled: 'yes please' } });

      const policy = await load();

      expect(policy.enabled).toBe(true);
      expect(policy.docs).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('"policy" key'));
    });
  });

  describe('cache', () => {
    it('resolves once per (root, scope) and serves the same object afterwards', async () => {
      await write('AGENTS.md', '# Agents');

      const first = await loadRepositoryPolicy({ root, env: {}, warn, exec: nothingAvailable });
      const second = await loadRepositoryPolicy({ root, env: {}, warn, exec: nothingAvailable });

      expect(second).toBe(first);
      const ghCalls = nothingAvailable.mock.calls.filter(([command]) => command === 'gh');
      expect(ghCalls.length).toBeLessThanOrEqual(3);
    });

    it('keys the cache on the scope', async () => {
      const rootPolicy = await loadRepositoryPolicy({
        root,
        env: {},
        warn,
        exec: nothingAvailable,
      });
      const scoped = await loadRepositoryPolicy({
        root,
        scope: 'apps/api',
        env: {},
        warn,
        exec: nothingAvailable,
      });

      expect(scoped).not.toBe(rootPolicy);
      expect(scoped.scope).toBe('apps/api');
    });

    it('shares one resolution between concurrent callers', async () => {
      const exec = vi.fn<PolicyExec>(async () => ({ stdout: '[]', stderr: '', exitCode: 0 }));

      const [a, b] = await Promise.all([
        loadRepositoryPolicy({ root, env: {}, warn, exec }),
        loadRepositoryPolicy({ root, env: {}, warn, exec }),
      ]);

      expect(a).toBe(b);
      expect(exec.mock.calls.filter(([command]) => command === 'gh')).toHaveLength(1);
    });
  });
});
