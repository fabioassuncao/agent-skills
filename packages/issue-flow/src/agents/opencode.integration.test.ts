import { describe, expect, it } from 'vitest';

/**
 * Live OpenCode CLI suite. Guarded out of `npm test` — it needs `opencode`
 * installed and authenticated. Run with:
 *
 *   ISSUE_FLOW_E2E_OPENCODE=1 npx vitest run src/agents/opencode.integration.test.ts
 */
const enabled = process.env.ISSUE_FLOW_E2E_OPENCODE === '1';

describe.skipIf(!enabled)('opencode integration', () => {
  it('is skipped unless ISSUE_FLOW_E2E_OPENCODE=1', () => {
    expect(enabled).toBe(true);
  });
});
