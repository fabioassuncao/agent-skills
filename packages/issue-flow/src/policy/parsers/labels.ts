import type { LabelDefinition } from '../types.js';

/**
 * Parse `gh label list --json name,description,color`.
 *
 * These are the labels that *really exist*. The distinction matters: a pipeline
 * that invents a label either fails to apply it or, worse, creates it — and a
 * taxonomy nobody agreed to is harder to undo than a missing label.
 *
 * Never throws: a payload that is not an array of label-shaped objects yields
 * an empty list, indistinguishable to the caller from "gh answered nothing".
 */
export function parseLabels(payload: unknown): LabelDefinition[] {
  if (!Array.isArray(payload)) return [];

  const labels: LabelDefinition[] = [];
  for (const entry of payload) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (name === '') continue;

    const description = typeof record.description === 'string' ? record.description.trim() : '';
    const color = typeof record.color === 'string' ? record.color.trim() : '';

    labels.push({
      name,
      description: description === '' ? null : description,
      color: color === '' ? null : color,
    });
  }
  return labels;
}

/**
 * Parse `gh api orgs/{org}/issue-types`.
 *
 * Issue Types are an organization-level taxonomy exposed only on some plans, so
 * an empty result is the normal case rather than a failure.
 */
export function parseIssueTypes(payload: unknown): string[] {
  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { issue_types?: unknown })?.issue_types)
      ? (payload as { issue_types: unknown[] }).issue_types
      : [];

  const types: string[] = [];
  for (const entry of entries) {
    const name =
      typeof entry === 'string'
        ? entry
        : entry !== null && typeof entry === 'object'
          ? (entry as Record<string, unknown>).name
          : undefined;
    if (typeof name !== 'string') continue;
    const trimmed = name.trim();
    if (trimmed !== '' && !types.includes(trimmed)) {
      types.push(trimmed);
    }
  }
  return types;
}
