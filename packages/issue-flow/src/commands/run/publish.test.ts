import { describe, expect, it } from 'vitest';
import { MemoryPublisher, NullPublisher } from '../../core/session-state.js';
import type { Issue, IssueSource, ResolvedIssue } from '../../issues/types.js';
import type { UserStory } from '../../types.js';
import { publishIssueDetails, publishStorySeed } from './publish.js';

function makeResolved(
  overrides: Partial<Issue> = {},
  source: IssueSource = 'github',
): ResolvedIssue {
  const issue: Issue = {
    id: '42',
    number: 42,
    title: 'Sample issue',
    body: 'Body',
    labels: [],
    state: 'open',
    source,
    remoteRef: source === 'github' ? 'https://github.com/acme/repo/issues/42' : null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    contentHash: 'sha256:abc',
    ...overrides,
  };
  return {
    issue,
    source,
    local: source === 'local' ? issue : null,
    github: source === 'github' ? issue : null,
    divergent: false,
  };
}

function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: 'US-001',
    title: 'Story',
    description: 'Test story',
    acceptanceCriteria: ['Criterion 1'],
    priority: 1,
    passes: false,
    notes: '',
    ...overrides,
  };
}

describe('publishStorySeed', () => {
  it('publica as stories do plano', () => {
    const publisher = new MemoryPublisher();
    expect(publishStorySeed(publisher, [makeStory()], '2026-08-03T12:00:00Z')).toBe(true);

    expect(publisher.snapshot().stories.map((s) => s.id)).toEqual(['US-001']);
    expect(publisher.version()).toBe(1);
  });

  it('não publica nada — nem bump de versão — com um plano sem stories', () => {
    const publisher = new MemoryPublisher();
    expect(publishStorySeed(publisher, [], '2026-08-03T12:00:00Z')).toBe(false);

    expect(publisher.snapshot().stories).toEqual([]);
    expect(publisher.version()).toBe(0);
  });
});

describe('publishIssueDetails', () => {
  it('publica os dados estruturais da Issue resolvida', () => {
    const publisher = new MemoryPublisher();
    publishIssueDetails(
      publisher,
      makeResolved({ title: 'Enriquecer o snapshot', body: 'Corpo', labels: ['enhancement'] })
        .issue,
      '2026-08-03T12:00:00Z',
    );

    expect(publisher.snapshot().issue).toEqual({
      number: 42,
      url: 'https://github.com/acme/repo/issues/42',
      title: 'Enriquecer o snapshot',
      description: 'Corpo',
      labels: ['enhancement'],
      state: 'open',
    });
  });

  it('com NullPublisher a publicação é um no-op', () => {
    const publisher = new NullPublisher();
    publishIssueDetails(publisher, makeResolved().issue, '2026-08-03T12:00:00Z');

    expect(publisher.snapshot().issue.title).toBeNull();
    expect(publisher.version()).toBe(0);
  });
});
