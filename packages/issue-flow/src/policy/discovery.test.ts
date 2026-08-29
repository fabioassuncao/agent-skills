import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  discoverBaseBranch,
  discoverCodeowners,
  discoverDocuments,
  discoverGitHubSlug,
  discoverIssueTemplates,
  discoverIssueTypes,
  discoverLabels,
  discoverOrganizationTemplates,
  discoverPullRequestTemplates,
  scopeLadder,
} from './discovery.js';
import { MAX_POLICY_DOCUMENT_BYTES, type PolicyExec } from './types.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'issue-flow-policy-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(relPath: string, content: string): Promise<void> {
  const filePath = join(root, relPath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

/** An exec seam that answers a scripted map of `command args` to results. */
function scriptedExec(script: Record<string, Partial<{ stdout: string; exitCode: number }>>) {
  return vi.fn<PolicyExec>(async (command, args) => {
    const key = [command, ...args].join(' ');
    const hit = script[key];
    return {
      stdout: hit?.stdout ?? '',
      stderr: hit === undefined ? 'not scripted' : '',
      exitCode: hit?.exitCode ?? (hit === undefined ? 1 : 0),
    };
  });
}

describe('discoverIssueTemplates', () => {
  it('finds forms and markdown templates in .github/ISSUE_TEMPLATE', async () => {
    await write(
      '.github/ISSUE_TEMPLATE/bug.yml',
      ['name: Bug', 'description: Something broke', 'labels: ["bug"]', 'type: Bug'].join('\n'),
    );
    await write(
      '.github/ISSUE_TEMPLATE/feature.md',
      ['---', 'name: Feature', 'about: Ask for something', 'labels: enhancement', '---', ''].join(
        '\n',
      ),
    );
    // The chooser configuration is not a template.
    await write('.github/ISSUE_TEMPLATE/config.yml', 'blank_issues_enabled: false');

    const { templates, sources } = await discoverIssueTemplates(root);

    expect(templates.map((t) => t.path)).toEqual([
      '.github/ISSUE_TEMPLATE/bug.yml',
      '.github/ISSUE_TEMPLATE/feature.md',
    ]);
    expect(templates[0]).toMatchObject({
      format: 'form',
      origin: 'filesystem',
      name: 'Bug',
      about: 'Something broke',
      labels: ['bug'],
      type: 'Bug',
    });
    expect(templates[1]).toMatchObject({
      format: 'markdown',
      name: 'Feature',
      about: 'Ask for something',
      labels: ['enhancement'],
    });
    expect(sources.every((s) => s.kind === 'issue-templates' && s.status === 'found')).toBe(true);
  });

  it('searches docs/ and the repository root as well', async () => {
    await write('docs/ISSUE_TEMPLATE/task.md', '## Task');
    await write('ISSUE_TEMPLATE.md', '## Legacy single template');

    const { templates } = await discoverIssueTemplates(root);

    expect(templates.map((t) => t.path).sort()).toEqual([
      'ISSUE_TEMPLATE.md',
      'docs/ISSUE_TEMPLATE/task.md',
    ]);
  });

  it('returns nothing for a repository with no templates', async () => {
    const { templates, sources } = await discoverIssueTemplates(root);

    expect(templates).toEqual([]);
    expect(sources).toEqual([]);
  });

  it('records truncation instead of silently handing over half a document', async () => {
    await write('.github/ISSUE_TEMPLATE/huge.md', 'x'.repeat(MAX_POLICY_DOCUMENT_BYTES + 10));

    const { templates, sources } = await discoverIssueTemplates(root);

    expect(templates[0]?.content.length).toBe(MAX_POLICY_DOCUMENT_BYTES);
    expect(sources[0]?.detail).toBe('content truncated');
  });
});

describe('discoverPullRequestTemplates', () => {
  it('finds the single-file template in .github', async () => {
    await write('.github/PULL_REQUEST_TEMPLATE.md', '## What changed');

    const { templates } = await discoverPullRequestTemplates(root);

    expect(templates).toEqual([
      {
        path: '.github/PULL_REQUEST_TEMPLATE.md',
        name: 'PULL_REQUEST_TEMPLATE.md',
        content: '## What changed',
      },
    ]);
  });

  it('finds every template of the multi-template directory', async () => {
    await write('.github/PULL_REQUEST_TEMPLATE/feature.md', 'feature');
    await write('.github/PULL_REQUEST_TEMPLATE/hotfix.md', 'hotfix');

    const { templates } = await discoverPullRequestTemplates(root);

    expect(templates.map((t) => t.name)).toEqual(['feature.md', 'hotfix.md']);
  });

  it('finds a lowercase template at the repository root', async () => {
    await write('pull_request_template.md', 'root template');

    const { templates } = await discoverPullRequestTemplates(root);

    expect(templates.map((t) => t.path)).toEqual(['pull_request_template.md']);
  });

  it('returns nothing when the repository has no template', async () => {
    expect(await discoverPullRequestTemplates(root)).toEqual({ templates: [], sources: [] });
  });
});

describe('discoverCodeowners', () => {
  it('finds CODEOWNERS in .github', async () => {
    await write('.github/CODEOWNERS', '* @team');

    const { content, sources } = await discoverCodeowners(root);

    expect(content).toBe('* @team');
    expect(sources[0]).toMatchObject({ kind: 'codeowners', path: '.github/CODEOWNERS' });
  });

  it('degrades to null with no source when absent', async () => {
    expect(await discoverCodeowners(root)).toEqual({ content: null, sources: [] });
  });
});

describe('scopeLadder', () => {
  it('composes from the root down to the scope', () => {
    expect(scopeLadder('apps/api')).toEqual(['', 'apps', 'apps/api']);
  });

  it('is the root alone with no scope', () => {
    expect(scopeLadder(null)).toEqual(['']);
    expect(scopeLadder('')).toEqual(['']);
  });
});

describe('discoverDocuments', () => {
  it('finds AGENTS.md, CLAUDE.md, CONTRIBUTING.md and CODE_OF_CONDUCT.md', async () => {
    await write('AGENTS.md', '# Agents');
    await write('CLAUDE.md', '# Claude');
    await write('CONTRIBUTING.md', '# Contributing');
    await write('.github/CODE_OF_CONDUCT.md', '# Conduct');

    const { documents } = await discoverDocuments(root, null);

    expect(documents.map((d) => [d.path, d.kind])).toEqual([
      ['.github/CODE_OF_CONDUCT.md', 'code-of-conduct'],
      ['CONTRIBUTING.md', 'contributing'],
      ['AGENTS.md', 'agents'],
      ['CLAUDE.md', 'claude'],
    ]);
  });

  it('returns a single entry for a repository with only AGENTS.md', async () => {
    await write('AGENTS.md', '# Agents');

    const { documents } = await discoverDocuments(root, null);

    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ path: 'AGENTS.md', kind: 'agents', scope: '' });
  });

  it('composes the monorepo hierarchy with the most specific document last', async () => {
    await write('AGENTS.md', '# Root rules');
    await write('apps/api/AGENTS.md', '# API rules');

    const { documents } = await discoverDocuments(root, 'apps/api');

    expect(documents.map((d) => [d.path, d.scope])).toEqual([
      ['AGENTS.md', ''],
      ['apps/api/AGENTS.md', 'apps/api'],
    ]);
  });

  it('does not read a sibling scope', async () => {
    await write('apps/api/AGENTS.md', '# API');
    await write('apps/web/AGENTS.md', '# Web');

    const { documents } = await discoverDocuments(root, 'apps/api');

    expect(documents.map((d) => d.path)).toEqual(['apps/api/AGENTS.md']);
  });

  it('follows the links of AGENTS.md one level, and only in-repository markdown', async () => {
    await write(
      'AGENTS.md',
      [
        '# Agents',
        'See [governance](docs/governance.md) and [style](./docs/style.md).',
        'Also [the site](https://example.com/page.md) and [a diagram](docs/arch.png).',
        'And [a missing one](docs/nope.md).',
      ].join('\n'),
    );
    await write('docs/governance.md', '# Governance\n[deeper](deeper.md)');
    await write('docs/style.md', '# Style');
    await write('docs/deeper.md', '# Deeper');

    const { documents } = await discoverDocuments(root, null);

    expect(documents.map((d) => d.path)).toEqual([
      'AGENTS.md',
      'docs/governance.md',
      'docs/style.md',
    ]);
    expect(documents[1]).toMatchObject({ kind: 'referenced', referencedFrom: 'AGENTS.md' });
  });

  it('returns nothing for a repository with no documents', async () => {
    expect(await discoverDocuments(root, null)).toEqual({ documents: [], sources: [] });
  });
});

describe('discoverBaseBranch', () => {
  it('prefers origin/HEAD', async () => {
    const exec = scriptedExec({
      'git symbolic-ref --short refs/remotes/origin/HEAD': { stdout: 'origin/develop' },
    });

    expect(await discoverBaseBranch(root, exec)).toEqual({
      baseBranch: 'develop',
      sources: [
        { kind: 'base-branch', origin: 'git', path: null, status: 'found', detail: 'origin/HEAD' },
      ],
    });
  });

  it('falls back to an existing local main', async () => {
    const exec = scriptedExec({
      'git rev-parse --verify --quiet refs/heads/main': { stdout: 'abc' },
    });

    expect((await discoverBaseBranch(root, exec)).baseBranch).toBe('main');
  });

  it('answers null rather than inventing "main" when git knows nothing', async () => {
    const exec = scriptedExec({});

    expect(await discoverBaseBranch(root, exec)).toEqual({ baseBranch: null, sources: [] });
  });

  it('records the absence when git cannot be executed at all', async () => {
    const exec = vi.fn<PolicyExec>(async () => {
      throw new Error('spawn git ENOENT');
    });

    const result = await discoverBaseBranch(root, exec);

    expect(result.baseBranch).toBeNull();
    expect(result.sources[0]).toMatchObject({ kind: 'base-branch', status: 'unavailable' });
  });
});

describe('discoverGitHubSlug', () => {
  it.each([
    ['https://github.com/Acme/Widget.git', { owner: 'Acme', repo: 'Widget' }],
    ['git@github.com:Acme/Widget.git', { owner: 'Acme', repo: 'Widget' }],
    ['ssh://git@github.com:22/Acme/Widget', { owner: 'Acme', repo: 'Widget' }],
    ['https://github.com/Acme/Widget/', { owner: 'Acme', repo: 'Widget' }],
  ])('extracts owner and repo from %s with its original case', async (url, expected) => {
    const exec = scriptedExec({ 'git remote get-url origin': { stdout: url } });

    expect(await discoverGitHubSlug(root, exec)).toEqual(expected);
  });

  it('answers null when there is no remote', async () => {
    expect(await discoverGitHubSlug(root, scriptedExec({}))).toBeNull();
  });
});

describe('discoverLabels', () => {
  it('reads the labels that really exist', async () => {
    const exec = vi.fn<PolicyExec>(async () => ({
      stdout: JSON.stringify([
        { name: 'bug', description: 'Something broke', color: 'd73a4a' },
        { name: 'chore', description: '', color: '' },
        { name: '', description: 'nameless' },
      ]),
      stderr: '',
      exitCode: 0,
    }));

    const { labels, sources } = await discoverLabels(root, exec);

    expect(labels).toEqual([
      { name: 'bug', description: 'Something broke', color: 'd73a4a' },
      { name: 'chore', description: null, color: null },
    ]);
    expect(sources[0]).toMatchObject({ kind: 'labels', status: 'found', detail: '2 label(s)' });
  });

  it('degrades to an empty list and records the absence when gh is missing', async () => {
    const exec = vi.fn<PolicyExec>(async () => {
      throw new Error('spawn gh ENOENT');
    });

    const { labels, sources } = await discoverLabels(root, exec);

    expect(labels).toEqual([]);
    expect(sources).toEqual([
      {
        kind: 'labels',
        origin: 'gh',
        path: null,
        status: 'unavailable',
        detail: 'spawn gh ENOENT',
      },
    ]);
  });

  it('degrades when gh answers a network failure', async () => {
    const exec = vi.fn<PolicyExec>(async () => ({
      stdout: '',
      stderr: 'error connecting to api.github.com',
      exitCode: 1,
    }));

    const { sources } = await discoverLabels(root, exec);

    expect(sources[0]).toMatchObject({
      status: 'unavailable',
      detail: 'error connecting to api.github.com',
    });
  });

  it('passes a timeout to every gh invocation', async () => {
    const exec = scriptedExec({});
    await discoverLabels(root, exec);

    expect(exec).toHaveBeenCalledWith(
      'gh',
      expect.any(Array),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(exec.mock.calls[0]?.[2].timeout).toBeGreaterThan(0);
  });
});

describe('discoverIssueTypes', () => {
  it('reads the Issue Types of the organization', async () => {
    const exec = vi.fn<PolicyExec>(async () => ({
      stdout: JSON.stringify([{ name: 'Bug' }, { name: 'Feature' }, { name: 'Bug' }]),
      stderr: '',
      exitCode: 0,
    }));

    const { types } = await discoverIssueTypes(root, 'acme', exec);

    expect(types).toEqual(['Bug', 'Feature']);
  });

  it('does not call gh at all without an owner', async () => {
    const exec = scriptedExec({});

    expect(await discoverIssueTypes(root, null, exec)).toEqual({ types: [], sources: [] });
    expect(exec).not.toHaveBeenCalled();
  });

  it('records the absence for a personal account (404)', async () => {
    const exec = vi.fn<PolicyExec>(async () => ({
      stdout: '',
      stderr: 'gh: Not Found (HTTP 404)',
      exitCode: 1,
    }));

    const { types, sources } = await discoverIssueTypes(root, 'octocat', exec);

    expect(types).toEqual([]);
    expect(sources[0]).toMatchObject({ kind: 'issue-types', status: 'unavailable' });
  });
});

describe('discoverOrganizationTemplates', () => {
  it('reads the templates GitHub serves from the organization .github repository', async () => {
    const exec = vi.fn<PolicyExec>(async () => ({
      stdout: JSON.stringify({
        data: {
          repository: {
            issueTemplates: [
              {
                name: 'Bug Report',
                about: 'Report a bug',
                title: '[Bug] ',
                filename: '1.Bug_report.md',
                body: '## Steps',
                assignees: { nodes: [{ login: 'octocat' }] },
                labels: { nodes: [{ name: 'bug' }] },
              },
            ],
          },
        },
      }),
      stderr: '',
      exitCode: 0,
    }));

    const { templates, sources } = await discoverOrganizationTemplates(
      root,
      { owner: 'acme', repo: 'widget' },
      exec,
    );

    expect(templates[0]).toMatchObject({
      path: '1.Bug_report.md',
      origin: 'organization',
      name: 'Bug Report',
      title: '[Bug] ',
      labels: ['bug'],
      assignees: ['octocat'],
      content: '## Steps',
    });
    expect(sources[0]).toMatchObject({ kind: 'issue-templates', origin: 'gh', status: 'found' });
  });

  it('passes owner and repository as GraphQL variables, never spliced into the query', async () => {
    const exec = vi.fn<PolicyExec>(async () => ({ stdout: '{}', stderr: '', exitCode: 0 }));

    await discoverOrganizationTemplates(root, { owner: 'acme', repo: 'widget' }, exec);

    const args = exec.mock.calls[0]?.[1] ?? [];
    expect(args.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(args).toContain('owner=acme');
    expect(args).toContain('name=widget');
    expect(args.find((arg) => arg.startsWith('query='))).not.toContain('acme');
  });

  it('degrades to nothing on a GraphQL error payload', async () => {
    const exec = vi.fn<PolicyExec>(async () => ({
      stdout: JSON.stringify({ data: { repository: null }, errors: [{ type: 'NOT_FOUND' }] }),
      stderr: '',
      exitCode: 0,
    }));

    expect(await discoverOrganizationTemplates(root, { owner: 'a', repo: 'b' }, exec)).toEqual({
      templates: [],
      sources: [],
    });
  });

  it('does not call gh without a slug', async () => {
    const exec = scriptedExec({});

    expect(await discoverOrganizationTemplates(root, null, exec)).toEqual({
      templates: [],
      sources: [],
    });
    expect(exec).not.toHaveBeenCalled();
  });
});
