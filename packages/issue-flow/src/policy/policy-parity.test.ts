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
 * The skills are markdown and cannot import TypeScript, so the contract between
 * them lives in `skills/_shared/contracts/`, materialised by
 * `scripts/sync-skill-contracts.mjs` into each skill's `references/` and into
 * `prompts/_contracts/` for the headless prompts. The copies are *inside* the
 * skill on purpose: every real installer — `npx skills`, Cursor, Codex,
 * OpenCode, Antigravity — copies only the directory holding the SKILL.md, so a
 * `../_shared/` link resolves here and dangles everywhere it is used.
 *
 * This file pins **decisions**, never generated text: an LLM's prose is not
 * deterministic, and asserting on it would pin nothing. What it pins is the
 * inputs both paths decide from — the chosen template, the surviving labels, the
 * Issue Type, the title convention and the base branch — plus the field names
 * the skills read out of the JSON. Rename one of those and every skill silently
 * falls back to its defaults: nothing fails, and the two paths quietly diverge.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

/** The canonical source every consumer is generated from. */
const CONTRACTS = join(REPO_ROOT, 'skills/_shared/contracts');
const CONVENTIONS = join(CONTRACTS, 'repository-conventions.md');

/**
 * Read a reference a skill cites, from wherever it actually lives.
 *
 * The working tree holds sources: a reference the skill owns sits in its own
 * `references/`, and a shared one sits in `skills/_shared/contracts/` until
 * `build-skills-tree.mjs` materialises it. Both are the same file to a reader,
 * which is what this resolves.
 */
async function readReference(skill: string, contract: string): Promise<string> {
  try {
    return await readFile(join(REPO_ROOT, 'skills', skill, 'references', contract), 'utf-8');
  } catch {
    return readFile(join(CONTRACTS, contract), 'utf-8');
  }
}

/**
 * Every skill that decides anything from the repository's policy.
 *
 * All of them must state the two invariants; only the ones that decide from the
 * *whole* policy carry the full contract. Shipping 151 lines of policy prose to
 * a skill that needs four of them is duplication with no reader.
 */
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

/** The ones that decide from the whole policy, and therefore carry it. */
const DEEP_POLICY_SKILLS = [
  'init-repository',
  'generate-issue',
  'generate-local-issue',
  'create-pr',
  'review-issue',
  'review-pr',
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

describe('the conventions contract travels inside every skill', () => {
  it('documents the fields the skills read out of the JSON', async () => {
    const contract = await readFile(CONVENTIONS, 'utf-8');

    for (const field of CONTRACT_FIELDS) {
      const leaf = field.split('.').pop() as string;
      expect(contract, field).toContain(leaf);
    }
  });

  it("documents the full payload where the CLI's other --json contracts live", async () => {
    // The annotated schema is the output contract of a command, so it belongs
    // in the command reference — next to pr-review's `index.json` — not copied
    // into every skill that only needs to know which fields to read.
    const commands = await readFile(join(REPO_ROOT, 'docs/commands.md'), 'utf-8');
    const section = commands.slice(commands.indexOf('### `policy`'));

    for (const field of CONTRACT_FIELDS) {
      const leaf = field.split('.').pop() as string;
      expect(section, field).toContain(leaf);
    }
  });

  it('states the best-effort rule, which is what keeps a skill offline-safe', async () => {
    const contract = await readFile(CONVENTIONS, 'utf-8');

    expect(contract).toContain('Never block on this');
    expect(contract).toContain('Never fail');
    // A skill that needs the network to work is a regression, and the contract
    // has to say so, because that is the rule a future author is most likely to
    // drop.
    expect(contract).toContain('regression');
  });

  it('offers a provider that does not need the CLI at all', async () => {
    // The whole point of the rewrite: "no CLI" must mean "read the repository
    // yourself", not "fall through to defaults". Otherwise the CLI is a
    // prerequisite for quality wearing the costume of an optimisation.
    const contract = await readFile(CONVENTIONS, 'utf-8');

    expect(contract).toContain('Read the repository directly');
    expect(contract).toContain('.github/ISSUE_TEMPLATE');
    expect(contract).toContain('gh label list');
    expect(contract).toContain('This is not a degraded mode');
  });

  it('is cited by every skill that decides from the whole policy', async () => {
    for (const skill of DEEP_POLICY_SKILLS) {
      const content = await readFile(join(REPO_ROOT, 'skills', skill, 'SKILL.md'), 'utf-8');

      // `references/…`, never `../` — the citation has to resolve inside the
      // skill once the tree is assembled, which is the whole portability rule.
      expect(content, skill).toContain('references/repository-conventions.md');
      expect(content, skill).not.toContain('../');

      expect(await readReference(skill, 'repository-conventions.md'), skill).toContain(
        'Repository conventions',
      );
    }
  });

  it('states each invariant in every skill that could violate it, file or not', async () => {
    // This is the parity that matters: both paths must refuse to invent a label
    // and must refuse to assume the base branch. Whether the skill carries the
    // full contract or four lines of its own prose is a packaging detail; these
    // two decisions are the contract.
    /** Skills that apply a label to something. */
    const LABEL_SKILLS = ['generate-issue', 'generate-local-issue', 'create-pr', 'init-repository'];
    /** Skills that target or diff against a base branch. */
    const BASE_BRANCH_SKILLS = ['create-pr', 'review-issue', 'review-pr', 'convert-prd-to-json'];

    async function policyText(skill: string): Promise<string> {
      const skillMd = await readFile(join(REPO_ROOT, 'skills', skill, 'SKILL.md'), 'utf-8');
      let text = skillMd;

      // Only what this skill actually cites: a rule stated in a contract it
      // does not carry is a rule it never sees.
      for (const ref of ['repository-conventions.md', 'git-conventions.md']) {
        if (!skillMd.includes(`references/${ref}`)) continue;
        text += await readReference(skill, ref);
      }

      return text.split(/\s+/).join(' ');
    }

    for (const skill of LABEL_SKILLS) {
      expect(await policyText(skill), `${skill}: never create a label`).toMatch(
        /[Nn]ever create (a |one )?label|Never create one/,
      );
    }

    for (const skill of BASE_BRANCH_SKILLS) {
      expect(await policyText(skill), `${skill}: never assume main`).toMatch(
        /[Nn]ever assume `?main`?|Never stop at .main. exists/,
      );
    }
  });

  it('never lets a skill point outside its own directory', async () => {
    // The defect this whole layout exists to prevent, pinned where a future
    // author will trip over it rather than ship it.
    for (const skill of POLICY_AWARE_SKILLS) {
      const content = await readFile(join(REPO_ROOT, 'skills', skill, 'SKILL.md'), 'utf-8');
      expect(content, skill).not.toContain('../_shared/');
      expect(content, skill).not.toContain('../../docs/');
    }
  });

  it('is the only place a skill carrying it spells out the invocation', async () => {
    // A skill that carries the contract and *also* restates the command has two
    // copies of one instruction, and they drift. A skill that carries no
    // contract has to state it — that is the whole point of the short form.
    for (const skill of DEEP_POLICY_SKILLS) {
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

    // The fallback is a real second provider, not a shrug: the skill derives
    // the same plan by reading the repository.
    expect(skill).toContain('Without it');
    expect(skill).toContain('do not tell the user to install anything');
    expect(skill).toContain('Derive the same plan by reading the repository');
  });

  it('states the non-destructive rule in the skill, not only in the code', async () => {
    const skill = (await readFile(join(REPO_ROOT, 'skills/init-repository/SKILL.md'), 'utf-8'))
      .split(/\s+/)
      .join(' ');

    expect(skill).toContain('Never overwrite a convention that exists');
  });

  it('documents the same agent entry-point chain the scaffolding writes', async () => {
    // The chain lives in the bundled reference, so it travels with the skill
    // wherever it is installed rather than in a doc of this repository.
    const reference = await readFile(
      join(REPO_ROOT, 'skills/init-repository/references/repository-scaffold.md'),
      'utf-8',
    );

    expect(reference).toContain('CLAUDE.md  →  AGENTS.md');
    expect(reference).toContain('Read and follow the instructions in AGENTS.md.');

    // And the migration that promotes one into the other stays in the skill,
    // because it is a step, not a reference.
    const skill = await readFile(join(REPO_ROOT, 'skills/init-repository/SKILL.md'), 'utf-8');
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

  it('tells the skills the same thing, in the conventions contract', async () => {
    // Whitespace-normalized: the contract is prose and wraps, so a line break
    // must not be the thing that decides whether this rule is still stated.
    const contract = (await readFile(CONVENTIONS, 'utf-8')).split(/\s+/).join(' ');

    expect(contract).toContain('Never create one');
    expect(contract).toContain('allowLabelCreation');
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
