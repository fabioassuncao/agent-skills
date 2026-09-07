import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const GLOBAL_ROOT_ENV = 'ISSUE_FLOW_HOME';

const sandboxHome = mkdtempSync(join(tmpdir(), 'issue-flow-test-home-'));

process.env[GLOBAL_ROOT_ENV] = sandboxHome;

afterAll(() => {
  // Best-effort: a leftover temp dir must never fail the suite. macOS runners
  // occasionally report ENOTEMPTY while a sibling test still holds a handle.
  try {
    rmSync(sandboxHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});
