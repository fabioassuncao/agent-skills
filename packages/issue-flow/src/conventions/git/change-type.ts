import {
  type ChangeTypeInput,
  type ChangeTypeLike,
  type ChangeTypeResult,
  type CommitTypeVocabulary,
  DEFAULT_LABEL_TYPE_MAP,
  isAllowedType,
} from './types.js';

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The default label map, overlaid by the one the repository declares.
 *
 * A mapping is kept only when its target is inside the vocabulary in force, so
 * `policy.git.typeMap` cannot smuggle in a type the repository's own commitlint
 * would reject.
 */
function mergedTypeMap(
  overlay: ChangeTypeInput['typeMap'],
  vocabulary: CommitTypeVocabulary | undefined,
): Record<string, ChangeTypeLike> {
  const merged: Record<string, ChangeTypeLike> = { ...DEFAULT_LABEL_TYPE_MAP };
  if (overlay === undefined || overlay === null) return merged;
  for (const [label, type] of Object.entries(overlay)) {
    if (isAllowedType(type, vocabulary)) {
      merged[normalizeKey(label)] = type;
    }
  }
  return merged;
}

function typeFromLabels(
  labels: readonly string[],
  typeMap: Record<string, ChangeTypeLike>,
): ChangeTypeLike | null {
  for (const label of labels) {
    const key = normalizeKey(label);
    const mapped = typeMap[key] ?? typeMap[key.replace(/^type:/, '')];
    if (mapped !== undefined) return mapped;
  }
  return null;
}

/**
 * Two rungs: a type the repository declared, then `feat`.
 *
 * The declaration arrives either directly (`declaredType`) or through the label
 * map the repository declares — which is why {@link DEFAULT_LABEL_TYPE_MAP}
 * survives while the Issue Type and title-prefix translation tables did not.
 * Those two inferred a type from a name, produced a confident answer nobody
 * could check, and changed nothing observable downstream.
 *
 * The source is recorded so a fallback can be printed in the execution header
 * before the first commit.
 */
export function resolveChangeType(input: ChangeTypeInput): ChangeTypeResult {
  if (input.declaredType !== undefined && input.declaredType !== null) {
    return { type: input.declaredType, source: 'declared' };
  }

  const vocabulary = input.allowedTypes ?? undefined;
  const fromLabels = typeFromLabels(input.labels ?? [], mergedTypeMap(input.typeMap, vocabulary));
  if (fromLabels !== null) {
    return { type: fromLabels, source: 'label' };
  }

  return { type: 'feat', source: 'fallback' };
}
