import {
  type BuildDependencyGraphOptions,
  buildDependencyGraph,
  type DependencyGraph,
} from '../issues/graph.js';
import { getProvider } from '../issues/registry.js';
import type { Issue, IssueRelations, IssueSource } from '../issues/types.js';

/**
 * Bridge between the Issue providers and the dependency graph.
 *
 * Discovery is a *best-effort enrichment* of a run, never a prerequisite: an
 * origin with no `fetchRelations`, an unregistered provider or a failing API all
 * degrade to "this issue relates to nothing", which is exactly the single-issue
 * pipeline that existed before. That is what makes the feature additive.
 */

export interface DiscoverGraphOptions extends BuildDependencyGraphOptions {
  /** Origin to ask about relations. Defaults to the first known Issue's source. */
  source?: IssueSource;
}

/** Whether an origin can answer questions about related Issues at all. */
export function supportsRelations(source: IssueSource): boolean {
  try {
    return typeof getProvider(source).fetchRelations === 'function';
  } catch {
    return false;
  }
}

/**
 * Walk the hierarchy of `roots` through the provider of `source`.
 *
 * Discovered Issues are read from the same origin: a queue is resolved against
 * one provider, so an id found in a GitHub hierarchy is a GitHub Issue. The
 * Issues the caller already resolved are passed through `known`, so the roots
 * never cost a second round-trip.
 */
export async function discoverIssueGraph(
  roots: readonly string[],
  options: DiscoverGraphOptions = {},
): Promise<DependencyGraph> {
  const source = options.source ?? [...(options.known ?? [])][0]?.source ?? 'github';

  let fetchRelations: ((id: string) => Promise<IssueRelations | null>) | null = null;
  let fetchIssue: ((id: string) => Promise<Issue | null>) | null = null;
  try {
    const provider = getProvider(source);
    const relations = provider.fetchRelations?.bind(provider);
    if (relations !== undefined) {
      fetchRelations = (id) => relations(id);
      fetchIssue = (id) => provider.get(id);
    }
  } catch {
    // Unknown origin: nothing to discover, and the run continues single-issue.
  }

  if (fetchRelations === null) {
    return buildDependencyGraph(roots, async () => null, { ...options, fetchIssue: undefined });
  }

  return buildDependencyGraph(roots, fetchRelations, {
    ...options,
    fetchIssue: options.fetchIssue ?? fetchIssue ?? undefined,
  });
}
