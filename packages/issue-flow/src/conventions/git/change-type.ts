import {
  type ChangeType,
  type ChangeTypeInput,
  type ChangeTypeResult,
  DEFAULT_LABEL_TYPE_MAP,
  isChangeType,
} from './types.js';

const ISSUE_TYPE_MAP: Readonly<Record<string, ChangeType>> = {
  bug: 'fix',
  feature: 'feat',
  task: 'chore',
  epic: 'chore',
  idea: 'chore',
  research: 'chore',
  documentation: 'docs',
};

const TITLE_PREFIX_MAP: Readonly<Record<string, ChangeType>> = {
  bug: 'fix',
  fix: 'fix',
  feature: 'feat',
  enhancement: 'feat',
  architecture: 'feat',
  refactor: 'refactor',
  docs: 'docs',
  documentation: 'docs',
  chore: 'chore',
  perf: 'perf',
  test: 'test',
  ci: 'ci',
};

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function typeFromIssueType(issueType: string): ChangeType | null {
  const key = normalizeKey(issueType);
  if (isChangeType(key)) return key;
  return ISSUE_TYPE_MAP[key] ?? null;
}

function mergedTypeMap(overlay: ChangeTypeInput['typeMap']): Record<string, ChangeType> {
  const merged: Record<string, ChangeType> = { ...DEFAULT_LABEL_TYPE_MAP };
  if (overlay === undefined || overlay === null) return merged;
  for (const [label, type] of Object.entries(overlay)) {
    if (isChangeType(type)) {
      merged[normalizeKey(label)] = type;
    }
  }
  return merged;
}

function typeFromLabels(
  labels: readonly string[],
  typeMap: Record<string, ChangeType>,
): ChangeType | null {
  for (const label of labels) {
    const key = normalizeKey(label);
    const mapped = typeMap[key] ?? typeMap[key.replace(/^type:/, '')];
    if (mapped !== undefined) return mapped;
  }
  return null;
}

function typeFromTitle(title: string): ChangeType | null {
  const match = title.match(/^\s*\[([^\]]+)\]/);
  if (match?.[1] === undefined) return null;
  const key = normalizeKey(match[1]);
  if (isChangeType(key)) return key;
  return TITLE_PREFIX_MAP[key] ?? null;
}

/**
 * Five-rung ladder, most structured first. The source is recorded so a fallback
 * can be printed in the execution header before the first commit.
 */
export function resolveChangeType(input: ChangeTypeInput): ChangeTypeResult {
  if (input.declaredType !== undefined && input.declaredType !== null) {
    return { type: input.declaredType, source: 'declared' };
  }

  const labels = input.labels ?? [];
  const typeMap = mergedTypeMap(input.typeMap);
  const fromLabels = typeFromLabels(labels, typeMap);
  const fromIssueType =
    input.issueType !== undefined && input.issueType !== null && input.issueType !== ''
      ? typeFromIssueType(input.issueType)
      : null;

  if (fromIssueType !== null) {
    const issueKey = normalizeKey(input.issueType ?? '');
    // Task (and other generic types) are refined by labels.
    if (issueKey === 'task' && fromLabels !== null) {
      return { type: fromLabels, source: 'label' };
    }
    if (fromLabels !== null && fromLabels !== fromIssueType) {
      return {
        type: fromIssueType,
        source: 'issue-type',
        conflict: { issueType: fromIssueType, label: fromLabels },
      };
    }
    return { type: fromIssueType, source: 'issue-type' };
  }

  if (fromLabels !== null) {
    return { type: fromLabels, source: 'label' };
  }

  if (input.titleConvention !== null && input.title !== undefined) {
    const fromTitle = typeFromTitle(input.title);
    if (fromTitle !== null) {
      return { type: fromTitle, source: 'title' };
    }
  } else if (input.title !== undefined) {
    // A title prefix is still a structured signal when the repository uses one
    // even without declaring `issues.titleConvention`.
    const fromTitle = typeFromTitle(input.title);
    if (fromTitle !== null) {
      return { type: fromTitle, source: 'title' };
    }
  }

  return { type: 'feat', source: 'fallback' };
}
