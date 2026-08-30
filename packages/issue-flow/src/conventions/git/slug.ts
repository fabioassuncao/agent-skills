import { SLUG_MAX_LENGTH } from './types.js';

const COMBINING = /[\u0300-\u036f]/g;
const NON_SLUG = /[^a-z0-9]+/g;

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
