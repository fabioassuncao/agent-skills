import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

const SLUG_MAX_LENGTH = 32;
const HASH_LENGTH = 12;
const FALLBACK_SLUG = 'project';

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
  return slug === '' ? FALLBACK_SLUG : slug;
}

/** Normalize HTTP, SSH and scp-like Git remotes to one stable identity. */
export function normalizeRemoteUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (trimmed === '') return null;

  let authority: string;
  let path: string;
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(trimmed);
  if (scheme) {
    const rest = trimmed.slice(scheme[0].length);
    const slash = rest.indexOf('/');
    if (slash === -1) return null;
    authority = rest.slice(0, slash);
    path = rest.slice(slash + 1);
  } else {
    const colon = trimmed.indexOf(':');
    if (colon === -1) return null;
    authority = trimmed.slice(0, colon);
    path = trimmed.slice(colon + 1);
  }

  const at = authority.lastIndexOf('@');
  if (at !== -1) authority = authority.slice(at + 1);
  const host = authority.replace(/:\d+$/, '').toLowerCase();
  if (host === '') return null;
  const normalizedPath = path
    .replace(/[?#].*$/, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  return normalizedPath === '' ? null : `${host}/${normalizedPath}`;
}

/** Derive the stable project id from a normalized remote or absolute path. */
export function projectIdFromRemote(remote: string | null, projectRoot: string): string {
  const seed = remote ? `remote:${remote}` : `path:${resolve(projectRoot)}`;
  const name = remote ? (remote.split('/').pop() ?? '') : basename(resolve(projectRoot));
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, HASH_LENGTH);
  return `${slugify(name)}-${hash}`;
}
