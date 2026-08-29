import { basename, extname } from 'node:path';
import type { IssueTemplate } from '../types.js';
import { emptyTemplateMetadata, extractFrontMatter, parseTemplateMetadata } from './issue-forms.js';

/**
 * Turn a template file into an {@link IssueTemplate}.
 *
 * The format is decided by the extension, not by the content: `.yml`/`.yaml` is
 * an Issue Form whose whole document is metadata, everything else is a legacy
 * markdown template whose metadata — if any — lives in a front matter block.
 */
export function parseIssueTemplateFile(relPath: string, content: string): IssueTemplate {
  const extension = extname(relPath).toLowerCase();
  const isForm = extension === '.yml' || extension === '.yaml';

  const metadataSource = isForm ? content : extractFrontMatter(content);
  const metadata =
    metadataSource === null ? emptyTemplateMetadata() : parseTemplateMetadata(metadataSource);

  return {
    path: relPath,
    format: isForm ? 'form' : 'markdown',
    origin: 'filesystem',
    // A template with no `name:` is still addressable by its file name, which
    // is what GitHub falls back to for legacy markdown templates.
    name: metadata.name ?? basename(relPath, extension),
    about: metadata.about,
    title: metadata.title,
    labels: metadata.labels,
    type: metadata.type,
    assignees: metadata.assignees,
    content,
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a GraphQL connection (`{ nodes: [{ name }] }`) as a list of names, also
 * accepting a plain array of strings so a shape change does not break parsing.
 */
function asNameList(value: unknown, key: 'name' | 'login'): string[] {
  const entries = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.nodes)
      ? value.nodes
      : [];

  return entries
    .map((entry) =>
      typeof entry === 'string' ? entry : asString(isRecord(entry) ? entry[key] : null),
    )
    .filter((entry): entry is string => entry !== null && entry !== '');
}

/**
 * Parse the `repository.issueTemplates` connection of the GitHub GraphQL API.
 *
 * This is what makes the organization's `.github` repository visible: a
 * repository with no `.github/ISSUE_TEMPLATE/` of its own still serves the
 * organization defaults on github.com, and no amount of local filesystem
 * discovery can see them. GraphQL is used rather than REST because REST simply
 * has no endpoint for issue templates — and because the connection answers with
 * the bodies included, which keeps the whole discovery to a single round-trip.
 *
 * Never throws: an error payload, a missing repository or anything that is not
 * a list of template-shaped objects yields an empty list, which the caller
 * treats exactly like "GitHub answered nothing".
 */
export function parseOrganizationTemplates(payload: unknown): IssueTemplate[] {
  const repository = isRecord(payload) && isRecord(payload.data) ? payload.data.repository : null;
  const entries = isRecord(repository) ? repository.issueTemplates : null;
  if (!Array.isArray(entries)) return [];

  const templates: IssueTemplate[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const name = asString(entry.name);
    if (name === null) continue;

    templates.push({
      // The filename is the stable identity; the display name is not unique.
      path: asString(entry.filename) ?? name,
      format: 'markdown',
      origin: 'organization',
      name,
      about: asString(entry.about),
      title: asString(entry.title),
      labels: asNameList(entry.labels, 'name'),
      // GraphQL exposes no Issue Type on a template, so it stays unknown here
      // rather than being guessed from the name.
      type: null,
      assignees: asNameList(entry.assignees, 'login'),
      content: asString(entry.body) ?? '',
    });
  }
  return templates;
}
