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
 * A skill only works when it is self-contained, though — every real client
 * copies or scans the directory holding the SKILL.md and nothing above it. So
 * the tree that gets published is assembled: each skill directory, plus a copy
 * of every shared contract its SKILL.md actually cites.
 *
 * That published tree is what `npx skills add fabioassuncao/issue-flow#skills`
 * installs. The default branch carries sources, not the artifact.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  CONTRACTS_DIR,
  ROOT,
  SKILLS_DIR,
  citedReferences,
  generatedHeader,
  listSkills,
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

  await rm(outAbs, { recursive: true, force: true });
  await mkdir(outAbs, { recursive: true });

  const skills = await listSkills();
  const shared = await sharedContracts();
  const sources = new Map();
  let materialised = 0;

  for (const skill of skills) {
    const from = join(ROOT, SKILLS_DIR, skill);
    const to = join(outAbs, skill);

    // The whole directory: SKILL.md, README.md, references/, scripts/, assets/.
    // `scripts/` must stay executable, which `cp` preserves.
    await cp(from, to, { recursive: true });

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

  console.log(
    `✓ built ${skills.length} skills into ${out} ` +
      `(${materialised} shared contracts materialised from ${sources.size} sources)`,
  );
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
