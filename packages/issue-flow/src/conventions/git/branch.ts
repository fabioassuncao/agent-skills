import { slugify } from './slug.js';
import {
  BRANCH_MAX_LENGTH,
  type BranchInput,
  type ChangeType,
  DEFAULT_BRANCH_CONVENTION,
  isChangeType,
  type ParsedBranch,
} from './types.js';

const LEGACY_PREFIX = 'issue';

function branchType(type: ChangeType): string {
  return type === 'style' || type === 'revert' ? 'chore' : type;
}

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
  const type = branchType(input.type);
  const convention = input.convention ?? DEFAULT_BRANCH_CONVENTION;
  const slug = slugify(input.title);
  const raw = applyConvention(convention, type, input.issueNumber, slug);
  const truncated = truncateBranch(raw, BRANCH_MAX_LENGTH);
  return collide(truncated, input.existingRefs, input.currentOid);
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
