import { type ChangeType, type CommitInput, isForbiddenProviderToken } from './types.js';

const HEADER_MAX = 72;
const BODY_WIDTH = 72;
const STORY_ID = /^US-\d+$/i;

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

function sanitizeType(type: ChangeType): ChangeType {
  return isForbiddenProviderToken(type) ? 'chore' : type;
}

function headerLine(
  type: ChangeType,
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
 * Conventional Commit. Footer uses `Refs` only — closing is a Pull Request
 * decision. A `Closes` on a commit would close the issue on a direct push.
 */
export function commitMessage(input: CommitInput): string {
  const type = sanitizeType(input.type);
  const scope = sanitizeScope(input.scope);
  const breaking = input.breaking !== undefined && input.breaking !== null && input.breaking !== '';
  const lines = [headerLine(type, scope, breaking, input.subject)];

  if (input.body !== undefined && input.body !== '') {
    lines.push('', wrap(input.body, BODY_WIDTH));
  }

  const footers: string[] = [];
  if (input.issueNumber !== undefined && input.issueNumber !== null) {
    footers.push(`Refs #${input.issueNumber}`);
  }
  if (input.storyId !== undefined && input.storyId !== null && STORY_ID.test(input.storyId)) {
    footers.push(`Story: ${input.storyId}`);
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
