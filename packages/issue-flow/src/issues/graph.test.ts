import { describe, expect, it, vi } from 'vitest';
import { buildDependencyGraph, compareIds, dependencyEdges, findCycles } from './graph.js';
import { emptyRelations } from './relations.js';
import type { Issue, IssueRelations } from './types.js';

/** Relations of `id`, with only the fields a case cares about. */
function relations(id: string, overrides: Partial<IssueRelations> = {}): IssueRelations {
  return { ...emptyRelations(id), ...overrides };
}

/** Reader over a fixed map, counting how many times each id was read. */
function reader(map: Record<string, IssueRelations>): {
  fetch: (id: string) => Promise<IssueRelations>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (id: string) => {
      calls.push(id);
      return map[id] ?? emptyRelations(id);
    },
  };
}

function issue(id: string, overrides: Partial<Issue> = {}): Issue {
  return {
    id,
    number: Number(id),
    title: `Issue ${id}`,
    body: '',
    labels: [],
    state: 'open',
    source: 'github',
    remoteRef: `https://github.com/acme/widgets/issues/${id}`,
    createdAt: '',
    updatedAt: '',
    contentHash: 'sha256:0',
    ...overrides,
  };
}

describe('buildDependencyGraph', () => {
  it('returns a single node for an Issue with no relations', async () => {
    const { fetch } = reader({});
    const graph = await buildDependencyGraph(['50'], fetch);

    expect([...graph.nodes.keys()]).toEqual(['50']);
    expect(graph.nodes.get('50')).toMatchObject({ depth: 0, root: true, issue: null });
    expect(graph.cycles).toEqual([]);
    expect(graph.truncated).toBe(false);
  });

  it('walks hierarchy and dependencies breadth-first, visiting each node once', async () => {
    const { fetch, calls } = reader({
      '50': relations('50', { children: ['51', '52'] }),
      '51': relations('51', { parent: '50', blockedBy: ['52'] }),
      '52': relations('52', { parent: '50' }),
    });

    const graph = await buildDependencyGraph(['50'], fetch);

    expect([...graph.nodes.keys()]).toEqual(['50', '51', '52']);
    expect(graph.nodes.get('51')?.depth).toBe(1);
    expect(graph.nodes.get('51')?.root).toBe(false);
    expect(calls).toEqual(['50', '51', '52']);
  });

  it('consolidates several roots into one graph', async () => {
    const { fetch } = reader({
      '50': relations('50', { blocking: ['51'] }),
      '60': relations('60'),
    });

    const graph = await buildDependencyGraph(['50', '60'], fetch);

    expect(graph.roots).toEqual(['50', '60']);
    expect([...graph.nodes.keys()].sort()).toEqual(['50', '51', '60']);
    expect(graph.nodes.get('60')?.root).toBe(true);
    expect(graph.nodes.get('51')?.root).toBe(false);
  });

  it('does not expand plain references', async () => {
    const { fetch } = reader({ '50': relations('50', { references: ['99'] }) });

    const graph = await buildDependencyGraph(['50'], fetch);

    expect([...graph.nodes.keys()]).toEqual(['50']);
  });

  it('links referencedBy from the references of the discovered nodes', async () => {
    const { fetch } = reader({
      '50': relations('50', { children: ['51'] }),
      '51': relations('51', { parent: '50', references: ['50'] }),
    });

    const graph = await buildDependencyGraph(['50'], fetch);

    expect(graph.nodes.get('50')?.relations.referencedBy).toEqual(['51']);
  });

  it('reports a cycle instead of throwing', async () => {
    const { fetch } = reader({
      '1': relations('1', { blockedBy: ['2'] }),
      '2': relations('2', { blockedBy: ['1'] }),
    });

    const graph = await buildDependencyGraph(['1'], fetch);

    expect(graph.nodes.size).toBe(2);
    expect(graph.cycles).toEqual([['1', '2']]);
  });

  it('stops at maxNodes and reports the truncation', async () => {
    const { fetch } = reader({
      '1': relations('1', { children: ['2', '3'] }),
      '2': relations('2', { children: ['4'] }),
      '3': relations('3'),
      '4': relations('4'),
    });

    const graph = await buildDependencyGraph(['1'], fetch, { maxNodes: 2 });

    expect(graph.nodes.size).toBe(2);
    expect(graph.truncated).toBe(true);
  });

  it('stops at maxDepth and reports the truncation', async () => {
    const { fetch } = reader({
      '1': relations('1', { children: ['2'] }),
      '2': relations('2', { children: ['3'] }),
      '3': relations('3'),
    });

    const graph = await buildDependencyGraph(['1'], fetch, { maxDepth: 1 });

    expect([...graph.nodes.keys()]).toEqual(['1', '2']);
    expect(graph.truncated).toBe(true);
  });

  it('does not report truncation when the last level is a leaf', async () => {
    const { fetch } = reader({ '1': relations('1', { children: ['2'] }), '2': relations('2') });

    const graph = await buildDependencyGraph(['1'], fetch, { maxDepth: 1 });

    expect(graph.truncated).toBe(false);
  });

  it('keeps the graph when a node cannot be read', async () => {
    const warn = vi.fn();
    const graph = await buildDependencyGraph(
      ['1'],
      async (id) => {
        if (id === '2') throw new Error('HTTP 500');
        return relations('1', { children: ['2'] });
      },
      { warn },
    );

    expect([...graph.nodes.keys()]).toEqual(['1', '2']);
    expect(graph.nodes.get('2')?.relations).toEqual(emptyRelations('2'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("issue '2'"));
  });

  it('reuses the Issues the caller already resolved and reads only the rest', async () => {
    const fetchIssue = vi.fn(async (id: string) => issue(id));
    const { fetch } = reader({ '50': relations('50', { children: ['51'] }) });

    const graph = await buildDependencyGraph(['50'], fetch, {
      known: [issue('50', { title: 'Root' })],
      fetchIssue,
    });

    expect(graph.nodes.get('50')?.issue?.title).toBe('Root');
    expect(fetchIssue).toHaveBeenCalledTimes(1);
    expect(fetchIssue).toHaveBeenCalledWith('51');
  });
});

describe('dependencyEdges', () => {
  it('normalizes blocking and blockedBy into one direction and drops unknown ends', async () => {
    const { fetch } = reader({
      '1': relations('1', { blocking: ['2'] }),
      '2': relations('2', { blockedBy: ['1'], children: [] }),
    });
    const graph = await buildDependencyGraph(['1'], fetch);

    expect(dependencyEdges(graph)).toEqual([{ from: '1', to: '2' }]);

    graph.nodes.get('2')?.relations.blockedBy.push('999');
    expect(dependencyEdges(graph)).toEqual([{ from: '1', to: '2' }]);
  });

  it('does not turn hierarchy into an ordering constraint', async () => {
    const { fetch } = reader({
      '1': relations('1', { children: ['2'] }),
      '2': relations('2', { parent: '1' }),
    });
    const graph = await buildDependencyGraph(['1'], fetch);

    expect(dependencyEdges(graph)).toEqual([]);
  });
});

describe('findCycles', () => {
  it('reports a three-node cycle once, starting at its smallest member', async () => {
    const { fetch } = reader({
      '3': relations('3', { blocking: ['1'] }),
      '1': relations('1', { blocking: ['2'] }),
      '2': relations('2', { blocking: ['3'] }),
    });
    const graph = await buildDependencyGraph(['3'], fetch);

    expect(findCycles(graph)).toEqual([['1', '2', '3']]);
  });
});

describe('compareIds', () => {
  it('orders numeric ids numerically and the rest lexicographically', () => {
    expect([...['10', '9', '2']].sort(compareIds)).toEqual(['2', '9', '10']);
    expect(['b', 'a'].sort(compareIds)).toEqual(['a', 'b']);
    expect(compareIds('10', 'auth')).toBeLessThan(0);
  });
});
