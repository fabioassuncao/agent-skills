import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetStorageResolutionCache } from '../storage/resolve.js';
import { runAgent, writeAgentPreference } from './agent.js';

vi.mock('execa', () => ({
  execa: vi.fn(async (file: string) => {
    if (file === 'claude') return { exitCode: 0, stdout: '2.1.251' };
    if (file === 'codex') return { exitCode: 1, stdout: '' };
    return { exitCode: 1, stdout: '' };
  }),
}));

describe('issue-flow agent', () => {
  const logs: string[] = [];

  beforeEach(() => {
    logs.length = 0;
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    resetStorageResolutionCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits versioned JSON with the eight phases', async () => {
    expect(await runAgent({ json: true })).toBe(0);
    const payload = JSON.parse(logs.join('\n')) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(1);
    expect(payload).toMatchObject({
      default: { provider: 'claude', model: null },
    });
    const phases = payload.phases as Record<string, { provider: string }>;
    expect(Object.keys(phases)).toEqual([
      'analyze',
      'generate',
      'prd',
      'plan',
      'execute',
      'review',
      'pr',
      'pr-review',
    ]);
    expect(Array.isArray(payload.availability)).toBe(true);
  });

  it('writes agent use --global without touching other keys', async () => {
    const home = process.env.ISSUE_FLOW_HOME;
    if (!home) throw new Error('ISSUE_FLOW_HOME must be set by test-setup');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.json'), JSON.stringify({ web: { port: 9999 } }));

    const path = await writeAgentPreference({
      target: 'global',
      provider: 'codex',
      model: 'gpt-5.6',
    });
    const written = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
    expect(written.web).toEqual({ port: 9999 });
    expect(written.agent).toEqual({ provider: 'codex', model: 'gpt-5.6' });
  });

  it('writes a phase override without replacing the default provider', async () => {
    const home = process.env.ISSUE_FLOW_HOME;
    if (!home) throw new Error('ISSUE_FLOW_HOME must be set by test-setup');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'config.json'), JSON.stringify({ agent: { provider: 'claude' } }));

    const path = await writeAgentPreference({
      target: 'global',
      provider: 'codex',
      phase: 'execute',
    });
    const written = JSON.parse(await readFile(path, 'utf-8')) as {
      agent: { provider: string; phases: { execute: { provider: string } } };
    };
    expect(written.agent.provider).toBe('claude');
    expect(written.agent.phases.execute.provider).toBe('codex');
  });
});
