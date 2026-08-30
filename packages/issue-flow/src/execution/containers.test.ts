import { describe, expect, it } from 'vitest';
import { buildDependencyGraph } from '../issues/graph.js';
import { emptyRelations } from '../issues/relations.js';
import type { Issue } from '../issues/types.js';
import {
  type ContainerConfig,
  collectCascadeIds,
  DEFAULT_CONTAINER_CONFIG,
  isContainer,
} from './containers.js';

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: '87',
    number: 87,
    title: 'Agents',
    body: '',
    labels: [],
    state: 'open',
    source: 'github',
    remoteRef: null,
    createdAt: '',
    updatedAt: '',
    contentHash: 'sha256:0',
    ...overrides,
  };
}

const allSignals: ContainerConfig = {
  detect: ['children', 'issue-type', 'label', 'title-prefix'],
  issueTypes: ['Epic'],
  labels: ['epic'],
  titlePrefixes: ['[Epic]'],
};

describe('isContainer', () => {
  it('treats children as the strongest signal', () => {
    expect(isContainer({ issue: issue({ title: 'Just a feature' }), children: ['62'] })).toBe(true);
  });

  it('does not treat a title prefix as a container when there are no children', () => {
    expect(
      isContainer(
        { issue: issue({ title: '[Epic] Alone' }), children: [] },
        DEFAULT_CONTAINER_CONFIG,
      ),
    ).toBe(false);
  });

  it('uses issue type, label and prefix only when those signals are enabled', () => {
    expect(isContainer({ issue: issue({ type: 'Epic' }), children: [] }, allSignals)).toBe(true);
    expect(isContainer({ issue: issue({ labels: ['epic'] }), children: [] }, allSignals)).toBe(
      true,
    );
    expect(
      isContainer({ issue: issue({ title: '[Epic] Agents' }), children: [] }, allSignals),
    ).toBe(true);
    expect(isContainer({ issue: issue({ type: 'Epic' }), children: [] })).toBe(false);
  });

  it('lets children win over a conflicting title', () => {
    expect(
      isContainer(
        { issue: issue({ title: 'Implement the whole layer' }), children: ['76'] },
        allSignals,
      ),
    ).toBe(true);
  });
});

describe('collectCascadeIds', () => {
  it('keeps the root and walks children, not external blockers', async () => {
    const graph = await buildDependencyGraph(
      ['87', '62', '76', '84'],
      async (id) => {
        if (id === '87') return { ...emptyRelations(id), children: ['62', '76'] };
        if (id === '76') return { ...emptyRelations(id), parent: '87', blockedBy: ['62'] };
        if (id === '62') return { ...emptyRelations(id), parent: '87' };
        return { ...emptyRelations(id), blockedBy: ['62'] };
      },
      {
        known: ['87', '62', '76', '84'].map((id) => issue({ id, number: Number(id), title: id })),
      },
    );

    expect(collectCascadeIds(graph, ['87']).sort()).toEqual(['62', '76', '87']);
  });
});
