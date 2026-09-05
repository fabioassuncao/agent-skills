#!/usr/bin/env node
/**
 * Materialise, for the CLI's headless prompts, the contracts they include.
 *
 *   node scripts/sync-prompt-contracts.mjs --write   # regenerate
 *   node scripts/sync-prompt-contracts.mjs --check   # fail when one drifted
 *
 * A prompt says `<!-- include:tasks-schema.md -->`; `loadPrompt` expands it from
 * `prompts/_contracts/`. The source of each is whoever owns it — a shared
 * contract in `skills/_shared/contracts/`, or the single skill whose
 * `references/` holds it.
 *
 * These copies are a **build artifact**: the npm package is built and its
 * `files` already ships `prompts/`, so versioning them would buy nothing.
 * `prebuild` and `pretest` regenerate them, and `.gitignore` keeps them out.
 *
 * The skills tree is different — see `build-skills-tree.mjs`.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  GENERATED_PREFIX,
  PROMPT_CONTRACTS_DIR,
  ROOT,
  generatedHeader,
  listSkills,
  promptIncludes,
  resolveSource,
  sharedContracts,
} from './skill-contracts.mjs';

function render(from, source) {
  return `${generatedHeader(from)}\n\n${source.replace(/^\s+/, '')}`;
}

async function plan() {
  const skills = await listSkills();
  const shared = await sharedContracts();
  const targets = [];
  const missing = [];

  for (const [name, prompts] of await promptIncludes()) {
    const source = await resolveSource(name, shared, skills);
    if (source === null) {
      missing.push(`${name} (included by ${prompts.join(', ')}) has no source`);
      continue;
    }
    targets.push({ from: source.path, to: join(PROMPT_CONTRACTS_DIR, name) });
  }

  return { targets, missing };
}

/** Built files nothing includes any more. */
async function orphans(expected) {
  const found = [];
  let entries;
  try {
    entries = await readdir(join(ROOT, PROMPT_CONTRACTS_DIR), { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const path = join(PROMPT_CONTRACTS_DIR, entry.name);
    if (expected.has(path)) continue;
    const body = await readFile(join(ROOT, path), 'utf-8');
    if (body.startsWith(GENERATED_PREFIX)) found.push(path);
  }
  return found;
}

async function main() {
  const write = process.argv.includes('--write');
  const check = process.argv.includes('--check');

  if (write === check) {
    console.error('Usage: sync-prompt-contracts.mjs (--write | --check)');
    process.exit(2);
  }

  const { targets, missing } = await plan();

  if (missing.length > 0) {
    console.error('Cannot resolve every prompt include:\n');
    for (const line of missing) console.error(`  ${line}`);
    process.exit(1);
  }

  const sources = new Map();
  for (const { from } of targets) {
    if (!sources.has(from)) sources.set(from, await readFile(join(ROOT, from), 'utf-8'));
  }

  const expected = new Set(targets.map((t) => t.to));
  const drifted = [];

  for (const { from, to } of targets) {
    const wanted = render(from, sources.get(from));
    const absolute = join(ROOT, to);

    let current = null;
    try {
      current = await readFile(absolute, 'utf-8');
    } catch {
      /* absent */
    }
    if (current === wanted) continue;

    if (check) {
      drifted.push(`${current === null ? 'missing' : 'stale  '}  ${to}`);
      continue;
    }
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, wanted, 'utf-8');
  }

  for (const path of await orphans(expected)) {
    if (check) {
      drifted.push(`orphan   ${path}`);
      continue;
    }
    await rm(join(ROOT, path));
  }

  if (drifted.length > 0) {
    console.error('Prompt contracts are out of sync:\n');
    for (const line of drifted) console.error(`  ${line}`);
    console.error('\nRun `npm run skills:sync`.');
    process.exit(1);
  }

  console.log(`✓ ${targets.length} prompt contracts built from ${sources.size} sources`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
