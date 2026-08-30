import { describe, expect, it } from 'vitest';
import { decideLevel } from './level.js';

describe('decideLevel', () => {
  it('defaults to L1', () => {
    expect(decideLevel()).toBe('L1');
    expect(decideLevel({ triggers: ['high-risk'], signals: [] })).toBe('L1');
  });

  it('fires L2 only on an explicit ask or a matching trigger', () => {
    expect(decideLevel({ explicit: true })).toBe('L2');
    expect(decideLevel({ requested: 'L2' })).toBe('L2');
    expect(decideLevel({ triggers: ['high-risk'], signals: ['high-risk'] })).toBe('L2');
    expect(decideLevel({ crossVerify: false, explicit: true })).toBe('L1');
  });
});
