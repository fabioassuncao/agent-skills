#!/usr/bin/env node
/**
 * Real-mode entry for the #79 corpus. Synthetic lives in vitest so CI cannot
 * forget it. This file only gates the paid, variable path.
 */
const mode = process.argv.includes('--mode')
  ? process.argv[process.argv.indexOf('--mode') + 1]
  : 'synthetic';

if (mode === 'synthetic') {
  console.log(
    'Synthetic mode is the vitest file src/benchmark/synthetic.test.ts — run `npm test -- src/benchmark/synthetic.test.ts`.',
  );
  process.exit(0);
}

if (mode !== 'real') {
  console.error(`Unknown --mode ${mode}. Use synthetic or real.`);
  process.exit(2);
}

if (process.env.CI) {
  console.error('Real benchmark is forbidden in CI (cost and network variance).');
  process.exit(1);
}

console.log(`#79 real mode is operator-driven.

Flags that keep the measurement valid:
  --setting-sources <user,project,local>   # pin which settings files load
  do not pass --fallback-model             # a silent fallback invalidates the row

Record on every row: task class, harness, harnessVersion, model, model version,
effort, verification level, strategy (pipeline vs claude -p), and verdict.
Without #85 the verdict is unverified.

See scripts/bench/README.md and docs/research/2026-08-30-harness-baseline.md.
`);
