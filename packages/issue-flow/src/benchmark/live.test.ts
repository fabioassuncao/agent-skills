import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import { corpusTask, materialize } from './fixtures/index.js';
import { assertLiveBenchAllowed, createLiveRepeatRunner } from './live.js';

const originalHome = process.env[GLOBAL_ROOT_ENV];

afterEach(() => {
  if (originalHome === undefined) delete process.env[GLOBAL_ROOT_ENV];
  else process.env[GLOBAL_ROOT_ENV] = originalHome;
});

describe('live bench isolation', () => {
  it('refuses to invoke a harness under npm test', () => {
    expect(() => assertLiveBenchAllowed({ VITEST: 'true' })).toThrow(/does not run under npm test/);
    expect(() =>
      assertLiveBenchAllowed({ VITEST: 'true', ISSUE_FLOW_E2E_BENCH: '1' }),
    ).not.toThrow();
  });

  it('does not write providers.json into the real home', async () => {
    const fixture = await materialize(corpusTask('trivial'), 99);
    const realHome = process.env[GLOBAL_ROOT_ENV];
    if (!realHome) throw new Error('expected the test setup to sandbox ISSUE_FLOW_HOME');
    const sentinel = join(realHome, 'projects', 'sentinel-providers.json');
    await mkdir(join(realHome, 'projects'), { recursive: true });
    await writeFile(sentinel, '{"keep":true}\n', 'utf-8');

    const campaignHome = join(realHome, 'bench', 'isolation-test');
    const runner = createLiveRepeatRunner({
      runPipeline: async () => {
        expect(process.env[GLOBAL_ROOT_ENV]).toBe(campaignHome);
        return 0;
      },
    });

    await expect(
      runner({
        fixture,
        arm: 'baseline',
        campaignHome,
        tuple: {
          task: 'trivial',
          harness: 'claude',
          harnessVersion: 'test',
          model: 'none',
          modelVersion: null,
          effort: 'none',
          verification: 'none',
          strategy: 'direct',
          settingSourcesPinned: true,
          strictMcpConfig: false,
          fallbackModelPassed: false,
        },
      }),
    ).rejects.toThrow(/does not run under npm test/);

    expect(process.env[GLOBAL_ROOT_ENV]).toBe(realHome);
    expect(await readFile(sentinel, 'utf-8')).toBe('{"keep":true}\n');
    await fixture.dispose();
  });
});
