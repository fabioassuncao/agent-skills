import { describe, expect, it } from 'vitest';
import { backgroundRejection, childArgv } from './detach.js';

describe('backgroundRejection', () => {
  it('refuses --mode manual', () => {
    expect(backgroundRejection('manual')).toMatch(/manual/);
  });

  it('refuses CI and a non-TTY', () => {
    expect(backgroundRejection('auto', { CI: '1' })).toMatch(/interactive terminal/);
  });
});

describe('childArgv', () => {
  it('drops --background and marks the child', () => {
    expect(childArgv(['run', '63', '--background', '--yes'])).toEqual([
      'run',
      '63',
      '--yes',
      '--detached-child',
    ]);
    expect(childArgv(['run', '63', '-d'])).toEqual(['run', '63', '--detached-child']);
  });
});
