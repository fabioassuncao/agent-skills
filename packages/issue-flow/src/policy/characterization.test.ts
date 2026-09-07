import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPolicyCliOverrides } from '../config.js';
import { CHANGE_TYPES, resolveGitConvention } from '../conventions/git/index.js';
import { loadRepositoryPolicy, resetPolicyCache } from './resolve.js';
import type { PolicyExec, RepositoryPolicy } from './types.js';

/**
 * Characterization tests G4–G7 of the WebMux absorption (§34).
 *
 * They pin the posture change of ADR-11: the repository declares and Issue Flow
 * yields; the repository is silent and Issue Flow decides. G1–G3 and G8–G11 are
 * pure and live in `src/conventions/git/characterization.test.ts`.
 */

let root: string;
const warn = vi.fn();

/** No `gh`, no remote git: discovery must stay a filesystem question here. */
const noTooling = vi.fn<PolicyExec>(async () => ({
  stdout: '',
  stderr: 'command not found',
  exitCode: 127,
}));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'issue-flow-g-conventions-'));
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

function load(exec: PolicyExec = noTooling): Promise<RepositoryPolicy> {
  return loadRepositoryPolicy({ root, env: {}, cli: {}, warn, exec, cache: false });
}

describe('G4 — the repository declares its commit convention', () => {
  it('discovers commitlint and turns the Issue Flow vocabulary off', async () => {
    await write(
      'commitlint.config.js',
      `module.exports = {
         extends: ['@commitlint/config-conventional'],
         rules: { 'type-enum': [2, 'always', ['feat', 'fix', 'chore']] },
       };`,
    );

    const policy = await load();
    expect(policy.git.commitConvention).toBe('conventional');
    expect(policy.git.allowedTypes).toEqual(['feat', 'fix', 'chore']);
    expect(
      policy.sources.some((s) => s.kind === 'git-conventions' && s.status === 'declared'),
    ).toBe(true);

    const convention = resolveGitConvention({ ...policy.git, declared: true });
    expect(convention.commit.format).toBe('conventional');
    expect(convention.commit.types).toEqual(['feat', 'fix', 'chore']);
    expect(convention.commit.types).not.toEqual(CHANGE_TYPES);
  });

  it('accepts any type the repository uses when it declares a convention without a list', async () => {
    await write('.husky/commit-msg', '#!/bin/sh\nnpx --no -- commitlint --edit "$1"\n');

    const policy = await load();
    const convention = resolveGitConvention({ ...policy.git, declared: true });
    expect(convention.commit.types).toBe('any');
  });
});

describe('G5 — an explicit rule beats every discovered source', () => {
  it('lets .issue-flow.json override a discovered commitlint config', async () => {
    await write(
      'commitlint.config.js',
      "module.exports = { rules: { 'type-enum': [2, 'always', ['feat', 'fix']] } };",
    );
    await write(
      '.issue-flow.json',
      JSON.stringify({ policy: { git: { commitConvention: 'free' } } }),
    );

    const policy = await load();
    expect(policy.git.commitConvention).toBe('free');
    expect(resolveGitConvention({ ...policy.git, declared: true }).commit.format).toBe('free');
  });

  it('surfaces the rule an AGENTS.md carries as a document the phase must read', async () => {
    await write(
      'AGENTS.md',
      '# Rules\n\nCommits follow our own format, not Conventional Commits.\n',
    );

    const policy = await load();
    expect(policy.docs.map((doc) => doc.path)).toContain('AGENTS.md');
    expect(policy.docs.find((doc) => doc.path === 'AGENTS.md')?.content).toContain(
      'not Conventional Commits',
    );
  });
});

describe('G6 — the repository declares nothing', () => {
  it('resolves to the Issue Flow default', async () => {
    const policy = await load();
    expect(policy.git.commitConvention).toBeNull();
    expect(policy.git.allowedTypes).toBeNull();
    expect(policy.git.commitTemplate).toBeNull();

    const convention = resolveGitConvention({ ...policy.git });
    expect(convention.commit.format).toBe('conventional');
    expect(convention.commit.types).toEqual(CHANGE_TYPES);
    expect(convention.branch.pattern).toBe('{type}/{N}-{slug}');
  });
});

describe('G7 — the repository ships a .gitmessage template', () => {
  it('discovers the template and stops imposing the Issue Flow format', async () => {
    await write('.gitmessage', '# <type>: <summary>\n#\n# Why:\n#\n# Ticket:\n');

    const policy = await load();
    expect(policy.git.commitTemplate).toContain('# Why:');
    expect(
      policy.sources.some(
        (s) => s.kind === 'git-conventions' && s.path === '.gitmessage' && s.status === 'declared',
      ),
    ).toBe(true);

    const convention = resolveGitConvention({ ...policy.git, declared: true });
    expect(convention.commit.format).toBe('free');
    expect(convention.commit.template).toContain('# Why:');
  });
});

describe('inferred sources inform but never disable the fallback', () => {
  it('records a history-inferred convention without yielding the vocabulary', async () => {
    const gitLog: PolicyExec = async (command, args) => {
      if (command === 'git' && args[0] === 'log') {
        return {
          stdout: [
            'feat(core): add failover probe',
            'fix(web): recover the created PR',
            'docs: describe the ladder',
            'chore: bump deps',
          ].join('\n'),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: 'command not found', exitCode: 127 };
    };

    const policy = await load(gitLog);
    expect(
      policy.sources.some((s) => s.kind === 'git-conventions' && s.status === 'inferred'),
    ).toBe(true);
    expect(policy.git.commitConvention).toBe('conventional');

    // `inferred` alone never turns the Issue Flow vocabulary off.
    const convention = resolveGitConvention({ ...policy.git });
    expect(convention.commit.types).toEqual(CHANGE_TYPES);
  });
});
