import { describe, expect, it } from 'vitest';
import {
  ANTIGRAVITY_CAPABILITIES,
  CLAUDE_CAPABILITIES,
  CODEX_CAPABILITIES,
  CURSOR_CAPABILITIES,
  OPENCODE_CAPABILITIES,
} from '../agents/types.js';
import { MODEL_CATALOG, modelsFor } from './models.js';

describe('MODEL_CATALOG', () => {
  it('covers every declared harness and every tier', () => {
    const capabilities = {
      'claude-code': CLAUDE_CAPABILITIES,
      'codex-cli': CODEX_CAPABILITIES,
      'cursor-cli': CURSOR_CAPABILITIES,
      'antigravity-cli': ANTIGRAVITY_CAPABILITIES,
      'opencode-cli': OPENCODE_CAPABILITIES,
    };
    for (const [harness, caps] of Object.entries(capabilities)) {
      expect(MODEL_CATALOG[harness]).toBeDefined();
      expect(modelsFor(harness, caps).map((entry) => entry.tier)).toEqual([
        'fast',
        'mid',
        'strong',
      ]);
    }
  });

  it('collapses the model axis when selection is unsupported', () => {
    expect(modelsFor('future-harness', { ...CLAUDE_CAPABILITIES, modelSelection: false })).toEqual([
      { id: null, tier: 'mid', relativeCost: 1, relativeLatency: 1 },
    ]);
  });
});
