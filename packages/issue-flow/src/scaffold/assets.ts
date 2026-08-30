import {
  DEFAULT_COMMIT_CONVENTION,
  DEFAULT_ISSUE_TYPES,
  DEFAULT_LABELS,
  type DefaultIssueType,
  FALLBACK_TYPE_LABELS,
  NON_TYPES,
} from '../conventions/defaults.js';
import { DEFAULT_BRANCH_CONVENTION } from '../conventions/git/index.js';

/**
 * The files initialization can write, rendered from the default convention set.
 *
 * Nothing here is a literal copy of a template: every asset is generated from
 * `conventions/defaults.ts`, so the convention and the files that express it can
 * never disagree. Changing a type or a label changes the forms, the labels file
 * and the documentation in one edit.
 */

export interface ScaffoldAsset {
  /** Repository-relative path, POSIX separators. */
  path: string;
  content: string;
  /**
   * Why this file exists. Shown in the plan, so a user can decline a specific
   * one and understand what they are declining.
   */
  purpose: string;
  /**
   * `required` files are what makes a repository legible to an agent at all.
   * `recommended` ones are worth having; `contextual` ones are only proposed
   * when the repository's state calls for them.
   */
  tier: 'required' | 'recommended' | 'contextual';
}

/** Fields every executable type needs, and no type should be without. */
function acceptanceCriteriaField(): string {
  return [
    '  - type: textarea',
    '    id: acceptance',
    '    attributes:',
    '      label: Acceptance criteria',
    '      description: How anyone can tell this is done. Checks that fail today and pass afterwards.',
    '      value: |',
    '        - [ ] ',
    '    validations:',
    '      required: true',
  ].join('\n');
}

function referencesField(): string {
  return [
    '  - type: textarea',
    '    id: references',
    '    attributes:',
    '      label: References',
    '      description: Links, related issues, prior discussion, evidence.',
  ].join('\n');
}

/**
 * One Issue Form per default type.
 *
 * `type:` is emitted so that an organization with Issue Types gets the native
 * field filled in; GitHub ignores the key when the type does not exist, so the
 * same file works either way.
 *
 * Required fields are rationed on purpose. `Idea` asks for exactly one, because
 * the cost of recording a thought has to stay near zero — a capture form with
 * eight mandatory fields is a form nobody uses, and the ideas then live in
 * someone's head instead.
 */
export function renderIssueForm(type: DefaultIssueType): string {
  const header = [
    `name: "${emojiFor(type.slug)} ${type.name}"`,
    `description: "${type.summary}"`,
    `type: "${type.name}"`,
    'body:',
  ];

  const bodies: Record<string, string[]> = {
    idea: [
      '  - type: markdown',
      '    attributes:',
      '      value: |',
      '        Quick capture. Only the first field is required — triage fills in the rest.',
      '        An Idea is **not approved work**: no agent implements it.',
      '  - type: textarea',
      '    id: idea',
      '    attributes:',
      '      label: The idea',
      '      description: What it is, in a few lines. It does not have to be solved or complete.',
      '    validations:',
      '      required: true',
      '  - type: textarea',
      '    id: problem',
      '    attributes:',
      '      label: Problem or opportunity',
      '      description: What pain or gain is behind it? Leave blank if you do not know yet.',
      referencesField(),
      '  - type: textarea',
      '    id: questions',
      '    attributes:',
      '      label: Open questions',
      '      description: What would have to be answered before deciding anything.',
    ],
    research: [
      '  - type: textarea',
      '    id: question',
      '    attributes:',
      '      label: Question to answer',
      '      description: The decision this investigation has to unblock.',
      '    validations:',
      '      required: true',
      '  - type: textarea',
      '    id: context',
      '    attributes:',
      '      label: Context',
      '      description: What is already known, and why the question is open.',
      '  - type: textarea',
      '    id: deliverable',
      '    attributes:',
      '      label: Expected deliverable',
      '      description: A conclusion and a recommendation. Say where durable knowledge will be written down.',
      '    validations:',
      '      required: true',
      referencesField(),
    ],
    epic: [
      '  - type: markdown',
      '    attributes:',
      '      value: |',
      '        An Epic is never executed directly: it is delivered through its sub-issues.',
      '  - type: textarea',
      '    id: objective',
      '    attributes:',
      '      label: Objective',
      '      description: The state of the product this Epic describes.',
      '    validations:',
      '      required: true',
      '  - type: textarea',
      '    id: scope',
      '    attributes:',
      '      label: Scope',
      '    validations:',
      '      required: true',
      '  - type: textarea',
      '    id: out-of-scope',
      '    attributes:',
      '      label: Out of scope',
      '      description: What this Epic deliberately does not cover. Absence here is what makes scope creep arguable.',
      '  - type: textarea',
      '    id: children',
      '    attributes:',
      '      label: Known sub-issues',
      '      description: Add them as sub-issues once they exist; list what you already foresee.',
    ],
    feature: [
      '  - type: textarea',
      '    id: problem',
      '    attributes:',
      '      label: Problem',
      '      description: What is not possible today, and for whom.',
      '    validations:',
      '      required: true',
      '  - type: textarea',
      '    id: objective',
      '    attributes:',
      '      label: Objective',
      '      description: What becomes true when this is done.',
      '    validations:',
      '      required: true',
      '  - type: textarea',
      '    id: scope',
      '    attributes:',
      '      label: Scope and out of scope',
      '      description: What is included, and what is deliberately not.',
      acceptanceCriteriaField(),
      '  - type: textarea',
      '    id: dependencies',
      '    attributes:',
      '      label: Dependencies and risks',
      '      description: What has to exist first, and what could go wrong.',
      referencesField(),
    ],
    bug: [
      '  - type: textarea',
      '    id: current',
      '    attributes:',
      '      label: Current behaviour',
      '    validations:',
      '      required: true',
      '  - type: textarea',
      '    id: expected',
      '    attributes:',
      '      label: Expected behaviour',
      '    validations:',
      '      required: true',
      '  - type: textarea',
      '    id: steps',
      '    attributes:',
      '      label: Steps to reproduce',
      '      value: |',
      '        1.',
      '        2.',
      '        3.',
      '    validations:',
      '      required: true',
      '  - type: input',
      '    id: environment',
      '    attributes:',
      '      label: Environment',
      '      description: Where it happens — environment, version, component, browser.',
      '    validations:',
      '      required: true',
      '  - type: textarea',
      '    id: evidence',
      '    attributes:',
      '      label: Evidence',
      '      description: Logs, request and response, screenshot, trace id, affected URL.',
      '  - type: dropdown',
      '    id: impact',
      '    attributes:',
      '      label: Impact',
      '      options:',
      '        - "Data loss or improper exposure"',
      '        - "Feature unavailable, no workaround"',
      '        - "Feature degraded, workaround exists"',
      '        - "Cosmetic or low consequence"',
      '    validations:',
      '      required: true',
      '  - type: textarea',
      '    id: done',
      '    attributes:',
      '      label: How to tell it is fixed',
      '      description: The check that fails today and passes afterwards.',
      '    validations:',
      '      required: true',
    ],
    task: [
      '  - type: textarea',
      '    id: what',
      '    attributes:',
      '      label: What has to be done',
      '    validations:',
      '      required: true',
      '  - type: textarea',
      '    id: why',
      '    attributes:',
      '      label: Why',
      '      description: The reason this is worth doing now.',
      '    validations:',
      '      required: true',
      acceptanceCriteriaField(),
      referencesField(),
    ],
  };

  const body = bodies[type.slug];
  if (body === undefined) {
    throw new Error(`No Issue Form body defined for type "${type.slug}"`);
  }

  return `${[...header, ...body].join('\n')}\n`;
}

function emojiFor(slug: string): string {
  const map: Record<string, string> = {
    idea: '💡',
    research: '🔬',
    epic: '🗺️',
    feature: '✨',
    bug: '🐛',
    task: '🔧',
  };
  return map[slug] ?? '📌';
}

/**
 * The template chooser configuration.
 *
 * `blank_issues_enabled: true` is deliberate: a contributor who does not fit any
 * form should open the issue anyway. A closed chooser turns a report into
 * silence, which costs more than an unstructured issue.
 */
export function renderIssueTemplateConfig(): string {
  return [
    'blank_issues_enabled: true',
    'contact_links:',
    '  - name: How this backlog works',
    '    url: https://github.com/fabioassuncao/issue-flow/blob/main/docs/conventions.md',
    '    about: Issue types, what each one authorizes, labels and the lifecycle.',
    '',
  ].join('\n');
}

/** The Pull Request template. */
export function renderPullRequestTemplate(): string {
  return [
    '## What changed',
    '',
    '<!-- What this Pull Request does, and why. One paragraph is enough. -->',
    '',
    '## How it was tested',
    '',
    '<!-- The checks you ran, and what they proved. "CI is green" is not a test plan. -->',
    '',
    '## Related issues',
    '',
    '<!--',
    'One `Closes #N` per issue this resolves, each on its own line and as plain body',
    'text — GitHub only auto-closes when the line is not inside a code fence.',
    '-->',
    '',
    '## Notes for reviewers',
    '',
    '<!-- Where to start, and anything you are unsure about. Write "N/A" rather than deleting a section. -->',
    '',
  ].join('\n');
}

/** `AGENTS.md`, generated as an index and nothing else. */
export function renderAgentsMd(projectName: string, referenced: string[]): string {
  const lines = [
    `# ${projectName}`,
    '',
    'This file is an **index**. It holds no rule, command or convention of its own —',
    'those live in the documents referenced below, which are the source of truth.',
    '',
    '> Document once. Reference everywhere it is needed.',
    '',
    '## Start here',
    '',
  ];

  for (const path of referenced) {
    lines.push(`- [\`${path}\`](${path})`);
  }
  if (referenced.length === 0) {
    lines.push('- [`README.md`](README.md) — what this project is, and how to run it');
  }

  lines.push(
    '',
    '## Working on an issue',
    '',
    '- [`docs/conventions.md`](docs/conventions.md) — issue types, labels, branches,',
    '  commits and Pull Requests: what this repository expects and what it does not',
    '',
    '## What does not belong in this file',
    '',
    'Anything that can live in a document of its own: build and test commands, code',
    'style, architecture rules, testing strategy, operational procedures. If it is a',
    'rule, a standard or reusable knowledge, it belongs in its own document and this',
    'file only points at it.',
    '',
    'An instruction that today exists **only** here does not stay here: move it to the',
    'right document and leave a reference behind. Duplicated instructions in an agent',
    'file age out of sight and start contradicting the source without anyone noticing.',
    '',
  );

  return lines.join('\n');
}

/**
 * `CLAUDE.md`, which is one line by design.
 *
 * Claude Code reads `CLAUDE.md` as its memory file, and the temptation is to
 * put the instructions there too. That produces two copies of the same rules
 * which diverge the first time only one of them is edited — so this file is a
 * bridge, never a second source.
 */
export function renderClaudeMd(): string {
  return 'Read and follow the instructions in AGENTS.md.\n';
}

/** The conventions document: the source of truth this scaffolding creates. */
export function renderConventionsDoc(hasIssueTypes: boolean): string {
  const typeRows = DEFAULT_ISSUE_TYPES.map(
    (t) =>
      `| **${t.name}** | ${t.summary} | ${t.executable ? 'Yes, once it is ready' : '**No**'} |`,
  ).join('\n');

  const nonTypeRows = NON_TYPES.map((n) => `| ${n.concept} | ${n.instead} | ${n.why} |`).join('\n');

  const labelRows = DEFAULT_LABELS.map((l) => `| \`${l.name}\` | ${l.description} |`).join('\n');

  const typeMechanism = hasIssueTypes
    ? 'This organization has GitHub Issue Types, so the type lives in the **native field**.'
    : [
        'This organization has no GitHub Issue Types, so the type is carried by a',
        '`type:*` label. If Issue Types are enabled later, move to them and drop these',
        'labels — keeping both would create a second truth that drifts.',
      ].join('\n');

  return `# Conventions

How work is recorded, classified and executed in this repository.

## Principles

1. **An open issue is not approved work.** Recording is cheap; executing requires
   explicit authorization.
2. **Native structure before textual convention.** The order of preference is
   native feature > structured field > label > free text. Nothing GitHub already
   models is re-implemented as a title prefix or a label.
3. **Each piece of information in one place.** If something has a field, it does
   not also have a label.
4. **Capturing an idea is not bureaucratic.** The Idea form has one required
   field. The cost of recording a thought has to stay near zero.

## Issue types

${typeMechanism}

| Type | What it is | Authorizes execution? |
|---|---|---|
${typeRows}

### Choosing the type

In order — the first "yes" decides:

1. **Is something broken?** → \`Bug\`, even if the expected behaviour never worked.
2. **Is the question still unanswered?** → \`Research\`.
3. **Is it just a record, with no analysis yet?** → \`Idea\`.
4. **Is it large and delivered in parts?** → \`Epic\`, with sub-issues.
5. **Does it change what the product does?** → \`Feature\`.
6. **None of the above** → \`Task\`.

### What is deliberately not a type

A type per flavour of work fragments the backlog without improving a single
query.

| Concept | Represent it as | Why |
|---|---|---|
${nonTypeRows}

## Labels

Labels are the last resort, for what has no native representation: technical
area, component and cross-cutting characteristic.

| Label | Meaning |
|---|---|
${labelRows}

**Never use a label for** priority, type, state or size when a field exists for
it: the label becomes a second truth that ages on its own.

## Branches and commits

- Branch: \`${DEFAULT_BRANCH_CONVENTION}\`
- Commit: ${DEFAULT_COMMIT_CONVENTION}

The commit type must match the nature of the change. A bug fix committed as
\`feat:\` corrupts the changelog and any version bump derived from the history.

## Pull Requests

Follow \`.github/PULL_REQUEST_TEMPLATE.md\`. Keep every section it defines and
answer the ones that do not apply with one line saying why — a deleted section
reads as an unanswered one to automated review.

Link the issues with one \`Closes #N\` per issue, as plain body text.

## Agent entry points

\`AGENTS.md\` is the canonical entry point for any coding agent, of any vendor.
It is an index: it says which documents to read, and holds no rule of its own.

\`CLAUDE.md\` exists only as the Claude Code integration and contains a single
line pointing at \`AGENTS.md\`. Any other agent adapter follows the same rule.

\`\`\`text
CLAUDE.md  →  AGENTS.md  →  specialized documentation  →  single source of truth
\`\`\`
`;
}

/** The labels file, consumed by the label sync step and readable by a human. */
export function renderLabelsFile(includeTypeLabels: boolean): string {
  const labels = includeTypeLabels ? [...FALLBACK_TYPE_LABELS, ...DEFAULT_LABELS] : DEFAULT_LABELS;

  return `${JSON.stringify(
    labels.map((label) => ({
      name: label.name,
      description: label.description,
      color: label.color,
    })),
    null,
    2,
  )}\n`;
}
