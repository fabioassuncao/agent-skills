import type { VerificationLevel, VerifyLevelInput } from './types.js';

/** L1 is the default. L2 only fires on an explicit ask or a configured trigger. */
export function decideLevel(input: VerifyLevelInput = {}): VerificationLevel {
  if (input.requested === 'L0' || input.requested === 'L3' || input.requested === 'L5') {
    return input.requested;
  }
  if (input.crossVerify === false) return 'L1';
  if (input.explicit === true || input.requested === 'L2') return 'L2';
  const triggers = input.triggers ?? [];
  const signals = input.signals ?? [];
  if (triggers.length > 0 && signals.some((signal) => triggers.includes(signal))) {
    return 'L2';
  }
  return 'L1';
}
