import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAgentConfig, setAgentCliOverrides } from '../config.js';
import { resetStorageResolutionCache } from '../storage/resolve.js';
import { parseAgentPhaseFlag, resolveAgentFor } from './resolve.js';

const warn = (): void => undefined;

describe('parseAgentPhaseFlag', () => {
  it('parses --agent-phase review=claude:claude-sonnet-5', () => {
    expect(parseAgentPhaseFlag('review=claude:claude-sonnet-5')).toEqual({
      phase: 'review',
      block: { provider: 'claude', model: 'claude-sonnet-5' },
    });
  });

  it('rejects an unknown phase or provider', () => {
    expect(() => parseAgentPhaseFlag('research=claude')).toThrow(/Unknown agent phase/);
    expect(() => parseAgentPhaseFlag('review=cursor')).toThrow(/Unknown agent provider/);
  });
});

describe('loadAgentConfig / resolveAgentFor', () => {
  afterEach(() => {
    setAgentCliOverrides({});
    resetStorageResolutionCache();
  });

  it('resolves claude for every phase when nothing is configured', async () => {
    const config = await loadAgentConfig({
      cli: {},
      env: {},
      projectRoot: '/tmp/issue-flow-no-such-project',
      globalRoot: '/tmp/issue-flow-no-such-global',
      warn,
    });
    expect(config.provider).toBe('claude');
    expect(config.model).toBeNull();
    expect(config.phases).toEqual({});

    for (const phase of ['analyze', 'execute', 'review'] as const) {
      const resolved = await resolveAgentFor(phase, { config });
      expect(resolved.provider).toBe('claude');
      expect(resolved.model).toBeNull();
    }
  });

  it('does not let a project phases map erase a global one', async () => {
    const home = join(process.env.ISSUE_FLOW_HOME ?? '/tmp', 'agent-merge');
    const globalRoot = join(home, 'global');
    const projectRoot = join(home, 'project');
    await mkdir(globalRoot, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(globalRoot, 'config.json'),
      JSON.stringify({
        agent: {
          phases: {
            review: { model: 'claude-sonnet-5' },
            plan: { provider: 'codex' },
          },
        },
      }),
    );
    await writeFile(
      join(projectRoot, '.issue-flow.json'),
      JSON.stringify({
        agent: {
          phases: {
            execute: { provider: 'codex', model: 'gpt-5.6' },
          },
        },
      }),
    );

    const config = await loadAgentConfig({ cli: {}, env: {}, projectRoot, globalRoot, warn });
    expect(config.phases.review?.model).toBe('claude-sonnet-5');
    expect(config.phases.plan?.provider).toBe('codex');
    expect(config.phases.execute?.provider).toBe('codex');
    expect(config.phases.execute?.model).toBe('gpt-5.6');
  });

  it('keeps the provider when a phase declares only a model', async () => {
    const config = await loadAgentConfig({
      cli: {},
      env: {},
      projectRoot: '/tmp/issue-flow-no-such-project',
      globalRoot: '/tmp/issue-flow-no-such-global',
      warn,
    });
    config.provider = 'claude';
    config.phases.review = { model: 'claude-sonnet-5' };
    const resolved = await resolveAgentFor('review', { config });
    expect(resolved.provider).toBe('claude');
    expect(resolved.model).toBe('claude-sonnet-5');
  });

  it('lets --agent overwrite every phase', async () => {
    const resolved = await resolveAgentFor('plan', {
      config: {
        provider: 'codex',
        model: 'gpt-5.6',
        claude: {},
        codex: {},
        phases: { plan: { provider: 'codex' } },
      },
      cli: { forceProvider: 'claude' },
    });
    expect(resolved.provider).toBe('claude');
    expect(resolved.origin.provider).toBe('cli');
  });

  it('applies --agent-phase only to the named phase', async () => {
    const cli = {
      phases: { review: { provider: 'claude' as const, model: 'claude-sonnet-5' } },
    };
    const config = {
      provider: 'codex' as const,
      model: null,
      claude: {},
      codex: {},
      phases: {},
    };
    const review = await resolveAgentFor('review', { config, cli });
    const plan = await resolveAgentFor('plan', { config, cli });
    expect(review.provider).toBe('claude');
    expect(review.model).toBe('claude-sonnet-5');
    expect(plan.provider).toBe('codex');
  });

  it('ignores unknown phase keys with a warning', async () => {
    const warnings: string[] = [];
    const home = join(process.env.ISSUE_FLOW_HOME ?? '/tmp', 'agent-unknown');
    const projectRoot = join(home, 'project');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      join(projectRoot, '.issue-flow.json'),
      JSON.stringify({
        agent: { phases: { research: { provider: 'codex' }, plan: { provider: 'codex' } } },
      }),
    );
    const config = await loadAgentConfig({
      cli: {},
      env: {},
      projectRoot,
      globalRoot: join(home, 'global'),
      warn: (m) => warnings.push(m),
    });
    expect(config.phases.plan?.provider).toBe('codex');
    expect(config.phases).not.toHaveProperty('research');
    expect(warnings.some((w) => w.includes('research'))).toBe(true);
  });

  it('leaves agent.codex inert when the provider is claude', async () => {
    const resolved = await resolveAgentFor('execute', {
      config: {
        provider: 'claude',
        model: null,
        claude: {},
        codex: { sandbox: 'danger-full-access' },
        phases: {},
      },
    });
    expect(resolved.provider).toBe('claude');
    expect(resolved.codex.sandbox).toBe('danger-full-access');
  });
});
