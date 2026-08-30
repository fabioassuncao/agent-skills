import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRoutingConfig, PROJECT_CONFIG_FILENAME } from './config.js';

describe('the routing configuration ladder', () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('keeps shadow and no policy as the factory default', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'issue-flow-routing-project-'));
    const globalRoot = await mkdtemp(join(tmpdir(), 'issue-flow-routing-global-'));
    roots.push(projectRoot, globalRoot);
    const config = await loadRoutingConfig({ projectRoot, globalRoot, cli: {}, warn: vi.fn() });
    expect(config.mode).toBe('shadow');
    expect(config.profile).toBe('balanced');
    expect(config.policy).toBeUndefined();
  });

  it('resolves default then global then project then CLI per key', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'issue-flow-routing-project-'));
    const globalRoot = await mkdtemp(join(tmpdir(), 'issue-flow-routing-global-'));
    roots.push(projectRoot, globalRoot);
    await writeFile(
      join(globalRoot, 'config.json'),
      JSON.stringify({
        routing: {
          mode: 'recommend',
          profile: 'economy',
          policy: 'recommended',
          escalation: { enabled: true },
        },
      }),
    );
    await writeFile(
      join(projectRoot, PROJECT_CONFIG_FILENAME),
      JSON.stringify({ routing: { profile: 'quality', escalation: { maxEscalations: 5 } } }),
    );

    const config = await loadRoutingConfig({
      projectRoot,
      globalRoot,
      cli: { mode: 'active' },
      warn: vi.fn(),
    });
    expect(config).toMatchObject({
      mode: 'active',
      profile: 'quality',
      policy: 'recommended',
      escalation: { enabled: true, maxEscalations: 5 },
    });
  });

  it('ignores an invalid project layer without erasing a valid global layer', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'issue-flow-routing-project-'));
    const globalRoot = await mkdtemp(join(tmpdir(), 'issue-flow-routing-global-'));
    roots.push(projectRoot, globalRoot);
    await writeFile(
      join(globalRoot, 'config.json'),
      JSON.stringify({ routing: { mode: 'recommend' } }),
    );
    await writeFile(
      join(projectRoot, PROJECT_CONFIG_FILENAME),
      JSON.stringify({ routing: { mode: 'impossible' } }),
    );
    const warn = vi.fn();
    const config = await loadRoutingConfig({ projectRoot, globalRoot, cli: {}, warn });
    expect(config.mode).toBe('recommend');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('routing'));
  });
});
