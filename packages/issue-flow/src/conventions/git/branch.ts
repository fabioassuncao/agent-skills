import {
  type AutoNameBranchOptions,
  autoNameBranch,
  type BranchNameGenerator,
  generateFallbackBranchName,
} from './auto-name.js';
import { slugify } from './slug.js';
import {
  BRANCH_MAX_LENGTH,
  type BranchInput,
  DEFAULT_BRANCH_CONVENTION,
  isChangeType,
  type ParsedBranch,
} from './types.js';

const LEGACY_PREFIX = 'issue';

export { isValidBranchName, sanitizeBranchName } from './slug.js';

function applyConvention(
  convention: string,
  type: string,
  issueNumber: number | null | undefined,
  slug: string,
): string {
  const hasNumber = issueNumber !== undefined && issueNumber !== null;
  let result = convention
    .replaceAll('{type}', type)
    .replaceAll('{N}', hasNumber ? String(issueNumber) : '')
    .replaceAll('{slug}', slug);

  result = result.replace(/\/{2,}/g, '/').replace(/-{2,}/g, '-');
  result = result.replace(/\/-/g, '/').replace(/-\//g, '/');
  result = result.replace(/^\/+|\/+$/g, '').replace(/^-+|-+$/g, '');

  // `{type}/{N}-{slug}` without a number becomes `{type}/{slug}` or `{type}`.
  if (!hasNumber) {
    result = result.replace(`${type}/-`, `${type}/`).replace(/\/$/g, '');
  }
  if (slug === '') {
    result = result.replace(/\/-$/, '').replace(/-$/, '');
  }
  return result.replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '');
}

function truncateBranch(name: string, max: number): string {
  if (name.length <= max) return name;
  const slash = name.indexOf('/');
  const prefix = slash === -1 ? '' : name.slice(0, slash + 1);
  const rest = slash === -1 ? name : name.slice(slash + 1);
  const budget = max - prefix.length;
  if (budget < 1) return name.slice(0, max);
  const cut = rest.slice(0, budget);
  const lastHyphen = cut.lastIndexOf('-');
  const trimmed = lastHyphen >= Math.floor(budget / 2) ? cut.slice(0, lastHyphen) : cut;
  return `${prefix}${trimmed.replace(/-+$/g, '')}`;
}

function collide(
  name: string,
  existingRefs: readonly { name: string; oid: string }[] | undefined,
  currentOid: string | undefined,
): string {
  if (existingRefs === undefined || existingRefs.length === 0) return name;
  const byName = new Map(existingRefs.map((ref) => [ref.name, ref.oid]));
  const existing = byName.get(name);
  if (existing === undefined) return name;
  if (currentOid !== undefined && existing === currentOid) return name;

  for (let n = 2; n < 100; n += 1) {
    const candidate = `${name}-${n}`;
    const oid = byName.get(candidate);
    if (oid === undefined || (currentOid !== undefined && oid === currentOid)) {
      return candidate;
    }
  }
  return `${name}-${Date.now()}`;
}

/**
 * Deterministic branch name. Same issue, same title, same convention — same
 * bytes, regardless of who runs it.
 */
export function branchName(input: BranchInput): string {
  const convention = input.convention ?? DEFAULT_BRANCH_CONVENTION;
  const slug = slugify(input.title);
  const raw = applyConvention(convention, input.type, input.issueNumber, slug);
  const truncated = truncateBranch(raw, input.maxLength ?? BRANCH_MAX_LENGTH);
  return collide(truncated, input.existingRefs, input.currentOid);
}

/** How {@link resolveBranchName} arrived at the name it returns. */
export type BranchNameSource = 'convention' | 'generated' | 'fallback';

export interface ResolveBranchNameInput extends Omit<BranchInput, 'title'> {
  /** Issue or document title. Optional: path 2 works from a description alone. */
  title?: string;
  /** Free-form statement of the work, used when there is no issue to name from. */
  description?: string;
  /**
   * The generated-name path. Absent — or absent a description — the resolver
   * never reaches it, which is what keeps `headless` free of any model call.
   */
  autoName?: { generate: BranchNameGenerator; config?: AutoNameBranchOptions } | null;
}

export interface ResolvedBranchName {
  branch: string;
  source: BranchNameSource;
}

/**
 * The three paths a branch name can take (§10.4).
 *
 * 1. A known issue, or a title that still slugifies to something → the
 *    repository's convention, unchanged from what Issue Flow always did.
 * 2. No issue but a description, with a generator configured → a generated
 *    name: flat, kebab-case, no prefix. This is the case the convention never
 *    served, where the slug came out of an arbitrary document title.
 * 3. Neither → `change-<uuid8>`, which is always a legal branch name.
 */
export async function resolveBranchName(
  input: ResolveBranchNameInput,
): Promise<ResolvedBranchName> {
  const title = input.title ?? '';
  const hasIssue = input.issueNumber !== undefined && input.issueNumber !== null;

  if (hasIssue || slugify(title) !== '') {
    return { branch: branchName({ ...input, title }), source: 'convention' };
  }

  const description = input.description ?? '';
  if (input.autoName != null && description.trim() !== '') {
    return await autoNameBranch(description, input.autoName.generate, input.autoName.config);
  }

  return { branch: generateFallbackBranchName(), source: 'fallback' };
}

/**
 * Extract type and issue number from a branch, including the historical
 * `issue/{N}-*` form so existing worktrees keep archiving correctly.
 */
export function parseBranch(name: string): ParsedBranch {
  const raw = name.trim();
  const match = raw.match(/^([^/]+)\/(?:(\d+)(?:-(.*))?|(.*))$/);
  if (match === null) {
    return { type: null, issueNumber: null, slug: raw, raw };
  }
  const prefix = match[1] ?? '';
  const numbered = match[2];
  const numberedSlug = match[3] ?? '';
  const unnumberedSlug = match[4] ?? '';
  const type: ParsedBranch['type'] =
    prefix === LEGACY_PREFIX ? 'issue' : isChangeType(prefix) ? prefix : null;
  if (numbered !== undefined) {
    return { type, issueNumber: Number(numbered), slug: numberedSlug, raw };
  }
  return { type, issueNumber: null, slug: unnumberedSlug, raw };
}

/** Folder-safe archive name that still carries the issue number. */
export function archiveFolderName(branch: string): string {
  const parsed = parseBranch(branch);
  if (parsed.issueNumber !== null && parsed.slug !== '') {
    return `${parsed.issueNumber}-${parsed.slug}`.replace(/[<>:"|?*\\]/g, '_');
  }
  if (parsed.issueNumber !== null) {
    return String(parsed.issueNumber);
  }
  return branch.replace(/^[^/]+\//, '').replace(/[<>:"|?*\\]/g, '_');
}
