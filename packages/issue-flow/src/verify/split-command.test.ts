import { describe, expect, it } from 'vitest';
import { splitCommand } from './run-issue.js';

describe('splitCommand', () => {
  it('splits a plain command the way it always did', () => {
    expect(splitCommand('npm test')).toEqual(['npm', ['test']]);
    expect(splitCommand('npx  tsc   --noEmit')).toEqual(['npx', ['tsc', '--noEmit']]);
  });

  it('keeps a quoted argument whole', () => {
    // Checks run without a shell, so a naive whitespace split turned this into
    // ['-k', '"not', 'slow"'] and the check failed for the wrong reason.
    expect(splitCommand('pytest -k "not slow"')).toEqual(['pytest', ['-k', 'not slow']]);
    expect(splitCommand("npm test -- --grep 'a b'")).toEqual([
      'npm',
      ['test', '--', '--grep', 'a b'],
    ]);
  });

  it('preserves a deliberately empty argument', () => {
    expect(splitCommand('cmd --flag ""')).toEqual(['cmd', ['--flag', '']]);
  });

  it('falls back to the raw string when there is nothing to split', () => {
    expect(splitCommand('')).toEqual(['', []]);
  });
});
