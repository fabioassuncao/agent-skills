import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createConfig,
  GLOBAL_CONFIG_FILENAME,
  loadGlobalConfig,
  loadIssuesConfig,
  loadPrReviewConfig,
  loadWebConfig,
  mergeConfigLayers,
  PROJECT_CONFIG_FILENAME,
  resolvePaths,
  setIssuesCliOverrides,
  setWebCliOverrides,
  WEB_CONFIG_FILENAME,
} from './config.js';
import { GLOBAL_ROOT_ENV, getIssuePaths, projectIdFromRemote } from './storage/paths.js';
import { resetStorageResolutionCache } from './storage/resolve.js';
import { getProjectRoot, getRemoteUrl, normalizeRemoteUrl } from './utils/git.js';

// Only the git seams are faked, so the real project id derivation and the real
// migration keep running against the temporary trees these tests build.
vi.mock('./utils/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/git.js')>();
  return {
    ...actual,
    getRemoteUrl: vi.fn(async () => null),
    getProjectRoot: vi.fn(async () => process.cwd()),
  };
});

describe('loadWebConfig', () => {
  let projectRoot: string;
  const warn = vi.fn();

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'issue-flow-web-config-'));
    warn.mockClear();
    setWebCliOverrides({});
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function writeConfigFile(content: unknown): Promise<void> {
    const raw = typeof content === 'string' ? content : JSON.stringify(content);
    await writeFile(join(projectRoot, WEB_CONFIG_FILENAME), raw, 'utf-8');
  }

  it('returns the documented defaults when no source is present', async () => {
    const config = await loadWebConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config).toEqual({
      enabled: false,
      port: 3737,
      host: '0.0.0.0',
      refreshSeconds: 5,
      logLimit: 200,
      includeLogs: true,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('applies the web key of .issue-flow.json over the defaults', async () => {
    await writeConfigFile({
      web: { enabled: true, port: 4000, host: '0.0.0.0', refreshSeconds: 10, includeLogs: false },
    });

    const config = await loadWebConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config.enabled).toBe(true);
    expect(config.port).toBe(4000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.refreshSeconds).toBe(10);
    expect(config.includeLogs).toBe(false);
    expect(config.logLimit).toBe(200); // untouched key keeps its default
    expect(warn).not.toHaveBeenCalled();
  });

  it('lets environment variables override the config file', async () => {
    await writeConfigFile({ web: { enabled: false, port: 4000, host: 'file-host' } });

    const config = await loadWebConfig({
      cli: {},
      env: {
        ISSUE_FLOW_WEB: '1',
        ISSUE_FLOW_WEB_PORT: '5001',
        ISSUE_FLOW_WEB_HOST: 'env-host',
        ISSUE_FLOW_WEB_REFRESH: '30',
        ISSUE_FLOW_WEB_LOG_LIMIT: '50',
      },
      projectRoot,
      warn,
    });

    expect(config.enabled).toBe(true);
    expect(config.port).toBe(5001);
    expect(config.host).toBe('env-host');
    expect(config.refreshSeconds).toBe(30);
    expect(config.logLimit).toBe(50);
  });

  it('lets CLI flags override environment variables and the file', async () => {
    await writeConfigFile({ web: { port: 4000 } });

    const config = await loadWebConfig({
      cli: { enabled: true, port: 6001, host: 'cli-host', includeLogs: false },
      env: { ISSUE_FLOW_WEB: '0', ISSUE_FLOW_WEB_PORT: '5001', ISSUE_FLOW_WEB_HOST: 'env-host' },
      projectRoot,
      warn,
    });

    expect(config.enabled).toBe(true);
    expect(config.port).toBe(6001);
    expect(config.host).toBe('cli-host');
    expect(config.includeLogs).toBe(false);
  });

  it('consumes overrides registered via setWebCliOverrides by default', async () => {
    setWebCliOverrides({ enabled: true, refreshSeconds: 3 });

    const config = await loadWebConfig({ env: {}, projectRoot, warn });

    expect(config.enabled).toBe(true);
    expect(config.refreshSeconds).toBe(3);
  });

  it('parses truthy and falsy values of ISSUE_FLOW_WEB', async () => {
    for (const value of ['1', 'true', 'yes', 'on', 'anything']) {
      const config = await loadWebConfig({
        cli: {},
        env: { ISSUE_FLOW_WEB: value },
        projectRoot,
        warn,
      });
      expect(config.enabled).toBe(true);
    }
    for (const value of ['', '0', 'false', 'no', 'off', 'FALSE']) {
      const config = await loadWebConfig({
        cli: {},
        env: { ISSUE_FLOW_WEB: value },
        projectRoot,
        warn,
      });
      expect(config.enabled).toBe(false);
    }
  });

  it('ignores a non-numeric env var with a warning, keeping the other sources', async () => {
    await writeConfigFile({ web: { port: 4000 } });

    const config = await loadWebConfig({
      cli: {},
      env: { ISSUE_FLOW_WEB_PORT: 'abc' },
      projectRoot,
      warn,
    });

    expect(config.port).toBe(4000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ISSUE_FLOW_WEB_PORT'));
  });

  it('falls back to defaults with a warning when the file is invalid JSON', async () => {
    await writeConfigFile('{ not json');

    const config = await loadWebConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config.enabled).toBe(false);
    expect(config.port).toBe(3737);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(WEB_CONFIG_FILENAME));
  });

  it('ignores an invalid web key with a warning, without failing', async () => {
    await writeConfigFile({ web: { port: 'not-a-number' } });

    const config = await loadWebConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config.port).toBe(3737);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(WEB_CONFIG_FILENAME));
  });

  it('accepts a file without the web key silently', async () => {
    await writeConfigFile({ otherTool: { setting: true } });

    const config = await loadWebConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config.enabled).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to defaults with a warning when the merged result is invalid', async () => {
    const config = await loadWebConfig({ cli: { port: 0 }, env: {}, projectRoot, warn });

    expect(config.port).toBe(3737);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('web monitoring configuration'));
  });
});

describe('loadIssuesConfig', () => {
  let projectRoot: string;
  const warn = vi.fn();

  const DEFAULT_ISSUES_CONFIG = {
    defaultGenerateTarget: 'github',
    preferredProvider: 'github',
    conflictPolicy: 'ask',
    requireConfirmation: true,
  } as const;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'issue-flow-issues-config-'));
    warn.mockClear();
    setIssuesCliOverrides({});
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function writeConfigFile(content: unknown): Promise<void> {
    const raw = typeof content === 'string' ? content : JSON.stringify(content);
    await writeFile(join(projectRoot, PROJECT_CONFIG_FILENAME), raw, 'utf-8');
  }

  it('returns the GitHub-only defaults when no source is present', async () => {
    const config = await loadIssuesConfig({ cli: {}, projectRoot, warn });

    expect(config).toEqual(DEFAULT_ISSUES_CONFIG);
    expect(warn).not.toHaveBeenCalled();
  });

  it('applies the issues key of .issue-flow.json over the defaults', async () => {
    await writeConfigFile({
      issues: { preferredProvider: 'local', conflictPolicy: 'prefer-local' },
    });

    const config = await loadIssuesConfig({ cli: {}, projectRoot, warn });

    expect(config.preferredProvider).toBe('local');
    expect(config.conflictPolicy).toBe('prefer-local');
    expect(config.defaultGenerateTarget).toBe('github'); // untouched key keeps its default
    expect(config.requireConfirmation).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('lets CLI flags override the config file', async () => {
    await writeConfigFile({
      issues: {
        preferredProvider: 'local',
        conflictPolicy: 'prefer-local',
        defaultGenerateTarget: 'local',
      },
    });

    const config = await loadIssuesConfig({
      cli: { preferredProvider: 'github', conflictPolicy: 'ask' },
      projectRoot,
      warn,
    });

    expect(config.preferredProvider).toBe('github');
    expect(config.conflictPolicy).toBe('ask');
    expect(config.defaultGenerateTarget).toBe('local'); // file still wins over the default
  });

  it('consumes overrides registered via setIssuesCliOverrides by default', async () => {
    setIssuesCliOverrides({ preferredProvider: 'local', conflictPolicy: 'prefer-local' });

    const config = await loadIssuesConfig({ projectRoot, warn });

    expect(config.preferredProvider).toBe('local');
    expect(config.conflictPolicy).toBe('prefer-local');
  });

  it('accepts every documented generate target', async () => {
    for (const target of ['github', 'local', 'both'] as const) {
      await writeConfigFile({ issues: { defaultGenerateTarget: target } });

      const config = await loadIssuesConfig({ cli: {}, projectRoot, warn });

      expect(config.defaultGenerateTarget).toBe(target);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to defaults with a warning when the file is invalid JSON', async () => {
    await writeConfigFile('{ not json');

    const config = await loadIssuesConfig({ cli: {}, projectRoot, warn });

    expect(config).toEqual(DEFAULT_ISSUES_CONFIG);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(PROJECT_CONFIG_FILENAME));
  });

  it('falls back to defaults with a warning when the file root is not an object', async () => {
    await writeConfigFile('[1, 2, 3]');

    const config = await loadIssuesConfig({ cli: {}, projectRoot, warn });

    expect(config).toEqual(DEFAULT_ISSUES_CONFIG);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('expected a JSON object'));
  });

  it('ignores an invalid issues key with a warning, without throwing', async () => {
    await writeConfigFile({ issues: { conflictPolicy: 'whatever' } });

    const config = await loadIssuesConfig({ cli: {}, projectRoot, warn });

    expect(config).toEqual(DEFAULT_ISSUES_CONFIG);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"issues" key'));
  });

  it('accepts a file without the issues key silently', async () => {
    await writeConfigFile({ web: { enabled: true } });

    const config = await loadIssuesConfig({ cli: {}, projectRoot, warn });

    expect(config).toEqual(DEFAULT_ISSUES_CONFIG);
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to defaults with a warning when the merged result is invalid', async () => {
    const config = await loadIssuesConfig({
      cli: { preferredProvider: 'gitlab' as never },
      projectRoot,
      warn,
    });

    expect(config).toEqual(DEFAULT_ISSUES_CONFIG);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Issue provider configuration'));
  });

  it('does not read the web key into the issues config', async () => {
    await writeConfigFile({ web: { enabled: true, port: 4000 }, issues: {} });

    const config = await loadIssuesConfig({ cli: {}, projectRoot, warn });

    expect(config).toEqual(DEFAULT_ISSUES_CONFIG);
  });
});

describe('loadPrReviewConfig', () => {
  let projectRoot: string;
  const warn = vi.fn();

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'issue-flow-pr-review-config-'));
    warn.mockClear();
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function writeConfigFile(content: unknown): Promise<void> {
    const raw = typeof content === 'string' ? content : JSON.stringify(content);
    await writeFile(join(projectRoot, PROJECT_CONFIG_FILENAME), raw, 'utf-8');
  }

  it('returns the local publisher when the key is absent', async () => {
    await writeConfigFile({ web: { enabled: true } });

    const config = await loadPrReviewConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config).toEqual({ publisher: 'local' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns the local publisher when no config file exists at all', async () => {
    const config = await loadPrReviewConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config).toEqual({ publisher: 'local' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts the documented publisher value', async () => {
    await writeConfigFile({ prReview: { publisher: 'local' } });

    const config = await loadPrReviewConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config).toEqual({ publisher: 'local' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('degrades to the default with a warning on an unknown publisher', async () => {
    await writeConfigFile({ prReview: { publisher: 'github' } });

    const config = await loadPrReviewConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config).toEqual({ publisher: 'local' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"prReview" key'));
  });

  it('degrades to the default with a warning when the key is not an object', async () => {
    await writeConfigFile({ prReview: 'local' });

    const config = await loadPrReviewConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config).toEqual({ publisher: 'local' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"prReview" key'));
  });

  it('degrades to the default with a warning when the file is invalid JSON', async () => {
    await writeConfigFile('{ not json');

    const config = await loadPrReviewConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config).toEqual({ publisher: 'local' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(PROJECT_CONFIG_FILENAME));
  });

  it('lets the environment override the config file', async () => {
    await writeConfigFile({ prReview: { publisher: 'local' } });

    const config = await loadPrReviewConfig({
      cli: {},
      env: { ISSUE_FLOW_PR_REVIEW_PUBLISHER: 'local' },
      projectRoot,
      warn,
    });

    expect(config).toEqual({ publisher: 'local' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('degrades to the default with a warning on an invalid environment value', async () => {
    const config = await loadPrReviewConfig({
      cli: {},
      env: { ISSUE_FLOW_PR_REVIEW_PUBLISHER: 'gitlab' },
      projectRoot,
      warn,
    });

    expect(config).toEqual({ publisher: 'local' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PR review configuration'));
  });

  it('degrades to the default with a warning on an invalid CLI override', async () => {
    const config = await loadPrReviewConfig({
      cli: { publisher: 'github' as never },
      env: {},
      projectRoot,
      warn,
    });

    expect(config).toEqual({ publisher: 'local' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PR review configuration'));
  });

  it('does not read the web or issues keys into the pr review config', async () => {
    await writeConfigFile({ web: { enabled: true }, issues: { preferredProvider: 'local' } });

    const config = await loadPrReviewConfig({ cli: {}, env: {}, projectRoot, warn });

    expect(config).toEqual({ publisher: 'local' });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('loadGlobalConfig', () => {
  let globalRoot: string;
  const warn = vi.fn();

  beforeEach(async () => {
    globalRoot = await mkdtemp(join(tmpdir(), 'issue-flow-global-config-'));
    warn.mockClear();
  });

  afterEach(async () => {
    await rm(globalRoot, { recursive: true, force: true });
  });

  async function writeGlobalConfig(content: unknown): Promise<void> {
    const raw = typeof content === 'string' ? content : JSON.stringify(content);
    await writeFile(join(globalRoot, GLOBAL_CONFIG_FILENAME), raw, 'utf-8');
  }

  it('returns an empty object without warning when the file is absent', async () => {
    const config = await loadGlobalConfig({ globalRoot, warn });

    expect(config).toEqual({});
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads every supported key of a valid file', async () => {
    await writeGlobalConfig({
      schemaVersion: 1,
      storageDir: '/srv/issue-flow',
      web: { port: 4100, host: 'global-host', refreshSeconds: 20, logLimit: 42 },
      retry: { retryLimit: 3, retryForever: false, backoffBaseSeconds: 5, backoffMaxSeconds: 60 },
      commit: { signoff: true, conventional: false },
    });

    const config = await loadGlobalConfig({ globalRoot, warn });

    expect(config).toEqual({
      schemaVersion: 1,
      storageDir: '/srv/issue-flow',
      web: { port: 4100, host: 'global-host', refreshSeconds: 20, logLimit: 42 },
      retry: { retryLimit: 3, retryForever: false, backoffBaseSeconds: 5, backoffMaxSeconds: 60 },
      commit: { signoff: true, conventional: false },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('never materializes a default for a key the user did not write', async () => {
    await writeGlobalConfig({ web: { host: 'global-host' } });

    const config = await loadGlobalConfig({ globalRoot, warn });

    // Exact match: an extra `port` here would be a default leaking into an
    // intermediate precedence layer, which would override the project file.
    expect(config).toEqual({ web: { host: 'global-host' } });
  });

  it('resolves the file through ISSUE_FLOW_HOME when no globalRoot is given', async () => {
    await writeGlobalConfig({ storageDir: '/from-env' });

    const config = await loadGlobalConfig({ env: { [GLOBAL_ROOT_ENV]: globalRoot }, warn });

    expect(config).toEqual({ storageDir: '/from-env' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and returns an empty object on invalid JSON', async () => {
    await writeGlobalConfig('{ "web": ');

    const config = await loadGlobalConfig({ globalRoot, warn });

    expect(config).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid JSON'));
  });

  it.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a number', '42'],
    ['a string', '"nope"'],
  ])('warns and returns an empty object when the root is %s', async (_label, raw) => {
    await writeGlobalConfig(raw);

    const config = await loadGlobalConfig({ globalRoot, warn });

    expect(config).toEqual({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('expected a JSON object'));
  });

  it('drops only the invalid key and names it in the warning', async () => {
    await writeGlobalConfig({
      storageDir: '/srv/issue-flow',
      retry: { retryLimit: 'many' },
      commit: { signoff: true },
    });

    const config = await loadGlobalConfig({ globalRoot, warn });

    expect(config).toEqual({ storageDir: '/srv/issue-flow', commit: { signoff: true } });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"retry"'));
  });

  it('drops a nested key whose value violates the web constraints', async () => {
    await writeGlobalConfig({ web: { port: 70000 }, commit: { conventional: true } });

    const config = await loadGlobalConfig({ globalRoot, warn });

    expect(config).toEqual({ commit: { conventional: true } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"web"'));
  });

  it('ignores an unknown key silently, keeping the file forward-compatible', async () => {
    await writeGlobalConfig({ storageDir: '/srv/issue-flow', futureKey: { anything: true } });

    const config = await loadGlobalConfig({ globalRoot, warn });

    expect(config).toEqual({ storageDir: '/srv/issue-flow' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and returns an empty object on an IO error', async () => {
    // A directory where the file is expected: readFile fails with EISDIR, the
    // stand-in for the permission errors we cannot reproduce portably.
    await mkdir(join(globalRoot, GLOBAL_CONFIG_FILENAME));

    const config = await loadGlobalConfig({ globalRoot, warn });

    expect(config).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(GLOBAL_CONFIG_FILENAME));
  });

  it('warns instead of throwing when the global root cannot be resolved', async () => {
    const config = await loadGlobalConfig({
      env: { [GLOBAL_ROOT_ENV]: '', HOME: '', USERPROFILE: '' },
      warn,
    });

    // The home directory is resolvable on any supported dev machine, so this
    // only asserts the call is total: a value, never a throw.
    expect(config).toEqual({});
  });

  it('keeps a project-level web.port when the global file omits it', async () => {
    await writeGlobalConfig({ web: { host: 'global-host', refreshSeconds: 20 } });

    const global = await loadGlobalConfig({ globalRoot, warn });
    const merged = mergeConfigLayers<{ port: number; host: string; refreshSeconds: number }>({
      global: global.web,
      project: { port: 4000 },
    });

    expect(merged).toEqual({ port: 4000, host: 'global-host', refreshSeconds: 20 });
  });
});

describe('mergeConfigLayers', () => {
  interface Sample {
    value: string;
    untouched: string;
  }

  it('returns an empty object when no layer is provided', () => {
    expect(mergeConfigLayers<Sample>({})).toEqual({});
  });

  it.each([
    ['global', 'defaults'],
    ['project', 'global'],
    ['env', 'project'],
    ['cli', 'env'],
  ] as const)('lets the %s layer override the %s layer', (winner, loser) => {
    const merged = mergeConfigLayers<Sample>({
      [loser]: { value: loser, untouched: loser },
      [winner]: { value: winner },
    });

    expect(merged).toEqual({ value: winner, untouched: loser });
  });

  it('applies the full precedence order CLI > env > project > global > defaults', () => {
    const merged = mergeConfigLayers<Record<string, string>>({
      defaults: { a: 'defaults', b: 'defaults', c: 'defaults', d: 'defaults', e: 'defaults' },
      global: { a: 'global', b: 'global', c: 'global', d: 'global' },
      project: { a: 'project', b: 'project', c: 'project' },
      env: { a: 'env', b: 'env' },
      cli: { a: 'cli' },
    });

    expect(merged).toEqual({
      a: 'cli',
      b: 'env',
      c: 'project',
      d: 'global',
      e: 'defaults',
    });
  });

  it('treats an explicit undefined as an absent key', () => {
    const merged = mergeConfigLayers<Sample>({
      defaults: { value: 'defaults' },
      cli: { value: undefined },
    });

    expect(merged).toEqual({ value: 'defaults' });
  });

  it('does not mutate the layers it receives', () => {
    const defaults = { value: 'defaults' };
    const cli = { value: 'cli' };

    mergeConfigLayers<Sample>({ defaults, cli });

    expect(defaults).toEqual({ value: 'defaults' });
    expect(cli).toEqual({ value: 'cli' });
  });
});

describe('resolvePaths', () => {
  const REMOTE = 'https://github.com/acme/widgets.git';

  let temps: string[] = [];
  let globalHome: string;
  let projectRoot: string;
  let previousHome: string | undefined;

  async function makeTemp(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    temps.push(dir);
    return dir;
  }

  beforeEach(async () => {
    globalHome = await makeTemp('issue-flow-resolve-paths-home-');
    projectRoot = await makeTemp('issue-flow-resolve-paths-repo-');

    // resolvePaths() reaches resolveIssuePaths() without an options object, so
    // the { env } seam never gets there: the real process.env is what keeps this
    // test off the user's ~/.issue-flow.
    previousHome = process.env[GLOBAL_ROOT_ENV];
    process.env[GLOBAL_ROOT_ENV] = globalHome;
    resetStorageResolutionCache();

    vi.mocked(getProjectRoot).mockClear().mockResolvedValue(projectRoot);
    vi.mocked(getRemoteUrl).mockClear().mockResolvedValue(REMOTE);
  });

  afterEach(async () => {
    if (previousHome === undefined) {
      delete process.env[GLOBAL_ROOT_ENV];
    } else {
      process.env[GLOBAL_ROOT_ENV] = previousHome;
    }
    resetStorageResolutionCache();
    await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
    temps = [];
  });

  /** What the storage layer says this issue's paths are, computed independently. */
  function expectedIssuePaths(issueNumber: string) {
    return getIssuePaths(
      projectIdFromRemote(normalizeRemoteUrl(REMOTE), projectRoot),
      issueNumber,
      {
        env: { [GLOBAL_ROOT_ENV]: globalHome },
      },
    );
  }

  it('anchors every issue artifact in the global storage', async () => {
    const expected = expectedIssuePaths('42');

    const paths = await resolvePaths(createConfig({ issueNumber: '42' }));

    expect(paths).toEqual({
      // The asymmetric mapping: the engine's "PRD" is the task plan.
      prdFile: expected.tasksFile,
      progressFile: expected.progressFile,
      archiveDir: expected.archiveDir,
      lastBranchFile: expected.lastBranchFile,
      projectRoot,
    });
    expect(paths.prdFile.endsWith('tasks.json')).toBe(true);
    expect(paths.prdFile.startsWith(globalHome)).toBe(true);
  });

  it('no longer points at <projectRoot>/issues/', async () => {
    const paths = await resolvePaths(createConfig({ issueNumber: '42' }));

    for (const path of [
      paths.prdFile,
      paths.progressFile,
      paths.archiveDir,
      paths.lastBranchFile,
    ]) {
      expect(path.startsWith(join(projectRoot, 'issues'))).toBe(false);
    }
  });

  it('migrates a legacy issue tree on first resolution and reads it from the global path', async () => {
    const legacyIssueDir = join(projectRoot, 'issues', '42');
    await mkdir(join(legacyIssueDir, 'archive'), { recursive: true });
    await writeFile(join(legacyIssueDir, 'tasks.json'), '{"project":"legacy"}', 'utf-8');
    await writeFile(join(legacyIssueDir, 'progress.txt'), 'legacy log\n', 'utf-8');
    await writeFile(join(legacyIssueDir, '.last-branch'), 'issue/42-old\n', 'utf-8');

    const paths = await resolvePaths(createConfig({ issueNumber: '42' }));

    await expect(readFile(paths.prdFile, 'utf-8')).resolves.toBe('{"project":"legacy"}');
    await expect(readFile(paths.progressFile, 'utf-8')).resolves.toBe('legacy log\n');
    await expect(readFile(paths.lastBranchFile, 'utf-8')).resolves.toBe('issue/42-old\n');
    // The legacy tree is read-only: the source survives the copy untouched.
    await expect(readFile(join(legacyIssueDir, 'tasks.json'), 'utf-8')).resolves.toBe(
      '{"project":"legacy"}',
    );
  });

  it('supports a non-numeric issue identifier', async () => {
    const expected = expectedIssuePaths('auth-refactor');

    const paths = await resolvePaths(createConfig({ issueNumber: 'auth-refactor' }));

    expect(paths.prdFile).toBe(expected.tasksFile);
  });

  it('resolves the same paths from a subdirectory of the repository', async () => {
    const fromRoot = await resolvePaths(createConfig({ issueNumber: '42' }));

    // getProjectRoot() already normalizes the cwd to the git toplevel, which is
    // what makes the result independent of where the command was invoked.
    resetStorageResolutionCache();
    const nested = join(projectRoot, 'packages', 'x');
    await mkdir(nested, { recursive: true });
    const fromSubdir = await resolvePaths(createConfig({ issueNumber: '42' }));

    expect(fromSubdir).toEqual(fromRoot);
  });

  it('leaves standalone mode anchored to the project root', async () => {
    const paths = await resolvePaths(createConfig({}));

    expect(paths).toEqual({
      prdFile: join(projectRoot, 'prd.json'),
      progressFile: join(projectRoot, 'progress.txt'),
      archiveDir: join(projectRoot, 'archive'),
      lastBranchFile: join(projectRoot, '.last-branch'),
      projectRoot,
    });
  });

  it('leaves standalone mode anchored to scriptDir when one is given', async () => {
    const scriptDir = await makeTemp('issue-flow-resolve-paths-script-');

    const paths = await resolvePaths(createConfig({}), scriptDir);

    expect(paths).toEqual({
      prdFile: join(scriptDir, 'prd.json'),
      progressFile: join(scriptDir, 'progress.txt'),
      archiveDir: join(scriptDir, 'archive'),
      lastBranchFile: join(scriptDir, '.last-branch'),
      projectRoot,
    });
  });

  it('resolves the project once per process: two calls share a single git lookup', async () => {
    await resolvePaths(createConfig({ issueNumber: '42' }));
    await resolvePaths(createConfig({ issueNumber: '43' }));

    expect(vi.mocked(getRemoteUrl)).toHaveBeenCalledTimes(1);
  });
});
