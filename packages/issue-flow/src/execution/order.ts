import { compareIds, type DependencyGraph, dependencyEdges, findCycles } from '../issues/graph.js';
import type { IssuePriority } from './types.js';

/**
 * Turning a dependency graph into the order the queue runs in.
 *
 * The criteria are applied in the exact precedence the initiative specifies:
 *
 * 1. **dependencies and blocks** — hard constraints; an Issue never starts
 *    before something it depends on has finished. This is the topological part
 *    and the only one that can make the computation fail (a cycle);
 * 2. **hierarchy** — with two Issues both ready to run, the ancestor goes
 *    first, so an umbrella Issue frames the work of its sub-issues;
 * 3. **priority** — the GitHub labels `high`, `medium` and `low`;
 * 4. **logical order** — the identifier, numerically when it is a number.
 *
 * Everything below the first item is a *tie-break among Issues that are already
 * free to run*, never a constraint: a `high` Issue that depends on a `low` one
 * still runs second, which is the whole point of the feature.
 */

const PRIORITY_LABELS: Record<string, IssuePriority> = {
  high: 'high',
  medium: 'medium',
  low: 'low',
};

/** Ranking of a priority; an Issue with no label sorts after every labelled one. */
const PRIORITY_RANK: Record<IssuePriority, number> = { high: 0, medium: 1, low: 2 };
const NO_PRIORITY_RANK = 3;

/**
 * Priority carried by a label set, or `null` when there is none.
 *
 * Both the bare labels used by this repository (`high`) and the qualified
 * spellings other projects use (`priority: high`, `priority/high`, `P-high`)
 * are accepted; anything else is simply not a priority. The absence of a label
 * is never an error — most Issues have none.
 */
export function priorityOf(labels: readonly string[]): IssuePriority | null {
  for (const label of labels) {
    const normalized = label.trim().toLowerCase();
    const direct = PRIORITY_LABELS[normalized];
    if (direct !== undefined) return direct;

    const qualified = /^(?:priority|prio|p)\s*[:/-]\s*(high|medium|low)$/.exec(normalized);
    const matched = qualified?.[1];
    if (matched !== undefined) return PRIORITY_LABELS[matched] as IssuePriority;
  }
  return null;
}

export interface ExecutionOrderOptions {
  /**
   * Subset of the graph to schedule. Defaults to every node — the "run the
   * whole hierarchy" answer; the "only the ones I asked for" answer passes the
   * requested ids.
   */
  include?: readonly string[];
}

export type ExecutionOrderResult =
  | { ok: true; order: string[] }
  | { ok: false; cycles: string[][] };

/** Number of ancestors of `id` inside the selection: 0 for a top-level Issue. */
function hierarchyDepth(
  id: string,
  parentOf: Map<string, string | null>,
  selected: Set<string>,
): number {
  let depth = 0;
  let current = parentOf.get(id) ?? null;
  const seen = new Set<string>([id]);

  while (current !== null && selected.has(current) && !seen.has(current)) {
    depth++;
    seen.add(current);
    current = parentOf.get(current) ?? null;
  }

  return depth;
}

/**
 * Order the selected Issues of a graph.
 *
 * Kahn's algorithm with a deterministic tie-break, so the same graph always
 * produces the same order — a plan the user confirmed must not reshuffle itself
 * on the next run.
 *
 * A cycle is reported, never worked around: an arbitrary order would silently
 * implement an Issue before its dependency, which is exactly the failure this
 * whole feature exists to prevent. Constraints pointing outside the selection
 * are dropped — an Issue that is not going to run cannot block anything.
 */
export function computeExecutionOrder(
  graph: DependencyGraph,
  options: ExecutionOrderOptions = {},
): ExecutionOrderResult {
  const selected = new Set(
    (options.include ?? [...graph.nodes.keys()]).filter((id) => graph.nodes.has(id)),
  );

  const parentOf = new Map<string, string | null>();
  const priority = new Map<string, IssuePriority | null>();
  for (const id of selected) {
    const node = graph.nodes.get(id);
    parentOf.set(id, node?.relations.parent ?? null);
    priority.set(id, priorityOf(node?.issue?.labels ?? []));
  }

  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, string[]>();
  for (const id of selected) {
    incoming.set(id, new Set());
    outgoing.set(id, []);
  }
  for (const { from, to } of dependencyEdges(graph)) {
    if (!selected.has(from) || !selected.has(to) || from === to) continue;
    incoming.get(to)?.add(from);
    outgoing.get(from)?.push(to);
  }

  const depth = new Map<string, number>();
  for (const id of selected) {
    depth.set(id, hierarchyDepth(id, parentOf, selected));
  }

  const rank = (id: string): number => {
    const value = priority.get(id) ?? null;
    return value === null ? NO_PRIORITY_RANK : PRIORITY_RANK[value];
  };

  const better = (a: string, b: string): number => {
    const byHierarchy = (depth.get(a) ?? 0) - (depth.get(b) ?? 0);
    if (byHierarchy !== 0) return byHierarchy;
    const byPriority = rank(a) - rank(b);
    if (byPriority !== 0) return byPriority;
    return compareIds(a, b);
  };

  const ready = [...selected].filter((id) => (incoming.get(id)?.size ?? 0) === 0);
  const order: string[] = [];

  while (ready.length > 0) {
    ready.sort(better);
    const next = ready.shift() as string;
    order.push(next);

    for (const dependent of outgoing.get(next) ?? []) {
      const pending = incoming.get(dependent);
      if (pending === undefined) continue;
      pending.delete(next);
      if (pending.size === 0) {
        ready.push(dependent);
      }
    }
  }

  if (order.length !== selected.size) {
    // Prefer the cycles the graph already recorded; recompute only if the
    // selection is what closed the loop.
    const cycles = graph.cycles.length > 0 ? graph.cycles : findCycles(graph);
    const relevant = cycles.filter((cycle) => cycle.every((id) => selected.has(id)));
    return { ok: false, cycles: relevant.length > 0 ? relevant : cycles };
  }

  return { ok: true, order };
}

/** One-line description of the cycles, for an error message. */
export function describeCycles(cycles: readonly string[][]): string {
  return cycles.map((cycle) => [...cycle, cycle[0]].map((id) => `#${id}`).join(' → ')).join('; ');
}
