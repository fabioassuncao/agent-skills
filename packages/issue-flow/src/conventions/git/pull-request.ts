import {
  type ChangeType,
  type IssueRefInput,
  isForbiddenProviderToken,
  type PrTitleInput,
} from './types.js';

const IMPACT: readonly ChangeType[] = ['feat', 'fix'];

function sanitizeScope(scope: string | null | undefined): string | undefined {
  if (scope === undefined || scope === null) return undefined;
  const trimmed = scope.trim();
  if (trimmed === '' || isForbiddenProviderToken(trimmed)) return undefined;
  return trimmed;
}

function highestImpact(types: readonly ChangeType[]): ChangeType {
  for (const type of IMPACT) {
    if (types.includes(type)) return type;
  }
  return types[0] ?? 'feat';
}

function scopesAgree(scopes: readonly (string | null | undefined)[]): string | undefined {
  const unique = [
    ...new Set(scopes.map((scope) => sanitizeScope(scope)).filter((scope) => scope !== undefined)),
  ];
  return unique.length === 1 ? unique[0] : undefined;
}

/** `<type>(<scope>): <subject>` — what makes a GitHub squash-merge a Conventional Commit. */
export function pullRequestTitle(input: PrTitleInput): string {
  const type =
    input.types !== undefined && input.types.length > 0 ? highestImpact(input.types) : input.type;
  const scope =
    input.scopes !== undefined && input.scopes.length > 0
      ? scopesAgree(input.scopes)
      : sanitizeScope(input.scope);
  const subject = input.subject.replace(/\.$/, '').trim();
  if (isForbiddenProviderToken(type)) {
    return scope === undefined ? `chore: ${subject}` : `chore(${scope}): ${subject}`;
  }
  return scope === undefined ? `${type}: ${subject}` : `${type}(${scope}): ${subject}`;
}

/**
 * Deterministic `Closes` / `Refs` lines. The verb is a function of plan state,
 * never of issue kind alone: a container is closed only when every child is.
 */
export function issueReferenceLines(input: IssueRefInput): string {
  return input.references
    .map((ref) => {
      const closes = ref.container === true ? ref.allChildrenComplete === true : ref.complete;
      return `${closes ? 'Closes' : 'Refs'} #${ref.number}`;
    })
    .join('\n');
}
