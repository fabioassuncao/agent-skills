import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runRoutingUse, writeRoutingPreference } from './routing.js';

describe('routing configuration commands', () => {
  it('writes the recommended policy globally without replacing other keys', async () => {
    const home = process.env.ISSUE_FLOW_HOME;
    if (!home) throw new Error('ISSUE_FLOW_HOME must be set by test-setup');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.json'), JSON.stringify({ web: { port: 9999 } }));
    const path = await writeRoutingPreference({
      target: 'global',
      values: { policy: 'recommended', mode: 'active' },
    });
    const written = JSON.parse(await readFile(path, 'utf-8'));
    expect(written.web).toEqual({ port: 9999 });
    expect(written.routing).toEqual({ policy: 'recommended', mode: 'active' });
  });

  it('rejects unknown embedded policies', async () => {
    await expect(runRoutingUse('magic')).resolves.toBe(1);
  });

  it('enables the recommended policy and active mode in one command', async () => {
    const home = process.env.ISSUE_FLOW_HOME;
    if (!home) throw new Error('ISSUE_FLOW_HOME must be set by test-setup');

    await expect(runRoutingUse('recommended', { active: true, global: true })).resolves.toBe(0);

    const written = JSON.parse(await readFile(join(home, 'config.json'), 'utf-8'));
    expect(written.routing).toEqual({ policy: 'recommended', mode: 'active' });
  });
});
