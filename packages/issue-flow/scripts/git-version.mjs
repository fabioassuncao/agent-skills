#!/usr/bin/env node
/**
 * Git side of `npm version` for this package.
 *
 * npm only commits and tags a version bump when it finds a `.git` directory in
 * the package folder. This package lives in `packages/issue-flow/` while `.git`
 * sits at the repository root, so npm silently skips the git step: it rewrites
 * package.json and stops there. That is how 0.4.3 and 0.4.4 reached npm with no
 * tag at all.
 *
 * These hooks restore the expected behavior:
 *   preversion  -> `check`  refuses to bump on a dirty tree
 *   postversion -> `commit` commits the bump and creates the vX.Y.Z tag
 *
 * Usage: node scripts/git-version.mjs <check|commit>
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(...args) {
  try {
    return execFileSync('git', ['-C', packageDir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim();
  } catch {
    fail(`git ${args.join(' ')} failed. The version bump was not committed.`);
  }
}

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

/**
 * Files the bump is allowed to touch. Absolute paths, because every git call
 * runs with `-C packageDir` and pathspecs would otherwise resolve against it.
 */
function bumpFiles() {
  return ['package.json', 'package-lock.json'].map((file) => resolve(packageDir, file));
}

function check() {
  if (git('status', '--porcelain')) {
    fail(
      'Working tree is not clean. Commit or stash your changes before bumping ' +
        'the version — the release commit must contain only the manifest change.',
    );
  }
}

function commit() {
  const require = createRequire(import.meta.url);
  const { version } = require('../package.json');
  const tag = `v${version}`;

  if (git('tag', '--list', tag)) {
    fail(`Tag ${tag} already exists. Pick a different version.`);
  }

  git('add', ...bumpFiles());
  git('commit', '-m', `chore(release): ${tag}`);
  git('tag', '-a', tag, '-m', tag);

  console.log(`\n  Created release commit and tag ${tag}.`);
  console.log('  Next: npm publish, then git push && git push --tags\n');
}

const command = process.argv[2];
if (command === 'check') check();
else if (command === 'commit') commit();
else fail(`Unknown command: ${command ?? '(none)'}. Use "check" or "commit".`);
