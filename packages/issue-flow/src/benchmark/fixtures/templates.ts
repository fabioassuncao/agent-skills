import type { AcceptanceCheck } from '../../verify/types.js';
import type { TaskClass } from '../corpus.js';

export interface FixtureTemplate {
  files: Record<string, string>;
  issueTitle: string;
  issueBody: string;
  expectedVerification: AcceptanceCheck[];
}

function withSeed(content: string, seed: number): string {
  return `${content}\n// fixture-seed:${seed}\n`;
}

export function templateFor(task: TaskClass, seed: number): FixtureTemplate {
  switch (task) {
    case 'trivial':
      return {
        files: {
          'src/answer.js': withSeed(
            [
              '/** The answer to life, the universe and everything. */',
              'export const ANSWER = 41;',
            ].join('\n'),
            seed,
          ),
        },
        issueTitle: 'Change one constant and its comment',
        issueBody: [
          'Change `ANSWER` in `src/answer.js` from 41 to 42.',
          'Update the comment so it no longer claims the wrong value.',
          'Do not add tests.',
        ].join('\n'),
        expectedVerification: [],
      };
    case 'small':
      return {
        files: {
          'src/sum.js': withSeed('export function sum(a, b) {\n  return a - b;\n}\n', seed),
          'src/sum.test.js': [
            "import { sum } from './sum.js';",
            "import assert from 'node:assert/strict';",
            'assert.equal(sum(2, 2), 4);',
            '',
          ].join('\n'),
          'package.json': `${JSON.stringify({ name: 'bench-small', type: 'module', scripts: { test: 'node src/sum.test.js' } }, null, 2)}\n`,
        },
        issueTitle: 'Fix a failing assertion in an existing test',
        issueBody: [
          '`src/sum.test.js` fails because `sum` subtracts instead of adding.',
          'Fix `src/sum.js` so `node src/sum.test.js` exits 0.',
          'Do not change the test.',
        ].join('\n'),
        expectedVerification: [{ id: 'existing-tests', run: 'node src/sum.test.js', fatal: true }],
      };
    case 'medium':
      return {
        files: {
          'src/greet.js': withSeed('// greet(name) is not implemented yet.\n', seed),
          'src/greet.test.js': [
            "import { greet } from './greet.js';",
            "import assert from 'node:assert/strict';",
            "assert.equal(greet('Ada'), 'Hello, Ada');",
            '',
          ].join('\n'),
          'README.md': ['# bench-medium', '', 'A tiny library.', ''].join('\n'),
          'package.json': `${JSON.stringify({ name: 'bench-medium', type: 'module', scripts: { test: 'node src/greet.test.js' } }, null, 2)}\n`,
        },
        issueTitle: 'Add a function, tests and a README note',
        issueBody: [
          'Implement `greet(name)` in `src/greet.js` so it returns Hello, <name>.',
          'Keep `src/greet.test.js` as the contract.',
          'Add an `## API` section to `README.md` documenting `greet`.',
        ].join('\n'),
        expectedVerification: [
          { id: 'tests', run: 'node src/greet.test.js', fatal: true },
          { id: 'docs', expectFiles: ['README.md'], fatal: true },
        ],
      };
    case 'analysis':
      return {
        files: {
          'src/alpha.js': withSeed('export const ALPHA = 1;\n', seed),
          'src/beta.js': withSeed(
            "import { ALPHA } from './alpha.js';\nexport const BETA = ALPHA + 1;\n",
            seed,
          ),
          'src/gamma.js': withSeed(
            "import { BETA } from './beta.js';\nexport const GAMMA = BETA + 1;\n",
            seed,
          ),
        },
        issueTitle: 'Read the tree and write a short report',
        issueBody: [
          'Read `src/` and write `report.md` describing the module graph.',
          'Do not change the source files.',
        ].join('\n'),
        expectedVerification: [{ id: 'artifact', expectFiles: ['report.md'], fatal: true }],
      };
    default: {
      const _exhaustive: never = task;
      throw new Error(`Unknown corpus class: ${_exhaustive}`);
    }
  }
}
