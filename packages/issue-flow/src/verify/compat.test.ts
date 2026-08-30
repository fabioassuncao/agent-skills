import { describe, expect, it } from 'vitest';
import { createInitialSnapshot } from '../core/session-state.js';
import { sessionSnapshotSchema } from '../schemas.js';

describe('verify compatibility', () => {
  it('loads a session.json written before verification existed', () => {
    const legacy = createInitialSnapshot();
    const { verification: _drop, ...without } = legacy;
    const parsed = sessionSnapshotSchema.parse(without);
    expect(parsed.verification).toBeNull();
  });

  it('does not invent a verdict on a round-trip of a fresh snapshot', () => {
    const parsed = sessionSnapshotSchema.parse(createInitialSnapshot());
    expect(parsed.verification).toBeNull();
  });
});
