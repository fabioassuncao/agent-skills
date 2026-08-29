import { posix } from 'node:path';
import type { PolicyDocumentKind } from '../types.js';

/**
 * Classification and link extraction for the prose documents that carry
 * repository policy.
 */

/** Which kind of policy document a file name denotes, or null. */
export function classifyDocument(fileName: string): PolicyDocumentKind | null {
  switch (fileName.toLowerCase()) {
    case 'agents.md':
      return 'agents';
    case 'claude.md':
      return 'claude';
    case 'contributing.md':
      return 'contributing';
    case 'code_of_conduct.md':
    case 'code-of-conduct.md':
      return 'code-of-conduct';
    default:
      return null;
  }
}

/** How many referenced documents a single index may pull in. */
export const MAX_REFERENCED_DOCUMENTS = 20;

const MARKDOWN_LINK = /\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * Repository-relative paths of the markdown documents an index links to.
 *
 * `AGENTS.md` is an index, not a corpus: following its links one level respects
 * what the repository chose to point at, where scanning `docs/` blindly would
 * pull in changelogs, ADR archives and translated copies — a large context cost
 * for content the repository never nominated as policy.
 *
 * Only in-repository markdown targets survive: an absolute URL, a mailto, an
 * anchor, a path that escapes the root, or a link to a non-markdown asset are
 * all dropped. `fromPath` is the repository-relative path of the linking
 * document, used to resolve relative links.
 */
export function extractReferencedDocuments(content: string, fromPath: string): string[] {
  const fromDir = posix.dirname(fromPath.replace(/\\/g, '/'));
  const found: string[] = [];

  for (const match of content.matchAll(MARKDOWN_LINK)) {
    const raw = match[1];
    if (raw === undefined) continue;

    const target = raw.split('#')[0]?.split('?')[0]?.trim() ?? '';
    if (target === '') continue;
    // Absolute URLs, protocol-relative URLs and mail links point outside the
    // repository; a Windows-style drive letter is not a repository path either.
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.startsWith('//')) continue;
    if (!/\.(md|markdown)$/i.test(target)) continue;

    const resolved = posix.normalize(
      target.startsWith('/')
        ? target.slice(1)
        : fromDir === '.'
          ? target
          : posix.join(fromDir, target),
    );
    if (resolved.startsWith('..') || resolved === '' || resolved === '.') continue;
    if (resolved === fromPath || found.includes(resolved)) continue;

    found.push(resolved);
    if (found.length >= MAX_REFERENCED_DOCUMENTS) break;
  }

  return found;
}
