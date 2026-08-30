import type { IssueDraft } from './types.js';

/**
 * Structured Issue draft emitted by the `generate` prompt.
 *
 * The agent no longer creates the Issue itself: it returns the content and the
 * providers persist it, so the same draft can reach GitHub, the local files, or
 * both. Capturing the result therefore has to be exact — the old approach of
 * fishing an issue URL out of free-form prose only ever worked for GitHub.
 *
 * The block mirrors the `<issue-body>` convention already used by the phase
 * templates, which keeps a multi-line markdown body readable and free of the
 * escaping a JSON payload would demand.
 */

/** Wrapper the agent must emit around the draft. */
export const DRAFT_TAG = 'issue-draft';

/** Failure to capture a draft from the agent output. */
export class IssueDraftParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IssueDraftParseError';
  }
}

/**
 * Last occurrence of `<tag>...</tag>` in `source`, or `null`.
 *
 * The last one wins: an agent that shows the format before filling it in (or
 * restates the draft after a correction) would otherwise have its first,
 * throwaway attempt captured. The closing tag is searched from the end for the
 * same reason a body may legitimately quote one.
 */
function extractTag(source: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;

  const start = source.lastIndexOf(open);
  if (start === -1) return null;

  const end = source.lastIndexOf(close);
  if (end === -1 || end < start) return null;

  return source.slice(start + open.length, end);
}

function parseLabels(raw: string | null): string[] {
  if (raw === null) return [];
  return raw
    .split(',')
    .map((label) => label.trim())
    .filter((label) => label.length > 0 && label.toLowerCase() !== '(none)');
}

/**
 * Read the draft the agent produced.
 *
 * @throws IssueDraftParseError when the block is absent or has no usable
 * title/body, so a malformed answer fails loudly instead of creating an empty
 * Issue.
 */
export function parseIssueDraft(output: string): IssueDraft {
  const normalized = output.replace(/\r\n?/g, '\n');
  const block = extractTag(normalized, DRAFT_TAG);

  if (block === null) {
    throw new IssueDraftParseError(
      `The agent did not emit an <${DRAFT_TAG}> block, so there is no Issue to create. ` +
        `Output was: ${normalized.trim().slice(0, 300) || '(empty)'}`,
    );
  }

  const title = (extractTag(block, 'title') ?? '').trim();
  const body = (extractTag(block, 'body') ?? '').trim();

  if (title.length === 0) {
    throw new IssueDraftParseError(`The <${DRAFT_TAG}> block has no <title>.`);
  }
  if (body.length === 0) {
    throw new IssueDraftParseError(`The <${DRAFT_TAG}> block has no <body>.`);
  }

  // Optional, and deliberately so: a repository with no Issue Types and no
  // templates emits neither, and the draft is exactly what it was before.
  const type = (extractTag(block, 'type') ?? '').trim();
  const template = (extractTag(block, 'template') ?? '').trim();

  return {
    title,
    body,
    labels: parseLabels(extractTag(block, 'labels')),
    ...(type === '' || type.toLowerCase() === '(none)' ? {} : { type }),
    ...(template === '' || template.toLowerCase() === '(none)' ? {} : { template }),
  };
}
