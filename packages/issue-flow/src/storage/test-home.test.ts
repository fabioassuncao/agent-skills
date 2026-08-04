import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GLOBAL_DIR_NAME, GLOBAL_ROOT_ENV, getGlobalRoot } from './paths.js';

/**
 * Guards the safety net itself (`src/test-setup.ts`, wired as vitest's
 * `setupFiles`): if it is ever unwired or renamed, a suite that forgets its own
 * `ISSUE_FLOW_HOME` starts writing into the developer's real `~/.issue-flow`
 * again — silently, and only noticed much later. These assertions run in a file
 * that deliberately sets nothing of its own, so they see exactly what such a
 * suite would see.
 */
describe('test home sandbox', () => {
  it('points ISSUE_FLOW_HOME at a temporary directory', () => {
    // The setup file spells the variable out instead of importing it (importing
    // from src/ there would defeat every `vi.mock` of `utils/git.js`), so the
    // two spellings are checked against each other here.
    expect(GLOBAL_ROOT_ENV).toBe('ISSUE_FLOW_HOME');

    const sandbox = process.env[GLOBAL_ROOT_ENV];

    expect(sandbox).toBeDefined();
    expect(isAbsolute(sandbox ?? '')).toBe(true);
    expect(sandbox?.startsWith(tmpdir())).toBe(true);
  });

  it('keeps the resolved global root away from the real home directory', () => {
    expect(getGlobalRoot()).not.toBe(join(homedir(), GLOBAL_DIR_NAME));
    expect(getGlobalRoot()).toBe(process.env[GLOBAL_ROOT_ENV]);
  });
});
