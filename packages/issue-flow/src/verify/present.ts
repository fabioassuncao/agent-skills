import type { VerdictStatus, VerificationLevel } from './types.js';

/** One-line label. `unverified` is never phrased as a verified success. */
export function formatVerificationLine(
  verdict: VerdictStatus,
  level: VerificationLevel | string | null = null,
): string {
  const suffix = level !== null && level !== '' ? ` (${level})` : '';
  if (verdict === 'passed') return `Acceptance contract passed${suffix}`;
  if (verdict === 'failed') return `Acceptance contract failed${suffix}`;
  return `Acceptance contract unverified${suffix} — nothing objective confirmed`;
}
