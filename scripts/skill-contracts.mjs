/**
 * Where the shared contracts live, and how a consumer finds one.
 *
 * A file is generated only when **two different consumers must hold the same
 * text**. Everything else has exactly one owner and is edited in place.
 *
 * That rule is what keeps the tree small. Most of what looks shared is not: five
 * of the original eleven contracts were cited by a single skill, and their only
 * second reader was a CLI prompt — which is a build artifact, not a committed
 * file. Those moved into the skill that owns them.
 *
 * The copies that remain are *inside* each skill on purpose. Installing one
 * directory does not install its siblings, so a `../_shared/` link that works
 * in this repository would dangle in an individual installation.
 * Git makes it worse on Windows: with `core.symlinks`
 * false, "symbolic links are checked out as small plain files that contain the
 * link text", so a symlink would be read as its own target path.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdownResources } from './skills-format.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Contracts shared by more than one skill. The only generated files. */
export const CONTRACTS_DIR = 'skills/_shared/contracts';
export const SKILLS_DIR = 'skills';

/** Built at pack/test time from whichever consumer owns each contract. */
export const PROMPT_CONTRACTS_DIR = 'packages/issue-flow/prompts/_contracts';
export const PROMPTS_DIR = 'packages/issue-flow/prompts';

/** Header stamped on every generated copy, and the marker that identifies one. */
export const GENERATED_PREFIX = '<!-- Generated from ';

export function generatedHeader(from) {
  return `${GENERATED_PREFIX}${from} — generated artifact; do not edit. -->`;
}

/** Every skill directory, in name order. */
export async function listSkills() {
  const entries = await readdir(join(ROOT, SKILLS_DIR), { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/**
 * The `references/<name>.md` a SKILL.md actually points at.
 *
 * This is the map. It used to be a hand-written list, which drifted from
 * reality and left four generated files that nothing referenced — dead weight
 * that no check caught, because a dead file is not a broken one. Deriving it
 * makes adding a citation the only action needed, and makes an orphan
 * impossible by construction.
 */
export function citedReferences(skillMd) {
  const found = new Set();
  for (const { target } of markdownResources(skillMd).links) {
    const match = target.match(/^references\/([a-z0-9-]+\.md)(?:#.*)?$/);
    if (match) found.add(match[1]);
  }
  return found;
}

/** Contract names available in `_shared/contracts/`. */
export async function sharedContracts() {
  const entries = await readdir(join(ROOT, CONTRACTS_DIR), { withFileTypes: true });
  return new Set(entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name));
}

/**
 * Resolve where a contract's text comes from.
 *
 * Shared contracts live in `_shared/contracts/`. A single-owner contract lives
 * in the one skill that cites it — and two owners for the same name is a
 * mistake worth failing on rather than picking one.
 */
export async function resolveSource(name, shared, skills) {
  if (shared.has(name)) {
    return { path: join(CONTRACTS_DIR, name), shared: true };
  }

  const owners = [];
  for (const skill of skills) {
    const candidate = join(SKILLS_DIR, skill, 'references', name);
    try {
      const body = await readFile(join(ROOT, candidate), 'utf-8');
      if (!body.startsWith(GENERATED_PREFIX)) owners.push(candidate);
    } catch {
      /* not here */
    }
  }

  if (owners.length === 1) return { path: owners[0], shared: false };
  if (owners.length === 0) return null;
  throw new Error(
    `${name} has ${owners.length} owners (${owners.join(', ')}). ` +
      `A contract with more than one owner belongs in ${CONTRACTS_DIR}.`,
  );
}

/** Contract names the CLI prompts include, and which prompt asks for each. */
export async function promptIncludes() {
  const dir = join(ROOT, PROMPTS_DIR);
  const entries = await readdir(dir, { withFileTypes: true });
  const includes = new Map();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const body = await readFile(join(dir, entry.name), 'utf-8');
    for (const [, name] of body.matchAll(/<!--\s*include:([A-Za-z0-9._-]+)\s*-->/g)) {
      if (!includes.has(name)) includes.set(name, []);
      includes.get(name).push(entry.name);
    }
  }

  return includes;
}

export { ROOT };
