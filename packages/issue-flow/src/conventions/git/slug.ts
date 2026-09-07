import { SLUG_MAX_LENGTH } from './types.js';

const COMBINING = /[\u0300-\u036f]/g;
const NON_SLUG = /[^a-z0-9]+/g;

/** Characters git itself refuses in a ref name. Ported from WebMux `domain/policies.ts`. */
const INVALID_BRANCH_CHARS = /[~^:?*[\]\\]+/g;

/**
 * Reduce an arbitrary string to something `git check-ref-format --branch`
 * accepts, without imposing a shape on it.
 *
 * Every clause matches a rule git enforces: no whitespace, none of `~^:?*[]\`,
 * no `@{`, no `..`, no doubled or edge separators, no `.lock` suffix. Unlike
 * {@link slugify} it keeps `/` and `.`, because a name that already carries a
 * legal prefix must survive unchanged. Dropping any clause turns a bad
 * generated name into a `git worktree add` that fails seconds later.
 */
export function sanitizeBranchName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(INVALID_BRANCH_CHARS, '')
    .replace(/@\{/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-/]+|[.\-/]+$/g, '')
    .replace(/\.lock$/i, '');
}

/**
 * Longest ref name this project will create.
 *
 * git's own limit is a filesystem path component, which is 255 bytes on every
 * platform that matters. A name past it fails inside `git worktree add`, where
 * the error names a path nobody recognises.
 */
export const BRANCH_NAME_MAX_LENGTH = 255;

/**
 * A name is valid exactly when sanitizing it changes nothing — and fits.
 *
 * The single validator for the whole project: `src/runtime/worktree/` asks this
 * one rather than keeping a second opinion about what git accepts, because two
 * validators disagreeing is how a name passes one check and fails the other
 * halfway through creating a worktree.
 */
export function isValidBranchName(raw: string): boolean {
  return raw.length > 0 && raw.length <= BRANCH_NAME_MAX_LENGTH && sanitizeBranchName(raw) === raw;
}

/**
 * Deterministic slug: NFD, strip diacritics, lowercase, hyphenate, collapse,
 * trim edges, drop a trailing `.lock`, and truncate on a word boundary.
 */
export function slugify(title: string, maxLength: number = SLUG_MAX_LENGTH): string {
  const withoutLock = title.replace(/\.lock$/i, '');
  const normalized = withoutLock.normalize('NFD').replace(COMBINING, '').toLowerCase();
  let slug = normalized.replace(NON_SLUG, '-').replace(/^-+|-+$/g, '');
  slug = slug.replace(/\.{2,}/g, '.').replace(/^\.+|\.+$/g, '');
  slug = slug.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

  if (slug.length <= maxLength) return slug;
  const cut = slug.slice(0, maxLength);
  const lastHyphen = cut.lastIndexOf('-');
  if (lastHyphen >= Math.floor(maxLength / 2)) {
    return cut.slice(0, lastHyphen).replace(/-+$/g, '');
  }
  return cut.replace(/-+$/g, '');
}
