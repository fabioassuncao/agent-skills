import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY_CONTEXT_BUDGET,
  emptyPolicyPlaceholders,
  estimateTokens,
  isEmptyPolicy,
  POLICY_PLACEHOLDER_KEYS,
  policyPlaceholders,
  renderPolicySummary,
} from './placeholders.js';
import { POLICY_SCHEMA_VERSION, type RepositoryPolicy } from './types.js';

function makePolicy(overrides: Partial<RepositoryPolicy> = {}): RepositoryPolicy {
  return {
    schemaVersion: POLICY_SCHEMA_VERSION,
    root: '/repo',
    scope: null,
    enabled: true,
    issues: { templates: [], types: [], labels: [], titleConvention: null },
    pullRequests: { template: null, templates: [], baseBranch: null, titleConvention: null },
    git: { branchConvention: null, commitConvention: null },
    docs: [],
    codeowners: null,
    sources: [],
    ...overrides,
  };
}

const richPolicy = makePolicy({
  issues: {
    templates: [
      {
        path: '.github/ISSUE_TEMPLATE/bug.yml',
        format: 'form',
        origin: 'filesystem',
        name: 'Bug Report',
        about: 'Something broke',
        title: '[Bug]: ',
        labels: ['bug'],
        type: 'Bug',
        assignees: [],
        content: '## Steps',
      },
    ],
    types: ['Bug', 'Feature'],
    labels: [
      { name: 'bug', description: "Something isn't working", color: 'd73a4a' },
      { name: 'chore', description: null, color: null },
    ],
    titleConvention: '[Area] Title',
  },
  pullRequests: {
    template: '## What changed\n\n## How was it tested',
    templates: [
      {
        path: '.github/PULL_REQUEST_TEMPLATE.md',
        name: 'PULL_REQUEST_TEMPLATE.md',
        content: '## What changed\n\n## How was it tested',
      },
    ],
    baseBranch: 'develop',
    titleConvention: 'type(scope): subject',
  },
  git: { branchConvention: 'feat/{slug}', commitConvention: 'conventional' },
  docs: [
    { path: 'AGENTS.md', kind: 'agents', scope: '', referencedFrom: null, content: '# Agents' },
    {
      path: 'apps/api/AGENTS.md',
      kind: 'agents',
      scope: 'apps/api',
      referencedFrom: null,
      content: '# API',
    },
  ],
});

describe('emptyPolicyPlaceholders', () => {
  it('produces every documented placeholder, all empty', () => {
    const empty = emptyPolicyPlaceholders();

    expect(Object.keys(empty).sort()).toEqual([...POLICY_PLACEHOLDER_KEYS].sort());
    expect(Object.values(empty).every((value) => value === '')).toBe(true);
  });
});

describe('policyPlaceholders', () => {
  it('is entirely empty for a null policy', () => {
    expect(policyPlaceholders(null)).toEqual(emptyPolicyPlaceholders());
  });

  it('is entirely empty for a repository that declares nothing', () => {
    expect(policyPlaceholders(makePolicy())).toEqual(emptyPolicyPlaceholders());
  });

  it('is entirely empty when discovery is disabled', () => {
    expect(policyPlaceholders(makePolicy({ enabled: false }))).toEqual(emptyPolicyPlaceholders());
  });

  it('fills every placeholder from a complete policy', () => {
    const vars = policyPlaceholders(richPolicy);

    expect(vars.__REPO_BASE_BRANCH__).toBe('develop');
    expect(vars.__REPO_ISSUE_TYPES__).toBe('Bug, Feature');
    expect(vars.__REPO_ISSUE_TEMPLATES__).toContain('**Bug Report**');
    expect(vars.__REPO_ISSUE_TEMPLATES__).toContain('type: Bug');
    expect(vars.__REPO_LABELS__).toContain("- bug — Something isn't working");
    expect(vars.__REPO_LABELS__).toContain('- chore');
    expect(vars.__REPO_PR_TEMPLATE__).toBe('## What changed\n\n## How was it tested');
    expect(vars.__REPO_CONVENTIONS__).toContain('- Branch: feat/{slug}');
    expect(vars.__REPO_CONVENTIONS__).toContain('- Commit: conventional');
    expect(vars.__REPO_POLICY__).not.toBe('');
  });

  it('lists document paths and never their content', () => {
    const vars = policyPlaceholders(richPolicy);

    expect(vars.__REPO_DOCS__).toContain('`AGENTS.md`');
    expect(vars.__REPO_DOCS__).toContain('`apps/api/AGENTS.md` (applies to `apps/api/`)');
    // The content of every discovered document, verbatim, must never appear.
    for (const doc of richPolicy.docs) {
      expect(vars.__REPO_DOCS__).not.toContain(doc.content);
      expect(vars.__REPO_POLICY__).not.toContain(doc.content);
    }
  });
});

describe('renderPolicySummary', () => {
  it('includes every section when the budget is ample', () => {
    const summary = renderPolicySummary(richPolicy, DEFAULT_POLICY_CONTEXT_BUDGET);

    for (const heading of [
      '### Base branch',
      '### Conventions',
      '### Issue Types',
      '### Issue Templates',
      '### Labels',
      '### Policy documents',
    ]) {
      expect(summary).toContain(heading);
    }
  });

  it('skips a section the repository has nothing for', () => {
    const summary = renderPolicySummary(
      makePolicy({
        issues: { templates: [], types: [], labels: [], titleConvention: null },
        pullRequests: {
          template: null,
          templates: [],
          baseBranch: 'main',
          titleConvention: null,
        },
      }),
      DEFAULT_POLICY_CONTEXT_BUDGET,
    );

    expect(summary).toContain('### Base branch');
    expect(summary).not.toContain('### Labels');
    expect(summary).not.toContain('### Issue Templates');
  });

  it('stays within the budget it was given', () => {
    const many = makePolicy({
      issues: {
        templates: [],
        types: [],
        labels: Array.from({ length: 300 }, (_, i) => ({
          name: `label-${i}`,
          description: 'a reasonably long description that costs real tokens',
          color: null,
        })),
        titleConvention: null,
      },
      pullRequests: { template: null, templates: [], baseBranch: 'main', titleConvention: null },
    });

    const summary = renderPolicySummary(many, 200);

    expect(estimateTokens(summary)).toBeLessThanOrEqual(200);
  });

  it('degrades an oversized essential section to a pointer, never a truncation', () => {
    const many = makePolicy({
      issues: {
        templates: [],
        types: [],
        labels: Array.from({ length: 300 }, (_, i) => ({
          name: `label-${i}`,
          description: 'a reasonably long description that costs real tokens',
          color: null,
        })),
        titleConvention: null,
      },
      pullRequests: { template: null, templates: [], baseBranch: 'main', titleConvention: null },
    });

    const summary = renderPolicySummary(many, 200);

    expect(summary).toContain('### Labels');
    expect(summary).toContain('Run `gh label list`');
    // Nothing is cut mid-way: no partial label survives.
    expect(summary).not.toContain('- label-0 —');
  });

  it('keeps the essentials and drops the rest when the budget is tight', () => {
    const summary = renderPolicySummary(richPolicy, 60);

    expect(summary).toContain('### Base branch');
    expect(summary).toContain('develop');
    // Documents are the first to go: they are pointers to begin with.
    expect(summary).not.toContain('### Policy documents');
  });
});

describe('isEmptyPolicy', () => {
  it('is true for a policy carrying nothing actionable', () => {
    expect(isEmptyPolicy(makePolicy())).toBe(true);
  });

  it('is false as soon as one source answered', () => {
    expect(
      isEmptyPolicy(
        makePolicy({
          pullRequests: {
            template: null,
            templates: [],
            baseBranch: 'main',
            titleConvention: null,
          },
        }),
      ),
    ).toBe(false);
  });

  it('ignores `sources`, which is provenance and not policy', () => {
    expect(
      isEmptyPolicy(
        makePolicy({
          sources: [
            { kind: 'labels', origin: 'gh', path: null, status: 'unavailable', detail: 'no gh' },
          ],
        }),
      ),
    ).toBe(true);
  });
});
