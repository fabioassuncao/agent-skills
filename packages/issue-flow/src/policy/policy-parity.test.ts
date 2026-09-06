import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPolicyCliOverrides } from '../config.js';
import { reconcileLabels } from '../issues/label-policy.js';
import { conventionPlaceholders } from './placeholders.js';
import { loadRepositoryPolicy, resetPolicyCache } from './resolve.js';
import { POLICY_SCHEMA_VERSION, type PolicyExec, type RepositoryPolicy } from './types.js';

/**
 * Parity between the CLI and the Agent Skills.
 *
 * Both surfaces consume canonical repository decisions. Skills carry their own
 * generated references and pure helpers; policy JSON is optional enrichment.
 * Its versioned field names remain a public integration contract.
 *
 * These tests pin deterministic inputs/decisions and generated reference parity,
 * never the wording of an LLM's output. Behavior is evaluated separately by the
 * isolated Skill scenarios.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const SHARED_BLOCK = join(REPO_ROOT, 'skills-src/_shared/repository-policy.md');

async function sharedPolicy(): Promise<string> {
  const policy = await readFile(SHARED_BLOCK, 'utf-8');
  const decisions = await readFile(
    join(REPO_ROOT, 'skills-src/_shared/repository-decisions.md'),
    'utf-8',
  );
  return policy.replace('<!-- contract:repository-decisions -->', decisions.trimEnd());
}

/** Skills that take a policy decision and must therefore read the shared block. */
const POLICY_AWARE_SKILLS = [
  'resolve-issue',
  'init-repository',
  'generate-issue',
  'generate-local-issue',
  'analyze-issue',
  'create-pr',
  'review-issue',
  'review-pr',
  'convert-prd-to-json',
  'execute-tasks',
  'generate-prd',
];

/** The JSON fields the shared block tells a skill to read. */
const CONTRACT_FIELDS = [
  'issues.templates',
  'issues.types',
  'issues.labels',
  'issues.titleConvention',
  'issues.allowLabelCreation',
  'pullRequests.template',
  'pullRequests.baseBranch',
  'git.branchConvention',
  'git.commitConvention',
  'git.pullRequestTitleConvention',
  'git.issueReference',
  'git.typeMap',
  'git.allowedTypes',
  'git.scopes',
  'git.commitTemplate',
  'git.declared',
  'docs',
  'codeowners',
  'schemaVersion',
];

let root: string;
const warn = vi.fn();

const noTooling = vi.fn<PolicyExec>(async () => ({
  stdout: '',
  stderr: 'command not found',
  exitCode: 127,
}));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'issue-flow-parity-'));
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

describe('portable policy contracts', () => {
  it('materializes the canonical policy in every policy-aware artifact', async () => {
    const source = await sharedPolicy();
    for (const skill of POLICY_AWARE_SKILLS) {
      const installed = await readFile(
        join(REPO_ROOT, 'skills', skill, 'references/repository-policy.md'),
        'utf-8',
      );
      expect(installed.replace(/^<!-- Generated[^\n]+-->\n\n/, ''), skill).toBe(source);
    }
  });

  it('keeps the versioned optional CLI payload documented', async () => {
    const integration = await readFile(
      join(REPO_ROOT, 'skills-src/_shared/cli-integration.md'),
      'utf-8',
    );
    for (const field of CONTRACT_FIELDS) expect(integration, field).toContain(field);
  });
});

describe('neither path creates labels', () => {
  it('drops a label the repository does not have, on both paths', async () => {
    // The CLI path: reconcileLabels is what commands/generate.ts applies.
    const known = [{ name: 'bug', description: null, color: null }];
    expect(reconcileLabels(['bug', 'high'], known)).toEqual({
      labels: ['bug'],
      missing: ['high'],
    });
  });

  it('keeps label creation opt-in in the portable contract', async () => {
    const block = await sharedPolicy();
    expect(block).toContain('issues.allowLabelCreation');
  });
});

describe('both paths decide from the same resolved policy', () => {
  it('agrees on the base branch, the one decision with an active defect behind it', async () => {
    await write(
      '.issue-flow.json',
      JSON.stringify({ policy: { pullRequests: { baseBranch: 'develop' } } }),
    );

    const policy = await load();

    // The CLI path: what the prompt renders into `git log`, `git diff` and
    // `gh pr create --base`.
    expect(conventionPlaceholders(policy, 'main').__BASE_BRANCH__).toBe('develop');
    // The skill path: the same field, read out of `--json`.
    expect(policy.pullRequests.baseBranch).toBe('develop');
  });

  it('agrees on the templates, the types and the labels', async () => {
    await write(
      '.github/ISSUE_TEMPLATE/bug.yml',
      ['name: Bug', 'description: Something broke', 'labels: ["bug"]', 'type: Bug'].join('\n'),
    );
    const exec = vi.fn<PolicyExec>(async (command, args) => {
      if (command === 'gh' && args[0] === 'label') {
        return {
          stdout: JSON.stringify([{ name: 'bug', description: 'Broken', color: 'd73a4a' }]),
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: 'nope', exitCode: 1 };
    });

    const policy = await load(exec);

    expect(policy.issues.templates.map((t) => t.name)).toEqual(['Bug']);
    expect(policy.issues.templates[0]?.type).toBe('Bug');
    expect(policy.issues.labels.map((l) => l.name)).toEqual(['bug']);
    // And the decision both paths derive from it.
    expect(reconcileLabels(['bug', 'invented'], policy.issues.labels).labels).toEqual(['bug']);
  });

  it('agrees on the branch convention', async () => {
    await write(
      '.issue-flow.json',
      JSON.stringify({ policy: { git: { branchConvention: 'feat/{slug}' } } }),
    );

    const policy = await load();

    expect(policy.git.branchConvention).toBe('feat/{slug}');
    expect(conventionPlaceholders(policy, 'main').__BRANCH_CONVENTION__).toBe('feat/{slug}');
  });

  it('resolves the monorepo scope both paths pass in', async () => {
    await write('AGENTS.md', '# Root');
    await write('apps/api/AGENTS.md', '# API');

    const policy = await loadRepositoryPolicy({
      root,
      scope: 'apps/api',
      env: {},
      warn,
      exec: noTooling,
      cache: false,
    });

    expect(policy.scope).toBe('apps/api');
    expect(policy.docs.map((d) => d.path)).toEqual(['AGENTS.md', 'apps/api/AGENTS.md']);
  });

  it('gives both paths the same nothing for a repository that declares nothing', async () => {
    const policy = await load();

    expect(policy.schemaVersion).toBe(POLICY_SCHEMA_VERSION);
    expect(conventionPlaceholders(policy, 'main').__BASE_BRANCH__).toBe('main');
    expect(policy.issues.labels).toEqual([]);
    expect(policy.issues.templates).toEqual([]);
    // Unvalidatable labels pass through: "discovery was offline" is not
    // "the repository has no labels", on either path.
    expect(reconcileLabels(['anything'], policy.issues.labels).labels).toEqual(['anything']);
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * Every git subcommand that can reach the network. Local-only discovery reads
 * the repository — `git config`, `git log`, `git for-each-ref` — but must never
 * touch a remote, and must never invoke `gh` at all.
 */
const REMOTE_GIT_SUBCOMMANDS = ['fetch', 'pull', 'push', 'ls-remote', 'clone', 'remote'];

it('local-only policy discovery does not call gh or remote git commands', async () => {
  const exec = vi.fn<PolicyExec>(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
  await loadRepositoryPolicy({ root, exec, remote: false, cache: false, warn });

  for (const [command, args] of exec.mock.calls) {
    expect(command, 'gh is a remote round-trip').not.toBe('gh');
    expect(command).toBe('git');
    expect(REMOTE_GIT_SUBCOMMANDS).not.toContain(args[0]);
    expect(args.join(' '), 'refs/remotes is what origin/HEAD discovery reads').not.toContain(
      'refs/remotes',
    );
  }
});
