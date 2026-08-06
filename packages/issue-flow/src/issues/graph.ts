import { emptyRelations, uniqueIds } from './relations.js';
import type { Issue, IssueRelations } from './types.js';

/**
 * Dependency graph of a set of Issues, built by walking the relations every
 * provider exposes through `fetchRelations`.
 *
 * The traversal is deliberately *structural*: it follows hierarchy
 * (parent/children) and dependencies (blockedBy/blocking) and stops there. Plain
 * mentions are recorded on each node but never expanded — a body citing "see
 * also #12" would otherwise drag an unrelated Issue into an execution plan the
 * user is about to confirm.
 */

export interface DependencyGraphNode {
  id: string;
  relations: IssueRelations;
  /** Distance from the closest root, in traversal hops. */
  depth: number;
  /** The Issue itself, when the caller supplied a way to read it. */
  issue: Issue | null;
  /** True when the node was requested by the user rather than discovered. */
  root: boolean;
}

export interface DependencyGraph {
  /** Ids the traversal started from, in the order they were requested. */
  roots: string[];
  /** Every discovered node, keyed by id, in discovery order. */
  nodes: Map<string, DependencyGraphNode>;
  /**
   * Dependency cycles found among the discovered nodes, each listed once,
   * starting at its smallest member. Reported rather than thrown: discovery
   * must still answer, and it is the ordering layer that refuses to run.
   */
  cycles: string[][];
  /** True when a limit stopped the traversal before it was exhausted. */
  truncated: boolean;
  limits: { maxNodes: number; maxDepth: number };
}

/**
 * Conservative defaults: a real hierarchy is a handful of Issues, and each node
 * costs several API calls. A malformed (or simply huge) graph must not turn a
 * `run` into a rate-limit incident.
 */
export const DEFAULT_MAX_NODES = 25;
export const DEFAULT_MAX_DEPTH = 3;

export interface BuildDependencyGraphOptions {
  maxNodes?: number;
  maxDepth?: number;
  /** Issues the caller already resolved, so the traversal does not re-read them. */
  known?: Iterable<Issue>;
  /** Reader for the Issues the traversal discovers. Optional. */
  fetchIssue?: (id: string) => Promise<Issue | null>;
  /** Warning sink for a source that failed. Silent by default. */
  warn?: (message: string) => void;
}

/** Edge `from` → `to`, meaning "`from` must be resolved before `to`". */
export interface DependencyEdge {
  from: string;
  to: string;
}

/**
 * Ordering constraints of a graph: only hierarchy-free, explicit dependencies.
 *
 * `blockedBy`/`blocking` are the two spellings of the same fact, so both are
 * normalized into a single direction here. Parent/child is **not** a constraint
 * — it is a presentation and tie-breaking concern (see `computeExecutionOrder`),
 * because a parent is usually an umbrella that neither blocks nor is blocked by
 * its children.
 *
 * Edges pointing outside the graph are dropped: an Issue the traversal never
 * reached cannot be scheduled, so a constraint against it is unenforceable.
 */
export function dependencyEdges(graph: DependencyGraph): DependencyEdge[] {
  const edges: DependencyEdge[] = [];
  const seen = new Set<string>();

  const add = (from: string, to: string): void => {
    if (from === to || !graph.nodes.has(from) || !graph.nodes.has(to)) return;
    const key = `${from}->${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to });
  };

  for (const node of graph.nodes.values()) {
    for (const blocker of node.relations.blockedBy) {
      add(blocker, node.id);
    }
    for (const blocked of node.relations.blocking) {
      add(node.id, blocked);
    }
  }

  return edges;
}

/** Every cycle of the dependency edges, each reported once. */
export function findCycles(graph: DependencyGraph): string[][] {
  const adjacency = new Map<string, string[]>();
  for (const { from, to } of dependencyEdges(graph)) {
    const list = adjacency.get(from);
    if (list === undefined) {
      adjacency.set(from, [to]);
    } else {
      list.push(to);
    }
  }

  const cycles: string[][] = [];
  const reported = new Set<string>();
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const record = (cycle: string[]): void => {
    // Rotate to the smallest member so the same cycle found from two entry
    // points is reported once.
    let pivot = 0;
    for (let i = 1; i < cycle.length; i++) {
      if (compareIds(cycle[i] as string, cycle[pivot] as string) < 0) pivot = i;
    }
    const normalized = [...cycle.slice(pivot), ...cycle.slice(0, pivot)];
    const key = normalized.join('->');
    if (reported.has(key)) return;
    reported.add(key);
    cycles.push(normalized);
  };

  const visit = (id: string): void => {
    state.set(id, 'visiting');
    stack.push(id);

    for (const next of adjacency.get(id) ?? []) {
      const status = state.get(next);
      if (status === 'visiting') {
        record(stack.slice(stack.indexOf(next)));
        continue;
      }
      if (status === undefined) {
        visit(next);
      }
    }

    stack.pop();
    state.set(id, 'done');
  };

  for (const id of graph.nodes.keys()) {
    if (!state.has(id)) visit(id);
  }

  return cycles;
}

/** Numeric when both ids are numbers, lexicographic otherwise. */
export function compareIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isInteger(na) && Number.isInteger(nb)) {
    return na - nb;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Ids a node links to structurally, in traversal order. */
function neighbours(relations: IssueRelations): string[] {
  return uniqueIds(
    [
      ...(relations.parent === null ? [] : [relations.parent]),
      ...relations.children,
      ...relations.blockedBy,
      ...relations.blocking,
    ],
    relations.id,
  );
}

/**
 * Walk the relations of `roots` breadth-first and return the whole structure.
 *
 * Failures never abort the walk: a node whose relations cannot be read enters
 * the graph with empty relations (and a warning), exactly like an Issue that
 * genuinely relates to nothing. That keeps a partially unavailable API from
 * costing the user the Issues that *were* discovered.
 *
 * Breadth-first is what makes `depth` meaningful under a limit: when the walk is
 * truncated, what is missing is the far edge of the graph, not a random subset.
 */
export async function buildDependencyGraph(
  roots: readonly string[],
  fetchRelations: (id: string) => Promise<IssueRelations | null>,
  options: BuildDependencyGraphOptions = {},
): Promise<DependencyGraph> {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const warn = options.warn ?? ((): void => {});

  const known = new Map<string, Issue>();
  for (const issue of options.known ?? []) {
    known.set(issue.id, issue);
  }

  const rootIds = uniqueIds(roots);
  const nodes = new Map<string, DependencyGraphNode>();
  const queued = new Set<string>(rootIds);
  let truncated = false;

  let frontier: { id: string; depth: number }[] = rootIds.map((id) => ({ id, depth: 0 }));

  while (frontier.length > 0) {
    const next: { id: string; depth: number }[] = [];

    for (const { id, depth } of frontier) {
      if (nodes.size >= maxNodes) {
        truncated = true;
        break;
      }

      let relations: IssueRelations | null = null;
      try {
        relations = await fetchRelations(id);
      } catch (err) {
        warn(
          `Could not read the relations of issue '${id}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      let issue = known.get(id) ?? null;
      if (issue === null && options.fetchIssue !== undefined) {
        try {
          issue = await options.fetchIssue(id);
        } catch (err) {
          warn(`Could not read issue '${id}': ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const resolved = relations ?? emptyRelations(id);
      nodes.set(id, { id, relations: resolved, depth, issue, root: rootIds.includes(id) });

      if (depth >= maxDepth) {
        // Only a node that actually has unexplored neighbours truncates the
        // graph; a leaf at max depth explored everything there was.
        if (neighbours(resolved).some((neighbour) => !queued.has(neighbour))) {
          truncated = true;
        }
        continue;
      }

      for (const neighbour of neighbours(resolved)) {
        if (queued.has(neighbour)) continue;
        queued.add(neighbour);
        next.push({ id: neighbour, depth: depth + 1 });
      }
    }

    if (nodes.size >= maxNodes && next.length > 0) {
      truncated = true;
      break;
    }
    frontier = next;
  }

  const graph: DependencyGraph = {
    roots: rootIds,
    nodes,
    cycles: [],
    truncated,
    limits: { maxNodes, maxDepth },
  };

  linkReferencedBy(graph);
  graph.cycles = findCycles(graph);

  return graph;
}

/**
 * Complete `referencedBy` with the inverse of `references` among the discovered
 * nodes.
 *
 * The origin only reports the citations it can see (GitHub's timeline covers
 * cross-references but not, for instance, a mention added by the textual
 * heuristic); inverting what the graph already holds costs no API call and
 * keeps the two directions consistent inside it.
 */
function linkReferencedBy(graph: DependencyGraph): void {
  for (const node of graph.nodes.values()) {
    for (const cited of node.relations.references) {
      const target = graph.nodes.get(cited);
      if (target === undefined || target.id === node.id) continue;
      target.relations.referencedBy = uniqueIds(
        [...target.relations.referencedBy, node.id],
        target.id,
      );
    }
  }
}
