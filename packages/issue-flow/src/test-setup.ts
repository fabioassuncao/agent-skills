import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/**
 * Vitest `setupFiles` entry: no test may ever write into the real
 * `~/.issue-flow`.
 *
 * Every command resolves its paths through `resolveIssuePaths()`, which reads
 * `ISSUE_FLOW_HOME` from the real `process.env` — the `{ env }` seam only
 * reaches storage helpers called directly. A test file that drives a command
 * and forgets to point the variable somewhere temporary therefore pollutes the
 * developer's home directory, silently and permanently (it happened twice
 * during the migration to the global storage).
 *
 * This runs once per test file, before its module graph is imported, and gives
 * that file a throwaway home. It is a **safety net, not a substitute** for the
 * per-file setup: a suite that asserts on paths still needs its own `mkdtemp` +
 * `resetStorageResolutionCache()` in `beforeEach` to stay isolated from the
 * previous case. Those setups save and restore the previous value, so they nest
 * inside this one instead of tearing it down.
 *
 * The variable name is written out rather than imported from `storage/paths.ts`
 * on purpose: importing anything from `src/` here would load that module — and
 * its `../utils/git.js` dependency — into the registry *before* a test file's
 * `vi.mock()` calls are hoisted, so the mocks would silently not apply.
 * `storage/test-home.test.ts` asserts that this literal still matches
 * `GLOBAL_ROOT_ENV`.
 */
const GLOBAL_ROOT_ENV = 'ISSUE_FLOW_HOME';

const sandboxHome = mkdtempSync(join(tmpdir(), 'issue-flow-test-home-'));

process.env[GLOBAL_ROOT_ENV] = sandboxHome;

afterAll(() => {
  rmSync(sandboxHome, { recursive: true, force: true });
});
