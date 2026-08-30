import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cursorStorageGranted, ensureCursorStorageGrant, MANAGED_MARKER } from './permissions.js';

describe('ensureCursorStorageGrant', () => {
  it('writes managed Read/Write entries without dropping foreign ones', async () => {
    const home = process.env.ISSUE_FLOW_HOME ?? '/tmp';
    const path = join(home, 'cursor-cli-config.json');
    await writeFile(
      path,
      JSON.stringify({ permissions: { allow: ['Shell(git *)'] }, other: true }, null, 2),
    );
    const globalRoot = join(home, 'issue-flow-grant');

    const first = await ensureCursorStorageGrant({
      mode: 'global',
      globalRoot,
      filePath: path,
    });
    expect('wrote' in first && first.wrote).toBe(true);
    const once = JSON.parse(await readFile(path, 'utf-8')) as {
      permissions: { allow: string[] };
      other: boolean;
      [key: string]: unknown;
    };
    expect(once.other).toBe(true);
    expect(once.permissions.allow).toContain('Shell(git *)');
    expect(once[MANAGED_MARKER]).toBe(true);
    expect(cursorStorageGranted(once.permissions.allow, globalRoot)).toBe(true);

    const second = await ensureCursorStorageGrant({
      mode: 'global',
      globalRoot,
      filePath: path,
    });
    expect('wrote' in second && second.wrote).toBe(false);
    const twice = JSON.parse(await readFile(path, 'utf-8')) as { permissions: { allow: string[] } };
    expect(twice.permissions.allow).toEqual(once.permissions.allow);
  });

  it('skips when permissionsFile is none', async () => {
    const result = await ensureCursorStorageGrant({ mode: 'none' });
    expect(result).toEqual({ skipped: true, reason: 'none' });
  });
});
