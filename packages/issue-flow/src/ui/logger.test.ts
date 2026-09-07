import { describe, expect, it } from 'vitest';
import { formatSubsystemLine } from './logger.js';

describe('formatSubsystemLine', () => {
  it('adds the time and subsystem through the shared logger format', () => {
    expect(
      formatSubsystemLine('serve', 'registered projects=1', new Date('2026-09-06T16:32:53.918Z')),
    ).toBe('[16:32:53.918] [serve] registered projects=1');
  });

  it('redacts credentials before a subsystem line reaches stdout', () => {
    expect(
      formatSubsystemLine(
        'serve',
        'Authorization: Bearer github_pat_secret-value',
        new Date('2026-09-06T16:32:53.918Z'),
      ),
    ).not.toContain('github_pat_secret-value');
  });
});
