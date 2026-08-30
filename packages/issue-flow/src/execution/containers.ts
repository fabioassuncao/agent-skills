import type { DependencyGraph } from '../issues/graph.js';
import type { Issue } from '../issues/types.js';

export const CONTAINER_SIGNALS = ['children', 'issue-type', 'label', 'title-prefix'] as const;

export type ContainerSignal = (typeof CONTAINER_SIGNALS)[number];

export interface ContainerConfig {
  detect: readonly ContainerSignal[];
  issueTypes: readonly string[];
  labels: readonly string[];
  titlePrefixes: readonly string[];
}

/** Unconfigured repos: only the universal signal. */
export const DEFAULT_CONTAINER_CONFIG: ContainerConfig = {
  detect: ['children'],
  issueTypes: ['Epic'],
  labels: ['epic'],
  titlePrefixes: ['[Epic]'],
};

export interface ContainerProbe {
  issue: Pick<Issue, 'title' | 'labels' | 'type'> | null;
  children: readonly string[];
}

function enabled(config: ContainerConfig, signal: ContainerSignal): boolean {
  return config.detect.includes(signal);
}

function hasTitlePrefix(title: string, prefixes: readonly string[]): boolean {
  const trimmed = title.trim();
  return prefixes.some((prefix) => trimmed.toLowerCase().startsWith(prefix.toLowerCase()));
}

/**
 * Precedence: children > issue type > label > title prefix.
 * Having children always wins when that signal is enabled.
 */
export function isContainer(
  probe: ContainerProbe,
  config: ContainerConfig = DEFAULT_CONTAINER_CONFIG,
): boolean {
  if (enabled(config, 'children') && probe.children.length > 0) return true;

  const issue = probe.issue;
  if (issue === null) return false;

  if (enabled(config, 'issue-type')) {
    const type = issue.type?.trim();
    if (
      type !== undefined &&
      type !== '' &&
      config.issueTypes.some((name) => name.toLowerCase() === type.toLowerCase())
    ) {
      return true;
    }
  }

  if (enabled(config, 'label')) {
    const labels = new Set(issue.labels.map((label) => label.toLowerCase()));
    if (config.labels.some((label) => labels.has(label.toLowerCase()))) return true;
  }

  if (enabled(config, 'title-prefix') && hasTitlePrefix(issue.title, config.titlePrefixes)) {
    return true;
  }

  return false;
}

/** Root plus every descendant reached through `children`. */
export function collectCascadeIds(graph: DependencyGraph, roots: readonly string[]): string[] {
  const ids = new Set<string>();
  const walk = (id: string): void => {
    if (ids.has(id)) return;
    ids.add(id);
    for (const child of graph.nodes.get(id)?.relations.children ?? []) {
      walk(child);
    }
  };
  for (const root of roots) walk(root);
  return [...ids];
}
