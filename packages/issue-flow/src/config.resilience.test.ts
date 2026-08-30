import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GLOBAL_CONFIG_FILENAME,
  loadResilienceConfig,
  PROJECT_CONFIG_FILENAME,
  setResilienceCliOverrides,
} from './config.js';
import { resolvePolicy } from './resilience/policy.js';
import { resilienceConfigSchema } from './storage/schemas.js';

// Same seams the rest of config.test.ts fakes: the loader never has to discover
// a real repository to answer a question about a temporary directory.
vi.mock('./utils/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/git.js')>();
  return {
    ...actual,
    getRemoteUrl: vi.fn(async () => null),
    getProjectRoot: vi.fn(async () => process.cwd()),
  };
});

describe('the resilience configuration ladder', () => {
  let projectRoot: string;
  let globalRoot: string;
  const warn = vi.fn();

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'issue-flow-resilience-project-'));
    globalRoot = await mkdtemp(join(tmpdir(), 'issue-flow-resilience-global-'));
    warn.mockClear();
    setResilienceCliOverrides({});
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(globalRoot, { recursive: true, force: true });
    setResilienceCliOverrides({});
  });

  async function writeProjectConfig(content: unknown): Promise<void> {
    await writeFile(
      join(projectRoot, PROJECT_CONFIG_FILENAME),
      typeof content === 'string' ? content : JSON.stringify(content),
      'utf-8',
    );
  }

  async function writeGlobalConfig(content: unknown): Promise<void> {
    await writeFile(
      join(globalRoot, GLOBAL_CONFIG_FILENAME),
      typeof content === 'string' ? content : JSON.stringify(content),
      'utf-8',
    );
  }

  function load(env: NodeJS.ProcessEnv = {}) {
    return loadResilienceConfig({ projectRoot, globalRoot, env, warn });
  }

  /* ── absence is absence ───────────────────────────────────────────────── */

  describe('with nothing configured', () => {
    it('resolves to an empty object, not to a skeleton of empty sections', async () => {
      const config = await load();

      // The whole non-regression contract of this story in one assertion: an
      // unconfigured project hands `resolvePolicy()` the same `{}` every
      // release before the key existed effectively handed it.
      expect(config).toEqual({});
      expect(warn).not.toHaveBeenCalled();
    });

    it('leaves every FailureKind on the base table of the PRD', async () => {
      const config = await load();

      expect(resolvePolicy('network', config)).toEqual(resolvePolicy('network'));
      expect(resolvePolicy('rate_limit', config)).toEqual(resolvePolicy('rate_limit'));
      expect(resolvePolicy('task_execution', config)).toEqual(resolvePolicy('task_execution'));
    });

    it('ignores a .issue-flow.json that carries other keys only', async () => {
      await writeProjectConfig({ web: { port: 4100 }, issues: { preferredProvider: 'local' } });

      expect(await load()).toEqual({});
      expect(warn).not.toHaveBeenCalled();
    });
  });

  /* ── the ladder ───────────────────────────────────────────────────────── */

  describe('precedence', () => {
    it('reads config.json, the lowest explicit rung', async () => {
      await writeGlobalConfig({ resilience: { profile: 'continuous' } });

      expect(await load()).toEqual({ profile: 'continuous' });
    });

    it('lets .issue-flow.json beat config.json', async () => {
      await writeGlobalConfig({ resilience: { profile: 'continuous' } });
      await writeProjectConfig({ resilience: { profile: 'default' } });

      expect((await load()).profile).toBe('default');
    });

    it('lets the environment beat .issue-flow.json', async () => {
      await writeProjectConfig({ resilience: { profile: 'default' } });

      const config = await load({ ISSUE_FLOW_RESILIENCE_PROFILE: 'continuous' });

      expect(config.profile).toBe('continuous');
    });

    it('lets the CLI beat the environment', async () => {
      const config = await loadResilienceConfig({
        projectRoot,
        globalRoot,
        env: { ISSUE_FLOW_RESILIENCE_PROFILE: 'continuous' },
        cli: { profile: 'default' },
        warn,
      });

      expect(config.profile).toBe('default');
    });

    it('uses the overrides installed by setResilienceCliOverrides when no cli layer is passed', async () => {
      setResilienceCliOverrides({ queue: { onIssueFailure: 'skip' } });

      expect((await load()).queue).toEqual({ onIssueFailure: 'skip' });
    });

    it('never lets a rung erase a key the rung below it set', async () => {
      await writeGlobalConfig({ resilience: { journal: { enabled: true, maxFileBytes: 1024 } } });
      await writeProjectConfig({ resilience: { journal: { maxFileBytes: 2048 } } });

      expect((await load()).journal).toEqual({ enabled: true, maxFileBytes: 2048 });
    });
  });

  /* ── the retry table ──────────────────────────────────────────────────── */

  describe('the retry table', () => {
    it('merges field by field inside one kind, across rungs', async () => {
      await writeGlobalConfig({
        resilience: { retry: { network: { retryForever: true, maxDelayMs: 60_000 } } },
      });
      await writeProjectConfig({ resilience: { retry: { network: { maxDelayMs: 120_000 } } } });

      const config = await load();

      expect(config.retry?.network).toEqual({ retryForever: true, maxDelayMs: 120_000 });
    });

    it('leaves the kinds nobody configured absent', async () => {
      await writeProjectConfig({ resilience: { retry: { network: { maxAttempts: 3 } } } });

      const config = await load();

      expect(Object.keys(config.retry ?? {})).toEqual(['network']);
    });

    it('reaches resolvePolicy(), which still clamps the golden rule', async () => {
      await writeProjectConfig({
        resilience: {
          retry: {
            network: { maxAttempts: 12 },
            // A user asking for the one thing the layer must never grant.
            taskExecution: { maxAttempts: 99, retryForever: true },
          },
        },
      });

      const config = await load();

      expect(resolvePolicy('network', config).maxAttempts).toBe(12);
      expect(resolvePolicy('task_execution', config).maxAttempts).toBe(0);
      expect(resolvePolicy('task_execution', config).retryForever).toBe(false);
    });

    it('travels whole as JSON through ISSUE_FLOW_RESILIENCE_RETRY', async () => {
      const config = await load({
        ISSUE_FLOW_RESILIENCE_RETRY: JSON.stringify({ rateLimit: { retryForever: true } }),
      });

      expect(config.retry?.rateLimit).toEqual({ retryForever: true });
    });

    it('warns and drops an invalid ISSUE_FLOW_RESILIENCE_RETRY instead of throwing', async () => {
      const config = await load({ ISSUE_FLOW_RESILIENCE_RETRY: '{not json' });

      expect(config).toEqual({});
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ISSUE_FLOW_RESILIENCE_RETRY'));
    });
  });

  /* ── the other sections ───────────────────────────────────────────────── */

  describe('the sections consumed by later stories', () => {
    it('reads every sub-key of the PRD example', async () => {
      await writeProjectConfig({
        resilience: {
          profile: 'continuous',
          retry: {
            network: { retryForever: true, maxDelayMs: 120_000 },
            rateLimit: { retryForever: true, maxDelayMs: 900_000 },
            providerDown: { maxAttempts: 4, failover: 'after_attempts' },
          },
          providers: { failover: true, chain: ['claude', 'codex'], cooldownMs: 60_000 },
          queue: { onIssueFailure: 'skip', maxIssueAttempts: 3 },
          watchdog: { inactivityTimeoutMs: 600_000 },
          journal: { enabled: true, maxFileBytes: 10_485_760 },
          decompose: { auto: false },
        },
      });

      const config = await load();

      expect(config.providers).toEqual({
        failover: true,
        chain: ['claude', 'codex'],
        cooldownMs: 60_000,
      });
      expect(config.queue).toEqual({ onIssueFailure: 'skip', maxIssueAttempts: 3 });
      expect(config.watchdog).toEqual({ inactivityTimeoutMs: 600_000 });
      expect(config.journal).toEqual({ enabled: true, maxFileBytes: 10_485_760 });
      expect(config.decompose).toEqual({ auto: false });
      expect(config.retry?.providerDown).toEqual({ maxAttempts: 4, failover: 'after_attempts' });
    });

    it('maps every ISSUE_FLOW_RESILIENCE_* variable', async () => {
      const config = await load({
        ISSUE_FLOW_RESILIENCE_PROFILE: 'continuous',
        ISSUE_FLOW_RESILIENCE_FAILOVER_ON_AUTH: 'true',
        ISSUE_FLOW_RESILIENCE_FAILOVER: '0',
        ISSUE_FLOW_RESILIENCE_PROVIDER_CHAIN: 'claude, codex ,',
        ISSUE_FLOW_RESILIENCE_PROVIDER_COOLDOWN_MS: '60000',
        ISSUE_FLOW_RESILIENCE_ON_ISSUE_FAILURE: 'skip',
        ISSUE_FLOW_RESILIENCE_MAX_ISSUE_ATTEMPTS: '3',
        ISSUE_FLOW_RESILIENCE_INACTIVITY_TIMEOUT_MS: '600000',
        ISSUE_FLOW_RESILIENCE_JOURNAL: 'yes',
        ISSUE_FLOW_RESILIENCE_JOURNAL_MAX_BYTES: '2048',
        ISSUE_FLOW_RESILIENCE_AUTO_DECOMPOSE: 'off',
      });

      expect(config).toEqual({
        profile: 'continuous',
        failoverOnAuth: true,
        providers: { failover: false, chain: ['claude', 'codex'], cooldownMs: 60_000 },
        queue: { onIssueFailure: 'skip', maxIssueAttempts: 3 },
        watchdog: { inactivityTimeoutMs: 600_000 },
        journal: { enabled: true, maxFileBytes: 2048 },
        decompose: { auto: false },
      });
    });

    it('honours failoverOnAuth only when it is explicitly set', async () => {
      await writeProjectConfig({
        resilience: {
          failoverOnAuth: true,
          retry: { authentication: { failover: 'immediate' } },
        },
      });

      const config = await load();

      expect(resolvePolicy('authentication', config).failover).toBe('immediate');
      expect(resolvePolicy('authentication', {}).failover).toBe('never');
    });
  });

  /* ── degradation ──────────────────────────────────────────────────────── */

  describe('malformed input', () => {
    it('warns and drops an invalid project layer without touching the others', async () => {
      await writeGlobalConfig({ resilience: { profile: 'continuous' } });
      await writeProjectConfig({ resilience: { queue: { onIssueFailure: 'explode' } } });

      const config = await load();

      expect(config).toEqual({ profile: 'continuous' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(PROJECT_CONFIG_FILENAME));
    });

    it('drops an invalid environment layer with a warning', async () => {
      const config = await load({ ISSUE_FLOW_RESILIENCE_PROFILE: 'aggressive' });

      expect(config).toEqual({});
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('ISSUE_FLOW_RESILIENCE_* environment'),
      );
    });

    it('degrades an unreadable .issue-flow.json to "nothing configured"', async () => {
      await writeProjectConfig('{ not json');

      expect(await load()).toEqual({});
      expect(warn).toHaveBeenCalled();
    });
  });
});

describe('resilienceConfigSchema', () => {
  it('is not strict: a file written by a newer release stays readable', () => {
    const parsed = resilienceConfigSchema.parse({
      profile: 'continuous',
      somethingFromTheFuture: { enabled: true },
    });

    expect(parsed).toEqual({ profile: 'continuous' });
  });

  it('materializes no default, so it can sit in an intermediate rung', () => {
    expect(resilienceConfigSchema.parse({})).toEqual({});
    expect(resilienceConfigSchema.parse({ journal: {} })).toEqual({ journal: {} });
    expect(resilienceConfigSchema.parse({ retry: { network: {} } })).toEqual({
      retry: { network: {} },
    });
  });

  it('accepts every retry field a RetryPolicy carries', () => {
    const entry = {
      maxAttempts: 4,
      initialDelayMs: 1000,
      maxDelayMs: 60_000,
      backoffFactor: 2,
      jitter: 'full',
      retryForever: true,
      failover: 'after_attempts',
      failoverAfterAttempts: 2,
      onExhausted: 'block',
    };

    expect(resilienceConfigSchema.parse({ retry: { network: entry } })).toEqual({
      retry: { network: entry },
    });
  });

  it('rejects a backoff factor that would shrink the delay', () => {
    expect(
      resilienceConfigSchema.safeParse({ retry: { network: { backoffFactor: 0.5 } } }).success,
    ).toBe(false);
  });
});
