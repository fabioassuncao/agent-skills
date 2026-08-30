import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPolicyCliOverrides } from '../config.js';
import { loadRepositoryPolicy, resetPolicyCache } from '../policy/index.js';
import type { PolicyExec } from '../policy/types.js';
import { applyScaffoldPlan } from './apply.js';
import { buildScaffoldPlan, isClaudeBridge, type RepositoryState } from './plan.js';

/**
 * The scenarios initialization has to get right, from an empty repository to one
 * that already declares everything.
 *
 * Two properties are asserted throughout, because they are what make the command
 * safe to run on somebody else's repository: it never overwrites, and running it
 * twice changes nothing.
 */

let root: string;
const warn = vi.fn();

/** No `gh`: label and Issue Type discovery degrade, as they do offline. */
const noTooling = vi.fn<PolicyExec>(async () => ({
  stdout: '',
  stderr: 'command not found',
  exitCode: 127,
}));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'issue-flow-scaffold-'));
  warn.mockClear();
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

async function exists(relPath: string): Promise<boolean> {
  try {
    await stat(join(root, relPath));
    return true;
  } catch {
    return false;
  }
}

async function state(exec: PolicyExec = noTooling): Promise<RepositoryState> {
  resetPolicyCache();
  const policy = await loadRepositoryPolicy({ root, env: {}, cli: {}, warn, exec, cache: false });
  return { policy, projectName: 'widgets', exists };
}

async function plan(exec?: PolicyExec) {
  return buildScaffoldPlan(await state(exec));
}

function pathsOf(actions: Awaited<ReturnType<typeof plan>>['actions'], kind: string): string[] {
  return actions.filter((a) => a.kind === kind).map((a) => a.path);
}

describe('an empty repository', () => {
  it('proposes the whole baseline', async () => {
    const created = pathsOf((await plan()).actions, 'create');

    expect(created).toEqual(
      expect.arrayContaining([
        '.github/ISSUE_TEMPLATE/1-idea.yml',
        '.github/ISSUE_TEMPLATE/5-bug.yml',
        '.github/ISSUE_TEMPLATE/config.yml',
        '.github/PULL_REQUEST_TEMPLATE.md',
        'AGENTS.md',
        'CLAUDE.md',
        'docs/conventions.md',
        '.github/labels.json',
      ]),
    );
  });

  it('writes files that parse as the Issue Forms the policy layer discovers', async () => {
    await applyScaffoldPlan(await plan());

    // The strongest available check that the generated forms are real: feed them
    // back through the discovery this tool uses on any other repository.
    resetPolicyCache();
    const policy = await loadRepositoryPolicy({
      root,
      env: {},
      warn,
      exec: noTooling,
      cache: false,
    });

    expect(policy.issues.templates).toHaveLength(6);
    // The display name carries the emoji, as GitHub's chooser renders it; the
    // machine-readable identity is `type`, which is what the pipeline matches on.
    expect(policy.issues.templates.map((t) => t.type)).toEqual([
      'Idea',
      'Research',
      'Epic',
      'Feature',
      'Bug',
      'Task',
    ]);
    expect(policy.issues.templates[0]?.name).toContain('Idea');
    expect(policy.issues.templates.every((t) => t.format === 'form')).toBe(true);
    expect(policy.issues.templates.find((t) => t.type === 'Bug')?.labels).toEqual([]);
  });

  it('creates CLAUDE.md as a one-line bridge, never a second source', async () => {
    await applyScaffoldPlan(await plan());

    const claude = await readFile(join(root, 'CLAUDE.md'), 'utf-8');

    expect(claude.trim()).toBe('Read and follow the instructions in AGENTS.md.');
    expect(isClaudeBridge(claude)).toBe(true);
  });

  it('creates AGENTS.md as an index that holds no rule of its own', async () => {
    await applyScaffoldPlan(await plan());

    const agents = await readFile(join(root, 'AGENTS.md'), 'utf-8');

    expect(agents).toContain('is an **index**');
    expect(agents).toContain('docs/conventions.md');
    // The failure mode this convention exists to prevent.
    expect(agents).toContain('does not belong in this file');
  });

  it('is idempotent: a second run writes nothing', async () => {
    const first = await applyScaffoldPlan(await plan());
    expect(first.written.length).toBeGreaterThan(0);

    const second = await applyScaffoldPlan(await plan());

    expect(second.written).toEqual([]);
    const third = await plan();
    expect(pathsOf(third.actions, 'create')).toEqual([]);
  });
});

describe('a partially configured repository', () => {
  it('fills only the gap and leaves the rest alone', async () => {
    await write('.github/PULL_REQUEST_TEMPLATE.md', '## Ours\n');

    const result = await plan();

    expect(pathsOf(result.actions, 'keep')).toContain('.github/PULL_REQUEST_TEMPLATE.md');
    expect(pathsOf(result.actions, 'create')).toContain('AGENTS.md');
  });

  it('never rewrites the file it kept', async () => {
    await write('.github/PULL_REQUEST_TEMPLATE.md', '## Ours\n');

    await applyScaffoldPlan(await plan());

    expect(await readFile(join(root, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf-8')).toBe(
      '## Ours\n',
    );
  });
});

describe('a repository with its own conventions', () => {
  it('keeps its Issue Templates and proposes none of its own', async () => {
    await write('.github/ISSUE_TEMPLATE/report.yml', 'name: Report\ndescription: Ours\n');

    const result = await plan();

    expect(pathsOf(result.actions, 'keep')).toContain('.github/ISSUE_TEMPLATE/');
    expect(pathsOf(result.actions, 'create').filter((p) => p.includes('ISSUE_TEMPLATE'))).toEqual(
      [],
    );
  });

  it('does not add a competing conventions document', async () => {
    await write('.github/ISSUE_TEMPLATE/report.yml', 'name: Report\n');
    await write('CONTRIBUTING.md', '# How we work\n');

    const result = await plan();

    // A second document describing the same thing is a competing source, which
    // is exactly what this tool exists to avoid.
    expect(pathsOf(result.actions, 'create')).not.toContain('docs/conventions.md');
    expect(pathsOf(result.actions, 'keep')).toContain('docs/conventions.md');
  });

  it('never proposes labels for a repository that already has a taxonomy', async () => {
    const withLabels = vi.fn<PolicyExec>(async (command, args) =>
      command === 'gh' && args[0] === 'label'
        ? {
            stdout: JSON.stringify([{ name: 'bug', description: 'Broken', color: 'd73a4a' }]),
            stderr: '',
            exitCode: 0,
          }
        : { stdout: '', stderr: 'nope', exitCode: 1 },
    );

    const result = await plan(withLabels);

    expect(pathsOf(result.actions, 'keep')).toContain('.github/labels.json');
    expect(pathsOf(result.actions, 'create')).not.toContain('.github/labels.json');
  });
});

describe('templates served by the organization', () => {
  it('keeps them there instead of forking a local copy', async () => {
    const orgTemplates = vi.fn<PolicyExec>(async (command, args) => {
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
      return { stdout: '', stderr: 'nope', exitCode: 1 };
    });

    const result = await plan(orgTemplates);

    expect(pathsOf(result.actions, 'create').filter((p) => p.includes('ISSUE_TEMPLATE'))).toEqual(
      [],
    );
    expect(result.notes.join(' ')).toContain('organization');
  });
});

describe('agent entry points', () => {
  it('leaves an existing AGENTS.md alone', async () => {
    await write('AGENTS.md', '# Ours\n\nOur own index.\n');

    const result = await plan();

    expect(pathsOf(result.actions, 'keep')).toContain('AGENTS.md');
    await applyScaffoldPlan(result);
    expect(await readFile(join(root, 'AGENTS.md'), 'utf-8')).toBe('# Ours\n\nOur own index.\n');
  });

  it('recognizes an existing one-line CLAUDE.md as already correct', async () => {
    await write('AGENTS.md', '# Ours\n');
    await write('CLAUDE.md', 'Read and follow the instructions in AGENTS.md.\n');

    const result = await plan();

    expect(pathsOf(result.actions, 'keep')).toContain('CLAUDE.md');
    expect(pathsOf(result.actions, 'review')).not.toContain('CLAUDE.md');
  });

  it('flags a CLAUDE.md that carries instructions with no AGENTS.md, without touching it', async () => {
    await write('CLAUDE.md', '# Rules\n\nAlways run the tests before committing.\n');

    const result = await plan();

    expect(pathsOf(result.actions, 'review')).toContain('CLAUDE.md');
    expect(result.notes.join(' ')).toContain('Move that content into AGENTS.md');
    // Promoting the file means moving text somebody wrote: never automatic.
    await applyScaffoldPlan(result);
    expect(await readFile(join(root, 'CLAUDE.md'), 'utf-8')).toContain('Always run the tests');
  });

  it('flags duplication when both files carry instructions', async () => {
    await write('AGENTS.md', '# Index\n\nRead the docs.\n');
    await write('CLAUDE.md', '# Rules\n\nAlways run the tests before committing.\n');

    const result = await plan();

    expect(pathsOf(result.actions, 'review')).toContain('CLAUDE.md');
    expect(result.notes.join(' ')).toContain('diverge');
  });

  it('creates only CLAUDE.md when AGENTS.md already exists', async () => {
    await write('AGENTS.md', '# Ours\n');

    const created = pathsOf((await plan()).actions, 'create');

    expect(created).toContain('CLAUDE.md');
    expect(created).not.toContain('AGENTS.md');
  });
});

describe('isClaudeBridge', () => {
  it.each([
    ['Read and follow the instructions in AGENTS.md.\n', true],
    ['# Claude\n\nRead and follow the instructions in AGENTS.md.\n', true],
    ['See AGENTS.md\n', true],
    ['', false],
    ['# Rules\n\nAlways run tests.\n', false],
    // A file that merely cites AGENTS.md inside its own instructions is not a
    // bridge — it is a second source that happens to mention the first.
    ['# Rules\n\nAlways run tests.\n\nAlso see AGENTS.md.\n', false],
  ])('reads %j as %s', (content, expected) => {
    expect(isClaudeBridge(content)).toBe(expected);
  });
});

describe('non-destructiveness under a race', () => {
  it('skips a file that appeared between planning and writing', async () => {
    const built = await plan();
    await write('AGENTS.md', '# Written by someone else\n');

    const result = await applyScaffoldPlan(built);

    expect(result.skipped).toContain('AGENTS.md');
    expect(await readFile(join(root, 'AGENTS.md'), 'utf-8')).toBe('# Written by someone else\n');
  });
});

describe('the generated tree', () => {
  it('creates no file outside the repository root', async () => {
    const result = await plan();

    for (const item of result.actions) {
      expect(item.path.startsWith('/'), item.path).toBe(false);
      expect(item.path.includes('..'), item.path).toBe(false);
    }
  });

  it('produces exactly one Issue Form per default type', async () => {
    await applyScaffoldPlan(await plan());

    const files = (await readdir(join(root, '.github/ISSUE_TEMPLATE'))).sort();

    expect(files).toEqual([
      '1-idea.yml',
      '2-research.yml',
      '3-epic.yml',
      '4-feature.yml',
      '5-bug.yml',
      '6-task.yml',
      'config.yml',
    ]);
  });

  it('keeps blank issues enabled, so a report never becomes silence', async () => {
    await applyScaffoldPlan(await plan());

    const config = await readFile(join(root, '.github/ISSUE_TEMPLATE/config.yml'), 'utf-8');

    expect(config).toContain('blank_issues_enabled: true');
  });
});

describe('organization-published Issue Forms', () => {
  /** GraphQL answers the org `.github` tree; `issueTemplates` stays empty. */
  const orgForms = vi.fn<PolicyExec>(async (command, args) => {
    if (command === 'git' && args[0] === 'remote') {
      return { stdout: 'git@github.com:acme/widget.git', stderr: '', exitCode: 0 };
    }
    if (args[1] === 'graphql' && args.some((a) => a.includes('ISSUE_TEMPLATE'))) {
      return {
        stdout: JSON.stringify({
          data: {
            repository: {
              object: {
                entries: [
                  {
                    name: 'config.yml',
                    type: 'blob',
                    object: { text: 'blank_issues_enabled: true' },
                  },
                  {
                    name: '1-idea.yml',
                    type: 'blob',
                    object: { text: 'name: "Idea"\ntype: "Idea"\nbody: []\n' },
                  },
                  {
                    name: '2-bug.yml',
                    type: 'blob',
                    object: { text: 'name: "Bug"\ntype: "Bug"\nbody: []\n' },
                  },
                ],
              },
            },
          },
        }),
        stderr: '',
        exitCode: 0,
      };
    }
    if (args[1] === 'graphql') {
      return {
        stdout: JSON.stringify({ data: { repository: { issueTemplates: [] } } }),
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: 'nope', exitCode: 1 };
  });

  it('finds the forms that the issueTemplates connection cannot see', async () => {
    // GitHub exposes organization Issue *Forms* only as files in the org's
    // `.github` repository; without this, such a repository looks like one with
    // no templates and would be given a local copy of the organization's.
    const policy = (await state(orgForms)).policy;

    expect(policy.issues.templates.map((t) => t.type)).toEqual(['Idea', 'Bug']);
    expect(policy.issues.templates.every((t) => t.origin === 'organization')).toBe(true);
  });

  it('creates no local template, and no competing conventions document', async () => {
    const result = await plan(orgForms);

    expect(pathsOf(result.actions, 'create').filter((p) => p.includes('ISSUE_TEMPLATE'))).toEqual(
      [],
    );
    expect(pathsOf(result.actions, 'create')).not.toContain('docs/conventions.md');
    expect(pathsOf(result.actions, 'keep')).toContain('docs/conventions.md');
  });
});
