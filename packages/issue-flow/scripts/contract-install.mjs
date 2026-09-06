#!/usr/bin/env node
/**
 * Install `packages/issue-flow-contract` when, and only when, it is missing.
 *
 * The contract is a sibling package with its own lockfile: it pins zod 3, which
 * is what `@ts-rest/core@3` peers on, while this package runs on zod 4. Keeping
 * the two installs apart is what stops one from dragging the other's major
 * along — but it also means `npm ci` here does not reach it, and the dashboard
 * build and suite both resolve it.
 *
 * So this runs as a `pre` hook of `build:web`, `test:web` and `test:contract`,
 * and it has to be nearly free when there is nothing to do: `npm ci` deletes and
 * rebuilds `node_modules` every time, which is fine on CI and miserable in a
 * dev loop. The existence check is what makes hooking it three times sane.
 *
 * `--force` reinstalls regardless, for when the lockfile changed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const contractRoot = join(packageRoot, '..', 'issue-flow-contract');
const force = process.argv.includes('--force');

if (!existsSync(join(contractRoot, 'package.json'))) {
  console.error(`contract-install: no package at ${contractRoot}`);
  process.exit(1);
}

if (!force && existsSync(join(contractRoot, 'node_modules'))) {
  process.exit(0);
}

console.log(`contract-install: npm ci in ${contractRoot}`);
execFileSync('npm', ['ci'], { cwd: contractRoot, stdio: 'inherit' });
