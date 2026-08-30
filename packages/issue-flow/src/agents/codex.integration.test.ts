import { describe, expect, it } from 'vitest';

/**
 * Live Codex CLI suite. Guarded out of `npm test` — it needs `codex`
 * installed and authenticated. Run with:
 *
 *   ISSUE_FLOW_E2E_CODEX=1 npx vitest run src/agents/codex.integration.test.ts
 */
const enabled = process.env.ISSUE_FLOW_E2E_CODEX === '1';

describe.skipIf(!enabled)('codex integration', () => {
  it('is skipped unless ISSUE_FLOW_E2E_CODEX=1', () => {
    expect(enabled).toBe(true);
  });
});
