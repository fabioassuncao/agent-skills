import { type ChangeTypeLike, type CommitInput, isForbiddenProviderToken } from './types.js';

const HEADER_MAX = 72;
const BODY_WIDTH = 72;

function wrap(text: string, width: number): string {
  const paragraphs = text.replace(/\r\n/g, '\n').split('\n');
  return paragraphs
    .map((paragraph) => {
      if (paragraph.trim() === '') return '';
      const words = paragraph.split(/\s+/);
      const lines: string[] = [];
      let current = '';
      for (const word of words) {
        const next = current === '' ? word : `${current} ${word}`;
        if (next.length > width && current !== '') {
          lines.push(current);
          current = word;
        } else {
          current = next;
        }
      }
      if (current !== '') lines.push(current);
      return lines.join('\n');
    })
    .join('\n');
}

function sanitizeScope(scope: string | null | undefined): string | undefined {
  if (scope === undefined || scope === null) return undefined;
  const trimmed = scope.trim();
  if (trimmed === '' || isForbiddenProviderToken(trimmed)) return undefined;
  return trimmed;
}

function sanitizeType(type: ChangeTypeLike): ChangeTypeLike {
  return isForbiddenProviderToken(type) ? 'chore' : type;
}

function headerLine(
  type: ChangeTypeLike,
  scope: string | undefined,
  breaking: boolean,
  subject: string,
): string {
  const bang = breaking ? '!' : '';
  const scoped = scope === undefined ? `${type}${bang}` : `${type}(${scope})${bang}`;
  const cleaned = subject.replace(/\.$/, '').trim();
  const prefix = `${scoped}: `;
  const budget = HEADER_MAX - prefix.length;
  const clipped =
    budget < 1 ? '' : cleaned.length > budget ? cleaned.slice(0, budget).trimEnd() : cleaned;
  return `${prefix}${clipped}`;
}

/**
 * A commit message, in the format in force.
 *
 * `'conventional'` (the default, and what a repository that declares nothing
 * gets) renders `<type>(<scope>)[!]: <subject>` and wraps the body at 72.
 * `'free'` writes subject and body exactly as given: reformatting a message
 * whose format the repository already decided is the fallback behaving like a
 * rule, which is the posture ADR-11 reverses.
 *
 * The footer is not part of that choice. `Refs #N` is a traceability guarantee,
 * and it is `Refs` and never `Closes` in either format — a `Closes` on a commit
 * closes the issue on a direct push, before any review.
 */
export function commitMessage(input: CommitInput): string {
  const free = input.format === 'free';
  const type = sanitizeType(input.type);
  const scope = sanitizeScope(input.scope);
  const breaking = input.breaking !== undefined && input.breaking !== null && input.breaking !== '';
  const lines = [free ? input.subject : headerLine(type, scope, breaking, input.subject)];

  if (input.body !== undefined && input.body !== '') {
    lines.push('', free ? input.body : wrap(input.body, BODY_WIDTH));
  }

  const footers: string[] = [];
  if (input.issueNumber !== undefined && input.issueNumber !== null) {
    footers.push(`Refs #${input.issueNumber}`);
  }
  if (breaking) {
    footers.push(`BREAKING CHANGE: ${input.breaking}`);
  }
  if (input.signoff === true) {
    footers.push('Signed-off-by:');
  } else if (typeof input.signoff === 'string' && input.signoff !== '') {
    footers.push(`Signed-off-by: ${input.signoff}`);
  }

  if (footers.length > 0) {
    lines.push('', ...footers);
  }

  return lines.join('\n');
}
