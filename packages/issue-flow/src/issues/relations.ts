import type { IssueRelations } from './types.js';

/**
 * Pure helpers around {@link IssueRelations}.
 *
 * Everything here is origin-agnostic: a provider maps its own payload into
 * these shapes, and the textual heuristic below is the shared fallback for
 * repositories that express hierarchy and dependencies in Markdown instead of
 * through a structured API.
 */

/** Relations of an Issue nothing is known about — every field empty. */
export function emptyRelations(id: string): IssueRelations {
  return {
    id,
    parent: null,
    children: [],
    blockedBy: [],
    blocking: [],
    references: [],
    referencedBy: [],
    heuristic: [],
  };
}

/** Whether an Issue relates to nothing at all (mentions included). */
export function hasNoRelations(relations: IssueRelations): boolean {
  return (
    relations.parent === null &&
    relations.children.length === 0 &&
    relations.blockedBy.length === 0 &&
    relations.blocking.length === 0
  );
}

/** Deduplicate preserving order, dropping empty entries and `self`. */
export function uniqueIds(ids: readonly string[], self?: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (id === '' || id === self || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** What {@link parseTextualRelations} can recover from a Markdown body. */
export interface TextualRelations {
  children: string[];
  blockedBy: string[];
  blocking: string[];
  /** Every other `#N` cited, with no relation attached to it. */
  references: string[];
}

/**
 * Code spans and fenced blocks, blanked out before scanning.
 *
 * A snippet that happens to contain `#42` (a shell comment, a CSS colour, a
 * diff hunk header) is documentation, not a dependency — and it is exactly the
 * kind of false positive that would put an unrelated Issue in front of the user
 * as "part of this hierarchy".
 */
function stripCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/** Keyword forms accepted before a list of ids, per relation kind. */
const BLOCKED_BY = /\b(?:depends[- ]on|depends upon|blocked[- ]by|requires)\b\s*:?\s*/gi;
const BLOCKING = /\b(?:blocks|blocking)\b\s*:?\s*/gi;

/** A task list item (`- [ ] #12 …`), the Markdown spelling of a sub-issue. */
const TASK_ITEM = /^[ \t]*[-*]\s*\[[ xX]\]\s*(.*)$/gm;

/** Every `#N` that is not glued to a word character (`abc#12` is not a citation). */
const ANY_ID = /(?:^|[^\w#])#(\d+)\b/g;

/**
 * Ids of the `#a, #b and #c` run that starts exactly at `text`.
 *
 * Anchored on purpose: the keyword must be immediately followed by the list, so
 * "blocked by the API redesign discussed in #12" contributes nothing — the
 * sentence names a cause, not a dependency.
 */
function idsFrom(text: string): string[] {
  const ids: string[] = [];
  const id = /#(\d+)/y;
  let cursor = 0;

  while (cursor < text.length) {
    id.lastIndex = cursor;
    const match = id.exec(text);
    if (match === null) break;
    ids.push(match[1] as string);
    cursor = id.lastIndex;

    // Consume the separator between two ids of the same list.
    const separator = /^\s*(?:,|and\b|e\b|&)\s*/i.exec(text.slice(cursor));
    if (separator === null) break;
    cursor += separator[0].length;
  }

  return ids;
}

function collect(body: string, keyword: RegExp): string[] {
  const ids: string[] = [];
  keyword.lastIndex = 0;
  let match = keyword.exec(body);
  while (match !== null) {
    ids.push(...idsFrom(body.slice(keyword.lastIndex)));
    match = keyword.exec(body);
  }
  return ids;
}

/**
 * Best-effort hierarchy and dependencies from a Markdown body.
 *
 * Heuristic by construction, and documented as such everywhere it surfaces: a
 * repository that never adopted GitHub's Sub-issues or Issue Dependencies still
 * expresses the same information in prose, and refusing to read it would leave
 * most repositories with an empty graph. The trade-off is accepted with three
 * guards — code is stripped first, only explicit keywords create a relation,
 * and everything else is demoted to a plain reference, which no consumer orders
 * execution by.
 *
 * `self` (the Issue's own id) is filtered out of every list: a body that says
 * "part 2 of #51" while being #51 must not depend on itself.
 */
export function parseTextualRelations(body: string, self?: string): TextualRelations {
  const text = stripCode(body ?? '');

  const blockedBy = collect(text, BLOCKED_BY);
  const blocking = collect(text, BLOCKING);

  const children: string[] = [];
  TASK_ITEM.lastIndex = 0;
  let item = TASK_ITEM.exec(text);
  while (item !== null) {
    const content = item[1] ?? '';
    // Only the first citation of the item is the sub-issue; the rest of the
    // line is prose that may cite anything.
    const first = /(?:^|[^\w#])#(\d+)\b/.exec(` ${content}`);
    if (first?.[1] !== undefined) {
      children.push(first[1]);
    }
    item = TASK_ITEM.exec(text);
  }

  const classified = new Set([...blockedBy, ...blocking, ...children]);
  const references: string[] = [];
  ANY_ID.lastIndex = 0;
  let cited = ANY_ID.exec(text);
  while (cited !== null) {
    const id = cited[1] as string;
    if (!classified.has(id)) {
      references.push(id);
    }
    // Overlapping matches: `#1 #2` shares the separator, so rewind by one.
    ANY_ID.lastIndex = Math.max(ANY_ID.lastIndex - 1, cited.index + 1);
    cited = ANY_ID.exec(text);
  }

  return {
    children: uniqueIds(children, self),
    blockedBy: uniqueIds(blockedBy, self),
    blocking: uniqueIds(blocking, self),
    references: uniqueIds(references, self),
  };
}

/**
 * Merge structured relations with the textual fallback, recording which
 * identifiers exist only because of the heuristic.
 *
 * Structured data always wins the ordering of a list (it is listed first), and
 * an id present in both is *not* marked heuristic — it was confirmed by an API.
 */
export function mergeRelations(
  structured: Omit<IssueRelations, 'heuristic'>,
  textual: TextualRelations,
): IssueRelations {
  const self = structured.id;

  const children = uniqueIds([...structured.children, ...textual.children], self);
  const blockedBy = uniqueIds([...structured.blockedBy, ...textual.blockedBy], self);
  const blocking = uniqueIds([...structured.blocking, ...textual.blocking], self);
  const references = uniqueIds([...structured.references, ...textual.references], self);

  const fromApi = new Set([
    ...structured.children,
    ...structured.blockedBy,
    ...structured.blocking,
    ...(structured.parent === null ? [] : [structured.parent]),
  ]);
  const heuristic = uniqueIds(
    [...textual.children, ...textual.blockedBy, ...textual.blocking].filter(
      (id) => !fromApi.has(id),
    ),
    self,
  );

  return {
    id: self,
    parent: structured.parent,
    children,
    blockedBy,
    blocking,
    references,
    referencedBy: uniqueIds(structured.referencedBy, self),
    heuristic,
  };
}
