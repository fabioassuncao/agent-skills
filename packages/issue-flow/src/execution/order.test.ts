import { describe, expect, it } from 'vitest';
import { buildDependencyGraph, type DependencyGraph } from '../issues/graph.js';
import { emptyRelations } from '../issues/relations.js';
import type { Issue, IssueRelations } from '../issues/types.js';
import { computeExecutionOrder, describeCycles, priorityOf } from './order.js';

function issue(id: string, labels: string[] = []): Issue {
  return {
    id,
    number: Number(id),
    title: `Issue ${id}`,
    body: '',
    labels,
    state: 'open',
    source: 'github',
    remoteRef: null,
    createdAt: '',
    updatedAt: '',
    contentHash: 'sha256:0',
  };
}

/** Build a graph from a literal description of each node. */
async function graphOf(
  spec: Record<string, Partial<IssueRelations> & { labels?: string[] }>,
): Promise<DependencyGraph> {
  const ids = Object.keys(spec);
  return buildDependencyGraph(
    ids,
    async (id) => {
      const { labels: _labels, ...relations } = spec[id] ?? {};
      return { ...emptyRelations(id), ...relations };
    },
    { known: ids.map((id) => issue(id, spec[id]?.labels ?? [])) },
  );
}

describe('priorityOf', () => {
  it('reads the bare labels this repository uses', () => {
    expect(priorityOf(['backend', 'high'])).toBe('high');
    expect(priorityOf(['Medium'])).toBe('medium');
    expect(priorityOf(['low'])).toBe('low');
  });

  it('reads the qualified spellings other projects use', () => {
    expect(priorityOf(['priority: high'])).toBe('high');
    expect(priorityOf(['priority/low'])).toBe('low');
    expect(priorityOf(['P-medium'])).toBe('medium');
  });

  it('is null when no label carries a priority', () => {
    expect(priorityOf(['enhancement'])).toBeNull();
    expect(priorityOf([])).toBeNull();
  });
});

describe('computeExecutionOrder', () => {
  it('keeps a single issue as-is', async () => {
    const order = computeExecutionOrder(await graphOf({ '42': {} }));
    expect(order).toEqual({ ok: true, order: ['42'] });
  });

  it('never starts an issue before the one it depends on', async () => {
    const graph = await graphOf({
      '52': { blockedBy: ['51'] },
      '51': { blockedBy: ['50'] },
      '50': {},
    });

    expect(computeExecutionOrder(graph)).toEqual({ ok: true, order: ['50', '51', '52'] });
  });

  it('reads a blocking edge as the mirror of a blockedBy one', async () => {
    const graph = await graphOf({ '50': { blocking: ['51'] }, '51': {} });
    expect(computeExecutionOrder(graph)).toEqual({ ok: true, order: ['50', '51'] });
  });

  it('runs the parent before its children when both are ready', async () => {
    const graph = await graphOf({
      '80': { parent: '50' },
      '50': { children: ['80', '81'] },
      '81': { parent: '50' },
    });

    expect(computeExecutionOrder(graph)).toEqual({ ok: true, order: ['50', '80', '81'] });
  });

  it('lets a dependency win over the hierarchy', async () => {
    // The parent is blocked by its own child, so the child has to go first.
    const graph = await graphOf({
      '50': { children: ['80'], blockedBy: ['80'] },
      '80': { parent: '50' },
    });

    expect(computeExecutionOrder(graph)).toEqual({ ok: true, order: ['80', '50'] });
  });

  it('orders by priority label when hierarchy does not decide', async () => {
    const graph = await graphOf({
      '10': { labels: ['low'] },
      '11': { labels: ['high'] },
      '12': { labels: ['medium'] },
    });

    expect(computeExecutionOrder(graph)).toEqual({ ok: true, order: ['11', '12', '10'] });
  });

  it('places an issue with no priority label after every labelled one', async () => {
    const graph = await graphOf({ '10': {}, '11': { labels: ['low'] } });
    expect(computeExecutionOrder(graph)).toEqual({ ok: true, order: ['11', '10'] });
  });

  it('lets a dependency win over the priority label', async () => {
    const graph = await graphOf({
      '10': { labels: ['high'], blockedBy: ['11'] },
      '11': { labels: ['low'] },
    });

    expect(computeExecutionOrder(graph)).toEqual({ ok: true, order: ['11', '10'] });
  });

  it('falls back to the issue number, numerically', async () => {
    const graph = await graphOf({ '100': {}, '9': {}, '11': {} });
    expect(computeExecutionOrder(graph)).toEqual({ ok: true, order: ['9', '11', '100'] });
  });

  it('applies every criterion in order in a mixed graph', async () => {
    const graph = await graphOf({
      // 50 is the umbrella; 51 depends on 50; 52 and 53 are free, 53 is high.
      '50': { children: ['51', '52', '53'], labels: ['medium'] },
      '51': { parent: '50', blockedBy: ['50'] },
      '52': { parent: '50', labels: ['low'] },
      '53': { parent: '50', labels: ['high'] },
    });

    // 50 first (top of the hierarchy), then the three children by priority —
    // 51 last because it carries no label at all, not because it was blocked.
    expect(computeExecutionOrder(graph)).toEqual({
      ok: true,
      order: ['50', '53', '52', '51'],
    });
  });

  it('schedules only the requested subset, dropping outside constraints', async () => {
    const graph = await graphOf({
      '50': { blocking: ['51'] },
      '51': { blockedBy: ['50'] },
      '52': {},
    });

    expect(computeExecutionOrder(graph, { include: ['51', '52'] })).toEqual({
      ok: true,
      order: ['51', '52'],
    });
  });

  it('ignores ids that are not in the graph', async () => {
    const graph = await graphOf({ '50': {} });
    expect(computeExecutionOrder(graph, { include: ['50', '999'] })).toEqual({
      ok: true,
      order: ['50'],
    });
  });

  it('refuses to order a cycle instead of inventing a sequence', async () => {
    const graph = await graphOf({
      '1': { blockedBy: ['2'] },
      '2': { blockedBy: ['1'] },
    });

    const result = computeExecutionOrder(graph);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.cycles).toEqual([['1', '2']]);
      expect(describeCycles(result.cycles)).toBe('#1 → #2 → #1');
    }
  });

  it('still orders a selection that excludes the cycle', async () => {
    const graph = await graphOf({
      '1': { blockedBy: ['2'] },
      '2': { blockedBy: ['1'] },
      '3': {},
    });

    expect(computeExecutionOrder(graph, { include: ['3'] })).toEqual({ ok: true, order: ['3'] });
  });
});
