import { createHash } from 'node:crypto';

/**
 * Content hashing shared by every Issue provider.
 *
 * The hash is what lets the resolver tell "the local and the remote Issue are
 * the same demand" from "they diverged", so it has to be stable across
 * platforms: Windows checkouts store CRLF, editors add or drop trailing
 * newlines, and neither should count as a content change.
 */

/** Normalizes line endings (CRLF/CR to LF) and trims the edges. */
function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

/**
 * Returns `sha256:<hex>` for the given title and body.
 *
 * The payload is a canonical JSON object rather than a concatenation, so text
 * moved from the title into the body always changes the hash.
 */
export function hashIssueContent(title: string, body: string): string {
  const payload = JSON.stringify({
    title: normalizeText(title),
    body: normalizeText(body),
  });
  const digest = createHash('sha256').update(payload, 'utf8').digest('hex');
  return `sha256:${digest}`;
}
