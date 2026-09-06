import {
  type ChangeTypeLike,
  type IssueRefInput,
  isForbiddenProviderToken,
  type PrTitleInput,
} from './types.js';

const IMPACT: readonly ChangeTypeLike[] = ['feat', 'fix'];

function sanitizeScope(scope: string | null | undefined): string | undefined {
  if (scope === undefined || scope === null) return undefined;
  const trimmed = scope.trim();
  if (trimmed === '' || isForbiddenProviderToken(trimmed)) return undefined;
  return trimmed;
}

function highestImpact(types: readonly ChangeTypeLike[]): ChangeTypeLike {
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

/**
 * `<type>(<scope>): <subject>` — what makes a GitHub squash-merge a Conventional
 * Commit. `format: 'free'` returns the subject untouched, for a repository that
 * declared a title convention of its own.
 */
export function pullRequestTitle(input: PrTitleInput): string {
  if (input.format === 'free') return input.subject;
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
