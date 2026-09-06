import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { archiveFolderName, branchName, parseBranch } from './branch.js';
import { resolveChangeType } from './change-type.js';
import { commitMessage } from './commit.js';
import {
  DEFAULT_BRANCH_CONVENTION,
  branchName as exportedBranchName,
  commitMessage as exportedCommitMessage,
  pullRequestTitle as exportedPullRequestTitle,
} from './index.js';
import { issueReferenceLines, pullRequestTitle } from './pull-request.js';
import { slugify } from './slug.js';
import type { ChangeType } from './types.js';

describe('resolveChangeType', () => {
  it.each([
    [{ labels: ['bug'] }, 'fix', 'label'],
    [{ labels: ['docs'] }, 'docs', 'label'],
    [{ labels: ['refactor'] }, 'refactor', 'label'],
    [{ labels: ['tech-debt'] }, 'refactor', 'label'],
    [{ labels: ['infra'] }, 'ci', 'label'],
    [{ labels: ['enhancement', 'architecture'] }, 'feat', 'label'],
    [{ labels: ['monitoring'], typeMap: { monitoring: 'perf' } }, 'perf', 'label'],
    [{}, 'feat', 'fallback'],
  ] as const)('%j → %s (%s)', (input, type, source) => {
    const result = resolveChangeType(input);
    expect(result.type).toBe(type);
    expect(result.source).toBe(source);
  });

  it('lets a declared type beat the label map', () => {
    expect(resolveChangeType({ declaredType: 'docs', labels: ['bug'] })).toEqual({
      type: 'docs',
      source: 'declared',
    });
  });

  it('no longer infers a type from an Issue Type name or a title prefix', () => {
    // Both rungs were removed with the translation tables behind them: they
    // produced a confident answer nobody could check and changed nothing
    // observable. A repository that wants the mapping declares it in `typeMap`.
    expect(resolveChangeType({ labels: [] })).toEqual({ type: 'feat', source: 'fallback' });
    expect(resolveChangeType({ labels: ['type:bug'] })).toEqual({ type: 'fix', source: 'label' });
  });

  it('accepts a type outside the default vocabulary when the repository declares one', () => {
    expect(
      resolveChangeType({
        labels: ['release'],
        typeMap: { release: 'deps' },
        allowedTypes: 'any',
      }),
    ).toEqual({ type: 'deps', source: 'label' });

    // Without the declaration, the default vocabulary still filters the overlay.
    expect(resolveChangeType({ labels: ['release'], typeMap: { release: 'deps' } })).toEqual({
      type: 'feat',
      source: 'fallback',
    });
  });
});

describe('slugify', () => {
  it('is deterministic', () => {
    const title = 'Execução autônoma & resiliência';
    expect(slugify(title)).toBe(slugify(title));
    expect(slugify(title)).toBe('execucao-autonoma-resiliencia');
  });

  it('truncates a 200-character title on a word boundary at 40', () => {
    const title = 'palavra-'.repeat(30);
    const slug = slugify(title, 40);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
    expect(slug.includes('palavra')).toBe(true);
  });

  it('returns empty when the title is only emoji and punctuation', () => {
    expect(slugify('🔥 !!!')).toBe('');
  });

  it('strips a trailing .lock', () => {
    expect(slugify('cache.lock')).toBe('cache');
  });
});

describe('branchName', () => {
  it('builds {type}/{N}-{slug}', () => {
    expect(
      branchName({
        type: 'feat',
        issueNumber: 63,
        title: 'Execução autônoma resiliente',
      }),
    ).toBe('feat/63-execucao-autonoma-resiliente');
  });

  it('omits the slug when nothing remains after normalization', () => {
    expect(branchName({ type: 'feat', issueNumber: 63, title: '🔥' })).toBe('feat/63');
  });

  it('omits the number when the issue has none', () => {
    expect(branchName({ type: 'chore', title: 'dogfood conventions' })).toBe(
      'chore/dogfood-conventions',
    );
  });

  it('appends -2 when the ref exists and points at another commit', () => {
    expect(
      branchName({
        type: 'feat',
        issueNumber: 1,
        title: 'sample',
        existingRefs: [{ name: 'feat/1-sample', oid: 'aaa' }],
        currentOid: 'bbb',
      }),
    ).toBe('feat/1-sample-2');
  });

  it('reuses a ref that already points at this commit', () => {
    expect(
      branchName({
        type: 'feat',
        issueNumber: 1,
        title: 'sample',
        existingRefs: [{ name: 'feat/1-sample', oid: 'aaa' }],
        currentOid: 'aaa',
      }),
    ).toBe('feat/1-sample');
  });

  it('honours a declared convention verbatim', () => {
    expect(
      branchName({
        type: 'feat',
        issueNumber: 42,
        title: 'dark mode',
        convention: 'issue/{N}-{slug}',
      }),
    ).toBe('issue/42-dark-mode');
  });

  it('keeps every generated name legal for git check-ref-format --branch', () => {
    const names = [
      branchName({ type: 'feat', issueNumber: 63, title: 'Execução autônoma & resiliência' }),
      branchName({ type: 'fix', issueNumber: 72, title: 'timeout.headless.lock' }),
      branchName({ type: 'chore', title: 'dogfood conventions' }),
      branchName({ type: 'feat', issueNumber: 63, title: '🔥 !!!' }),
    ];
    for (const name of names) {
      expect(() => execFileSync('git', ['check-ref-format', '--branch', name])).not.toThrow();
    }
  });
});

describe('parseBranch', () => {
  it('reads type and number from the new convention', () => {
    expect(parseBranch('feat/42-legacy')).toEqual({
      type: 'feat',
      issueNumber: 42,
      slug: 'legacy',
      raw: 'feat/42-legacy',
    });
  });

  it('still recognises the historical issue/{N}-* form', () => {
    expect(parseBranch('issue/42-legacy')).toEqual({
      type: 'issue',
      issueNumber: 42,
      slug: 'legacy',
      raw: 'issue/42-legacy',
    });
  });

  it('parses a prefix with no number', () => {
    expect(parseBranch('chore/dogfood')).toMatchObject({
      type: 'chore',
      issueNumber: null,
      slug: 'dogfood',
    });
  });
});

describe('archiveFolderName', () => {
  it('works for issue/ and feat/ alike', () => {
    expect(archiveFolderName('issue/42-legacy')).toBe('42-legacy');
    expect(archiveFolderName('feat/42-legacy')).toBe('42-legacy');
  });
});

describe('commitMessage', () => {
  it('formats a commit with the Refs trailer and nothing else', () => {
    // The `Story: US-NNN` trailer was removed: the link lives in the `stories`
    // table, and duplicating it in the message made it a second truth that
    // nobody reconciled.
    expect(
      commitMessage({
        type: 'feat',
        scope: 'core',
        subject: 'add failover probe',
        issueNumber: 63,
      }),
    ).toBe('feat(core): add failover probe\n\nRefs #63');
  });

  it('marks a breaking change in the header and the footer', () => {
    const message = commitMessage({
      type: 'feat',
      subject: 'rename the runner contract',
      breaking: 'AgentRunner.invoke is now required',
    });
    expect(message.startsWith('feat!: rename the runner contract')).toBe(true);
    expect(message).toContain('BREAKING CHANGE: AgentRunner.invoke is now required');
  });

  it('adds Signed-off-by when signoff is on', () => {
    expect(commitMessage({ type: 'fix', subject: 'typo', signoff: true })).toContain(
      'Signed-off-by:',
    );
  });

  it('never puts Closes on a commit', () => {
    const message = commitMessage({ type: 'feat', subject: 'x', issueNumber: 1 });
    expect(message).toContain('Refs #1');
    expect(message).not.toMatch(/\bCloses\b/);
  });

  it('drops a provider name used as scope', () => {
    expect(commitMessage({ type: 'feat', scope: 'claude', subject: 'add probe' })).toBe(
      'feat: add probe',
    );
  });

  it('allows a provider name in the subject', () => {
    expect(commitMessage({ type: 'feat', scope: 'agents', subject: 'add Cursor CLI runner' })).toBe(
      'feat(agents): add Cursor CLI runner',
    );
  });
});

describe('pullRequestTitle and issueReferenceLines', () => {
  it('formats a conventional title', () => {
    expect(
      pullRequestTitle({ type: 'feat', scope: 'agents', subject: 'add Cursor CLI runner' }),
    ).toBe('feat(agents): add Cursor CLI runner');
  });

  it('picks the highest-impact type and drops a mixed scope', () => {
    expect(
      pullRequestTitle({
        type: 'docs',
        subject: 'cascade execution',
        types: ['docs', 'fix', 'feat'],
        scopes: ['web', 'agents'],
      }),
    ).toBe('feat: cascade execution');
  });

  it('emits Closes when every story passed and findings are clear', () => {
    expect(issueReferenceLines({ references: [{ number: 42, complete: true }] })).toBe(
      'Closes #42',
    );
  });

  it('emits Refs for a partial delivery', () => {
    expect(issueReferenceLines({ references: [{ number: 42, complete: false }] })).toBe('Refs #42');
  });

  it('emits Refs for an epic whose children did not all run', () => {
    expect(
      issueReferenceLines({
        references: [{ number: 63, complete: false, container: true, allChildrenComplete: false }],
      }),
    ).toBe('Refs #63');
  });

  it('emits Closes for a container whose children all closed', () => {
    expect(
      issueReferenceLines({
        references: [{ number: 63, complete: true, container: true, allChildrenComplete: true }],
      }),
    ).toBe('Closes #63');
  });

  it('emits one line per consolidated issue', () => {
    expect(
      issueReferenceLines({
        references: [
          { number: 64, complete: true },
          { number: 65, complete: true },
          { number: 67, complete: true },
        ],
      }),
    ).toBe('Closes #64\nCloses #65\nCloses #67');
  });
});

describe('provider invariance', () => {
  const input = {
    type: 'feat' as ChangeType,
    issueNumber: 63,
    title: 'Execução autônoma resiliente',
    subject: 'add provider health and failover',
  };

  it.each([
    'claude',
    'codex',
    'cursor',
    'X',
  ] as const)('produces identical artefacts for provider %s', () => {
    expect(exportedBranchName(input)).toBe('feat/63-execucao-autonoma-resiliente');
    expect(
      exportedCommitMessage({ type: input.type, subject: input.subject, issueNumber: 63 }),
    ).toBe('feat: add provider health and failover\n\nRefs #63');
    expect(exportedPullRequestTitle({ type: input.type, subject: input.subject })).toBe(
      'feat: add provider health and failover',
    );
  });

  it('forbids a provider name as type or scope', () => {
    for (const provider of ['claude', 'codex', 'cursor', 'antigravity', 'opencode'] as const) {
      expect(exportedCommitMessage({ type: 'feat', scope: provider, subject: 'x' })).toBe(
        'feat: x',
      );
      expect(exportedPullRequestTitle({ type: 'feat', scope: provider, subject: 'x' })).toBe(
        'feat: x',
      );
    }
  });
});

describe('DEFAULT_BRANCH_CONVENTION', () => {
  it('is the type-prefixed pattern', () => {
    expect(DEFAULT_BRANCH_CONVENTION).toBe('{type}/{N}-{slug}');
  });
});
