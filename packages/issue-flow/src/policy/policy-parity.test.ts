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
 * The two are paths to the same outcome, and a user is entitled to the same
 * decisions from both. The skills are markdown and cannot import TypeScript, so
 * `issue-flow policy --json` is the only bridge — which makes its payload a
 * published contract rather than a debugging convenience.
 *
 * This file pins **decisions**, never generated text: an LLM's prose is not
 * deterministic, and asserting on it would pin nothing. What it pins is the
 * inputs both paths decide from — the chosen template, the surviving labels, the
 * Issue Type, the title convention and the base branch — plus the field names
 * the skills read out of the JSON. Rename one of those and every skill silently
 * falls back to its defaults: nothing fails, and the two paths quietly diverge.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const SHARED_BLOCK = join(REPO_ROOT, 'skills/_shared/repository-policy.md');

/** Skills that take a policy decision and must therefore read the shared block. */
const POLICY_AWARE_SKILLS = [
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

describe('the shared block is referenced, never copied', () => {
  it('exists and documents the contract fields the skills read', async () => {
    const block = await readFile(SHARED_BLOCK, 'utf-8');

    for (const field of CONTRACT_FIELDS) {
      const leaf = field.split('.').pop() as string;
      expect(block, field).toContain(leaf);
    }
  });

  it('states the best-effort contract, which is what keeps a skill offline-safe', async () => {
    const block = await readFile(SHARED_BLOCK, 'utf-8');

    expect(block).toContain('Best-effort');
    expect(block).toContain('Never fail');
    // A skill that needs the network to work is a regression, and the block has
    // to say so, because that is the rule a future author is most likely to drop.
    expect(block).toContain('regression');
  });

  it('is referenced by every skill that takes a policy decision', async () => {
    for (const skill of POLICY_AWARE_SKILLS) {
      const content = await readFile(join(REPO_ROOT, 'skills', skill, 'SKILL.md'), 'utf-8');
      expect(content, skill).toContain('_shared/repository-policy.md');
    }
  });

  it('is the only place that spells out how to invoke the command', async () => {
    // "One source, many references" — a skill that re-derives the invocation is
    // a skill that will drift from it.
    for (const skill of POLICY_AWARE_SKILLS) {
      const content = await readFile(join(REPO_ROOT, 'skills', skill, 'SKILL.md'), 'utf-8');
      expect(content, skill).not.toContain('issue-flow policy --json');
    }
  });
});

describe('initialization has one core behind both interfaces', () => {
  it('gives the skill the same plan the CLI renders', async () => {
    const skill = await readFile(join(REPO_ROOT, 'skills/init-repository/SKILL.md'), 'utf-8');

    // The skill does not re-derive the analysis: it asks the CLI, which is the
    // only way "one core, two interfaces" can be true rather than aspirational.
    expect(skill).toContain('issue-flow init --json');
    expect(skill).toContain('issue-flow init --apply');
  });

  it('tells the skill to fall back rather than fail when the CLI is absent', async () => {
    const skill = (await readFile(join(REPO_ROOT, 'skills/init-repository/SKILL.md'), 'utf-8'))
      .split(/\s+/)
      .join(' ');

    expect(skill).toContain('If the CLI is not available');
    expect(skill).toContain('do not tell the user to install anything');
  });

  it('states the non-destructive rule in the skill, not only in the code', async () => {
    const skill = (await readFile(join(REPO_ROOT, 'skills/init-repository/SKILL.md'), 'utf-8'))
      .split(/\s+/)
      .join(' ');

    expect(skill).toContain('Never overwrite a convention that exists');
  });

  it('documents the same agent entry-point chain the scaffolding writes', async () => {
    const skill = await readFile(join(REPO_ROOT, 'skills/init-repository/SKILL.md'), 'utf-8');

    expect(skill).toContain('CLAUDE.md  →  AGENTS.md');
    expect(skill).toContain('Read and follow the instructions in AGENTS.md.');
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

  it('tells the skills the same thing, in the shared block', async () => {
    // Whitespace-normalized: the block is prose and wraps, so a line break must
    // not be the thing that decides whether this rule is still stated.
    const block = (await readFile(SHARED_BLOCK, 'utf-8')).split(/\s+/).join(' ');

    expect(block).toContain('Never create one');
    expect(block).toContain('allowLabelCreation');
  });

  it('leaves label creation behind an explicit opt-in, off by default', async () => {
    const skill = await readFile(join(REPO_ROOT, 'skills/generate-issue/SKILL.md'), 'utf-8');

    // The only surviving `gh label create` sits inside the opt-in branch.
    const occurrences = skill.split('gh label create').length - 1;
    expect(occurrences).toBe(1);
    expect(skill).toContain('Never create a label');
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
