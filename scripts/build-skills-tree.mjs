#!/usr/bin/env node
/**
 * Assemble the publishable skills tree.
 *
 *   node scripts/build-skills-tree.mjs --out dist/skills
 *
 * The working tree holds **sources**: each skill's own references, plus the
 * handful of contracts in `skills/_shared/contracts/` that more than one skill
 * cites. Nothing is duplicated there.
 *
 * Individual installation requires a self-contained directory. So the tree
 * that gets published is assembled: each skill directory, plus a copy
 * of every shared contract its SKILL.md actually cites.
 *
 * That published tree is what `npx skills add fabioassuncao/issue-flow#skills`
 * installs. The default branch carries sources, not the artifact.
 */
import { cp, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  CONTRACTS_DIR,
  citedReferences,
  generatedHeader,
  listSkills,
  ROOT,
  SKILLS_DIR,
  sharedContracts,
} from './skill-contracts.mjs';

function parseOut() {
  const i = process.argv.indexOf('--out');
  if (i === -1 || !process.argv[i + 1]) {
    console.error('Usage: build-skills-tree.mjs --out <dir>');
    process.exit(2);
  }
  return process.argv[i + 1];
}

async function main() {
  const out = parseOut();
  // `--out` may be absolute (a temp dir in the tests) or relative to the
  // repository. `join(ROOT, '/tmp/x')` would quietly produce '<repo>/tmp/x'.
  const outAbs = isAbsolute(out) ? out : resolve(ROOT, out);

  // Never recursively remove a caller's directory. Rebuild only a tree we own.
  const marker = '.issue-flow-skills-build.json';
  let ancestor = outAbs;
  while (true) {
    try {
      await lstat(ancestor);
      break;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      ancestor = dirname(ancestor);
    }
  }
  const physicalOut = resolve(await realpath(ancestor), relative(ancestor, outAbs));
  const physicalRoot = await realpath(ROOT);
  const rootRelative = relative(physicalRoot, physicalOut);
  if (
    !rootRelative ||
    (!rootRelative.startsWith('..') && !rootRelative.startsWith('dist/')) ||
    relative(physicalOut, physicalRoot).split('/')[0] !== '..'
  ) {
    throw new Error('Unsafe --out: use dist/<name> or a separate empty temporary directory');
  }
  let entries = [];
  try {
    if ((await lstat(outAbs)).isSymbolicLink()) throw new Error('Output must not be a symlink');
    entries = await readdir(outAbs);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (entries.length) {
    let owned;
    try {
      owned = JSON.parse(await readFile(join(outAbs, marker), 'utf8'));
    } catch {
      throw new Error('Refusing to replace a nonempty directory without a build manifest');
    }
    if (
      owned.source !== physicalRoot ||
      !Array.isArray(owned.skills) ||
      entries.some((name) => name !== marker && !owned.skills.includes(name))
    ) {
      throw new Error('Refusing to remove unrecognized files in the output directory');
    }
  }

  await rm(outAbs, { recursive: true, force: true });
  await mkdir(outAbs, { recursive: true });

  const skills = await listSkills();
  await writeFile(join(outAbs, marker), `${JSON.stringify({ source: physicalRoot, skills })}\n`);
  const shared = await sharedContracts();
  const sources = new Map();
  let materialised = 0;

  for (const skill of skills) {
    const from = join(ROOT, SKILLS_DIR, skill);
    const to = join(outAbs, skill);

    // The whole directory: SKILL.md, README.md, references/, scripts/, assets/.
    // `scripts/` must stay executable, which `cp` preserves.
    await cp(from, to, { recursive: true });
    // An individual copied skill carries its license, not only an SPDX label.
    await cp(join(ROOT, 'LICENSE'), join(to, 'LICENSE'));

    const skillMd = await readFile(join(from, 'SKILL.md'), 'utf-8');
    for (const name of citedReferences(skillMd)) {
      if (!shared.has(name)) continue; // the skill owns it; already copied

      const sourcePath = join(CONTRACTS_DIR, name);
      if (!sources.has(sourcePath)) {
        sources.set(sourcePath, await readFile(join(ROOT, sourcePath), 'utf-8'));
      }

      const target = join(to, 'references', name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(
        target,
        `${generatedHeader(sourcePath)}\n\n${sources.get(sourcePath).replace(/^\s+/, '')}`,
        'utf-8',
      );
      materialised += 1;
    }
  }

  await writeFile(join(outAbs, marker), `${JSON.stringify({ source: physicalRoot, skills })}\n`);

  console.log(
    `✓ built ${skills.length} skills into ${out} ` +
      `(${materialised} shared contracts materialised from ${sources.size} sources)`,
  );
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
