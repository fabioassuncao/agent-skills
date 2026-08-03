import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadIssuesConfig, PROJECT_CONFIG_FILENAME } from '../config.js';
import { IssueFlagError, resolveGenerateTarget, resolveIssuesOverrides } from './cli-flags.js';

describe('resolveGenerateTarget', () => {
  it('returns undefined when no destination flag was passed', () => {
    expect(resolveGenerateTarget({})).toBeUndefined();
  });

  it.each([
    ['github', { github: true }],
    ['local', { local: true }],
    ['both', { both: true }],
  ])('maps the flag to the %s destination', (expected, flags) => {
    expect(resolveGenerateTarget(flags)).toBe(expected);
  });

  it.each([
    [{ github: true, local: true }],
    [{ github: true, both: true }],
    [{ local: true, both: true }],
    [{ github: true, local: true, both: true }],
  ])('rejects combined destinations (%o)', (flags) => {
    expect(() => resolveGenerateTarget(flags)).toThrow(IssueFlagError);
    expect(() => resolveGenerateTarget(flags)).toThrow(/mutually exclusive/);
  });

  it('names the offending flags in the error message', () => {
    expect(() => resolveGenerateTarget({ local: true, both: true })).toThrow(/--local, --both/);
  });

  it('ignores flags that are present but false', () => {
    expect(resolveGenerateTarget({ github: false, local: false, both: true })).toBe('both');
  });
});

describe('resolveIssuesOverrides', () => {
  it('returns nothing when no Issue flag was passed', () => {
    expect(resolveIssuesOverrides({})).toEqual({});
  });

  it('maps --local to the local preferred provider', () => {
    expect(resolveIssuesOverrides({ local: true })).toEqual({ preferredProvider: 'local' });
  });

  it('maps --github to the GitHub preferred provider', () => {
    expect(resolveIssuesOverrides({ github: true })).toEqual({ preferredProvider: 'github' });
  });

  it('rejects --local combined with --github', () => {
    expect(() => resolveIssuesOverrides({ local: true, github: true })).toThrow(IssueFlagError);
    expect(() => resolveIssuesOverrides({ local: true, github: true })).toThrow(
      '--local and --github are mutually exclusive; pass only one.',
    );
  });

  it.each([
    ['preferLocal', 'prefer-local'],
    ['preferGithub', 'prefer-github'],
    ['ask', 'ask'],
  ] as const)('maps the %s flag to the %s conflict policy', (flag, policy) => {
    expect(resolveIssuesOverrides({ [flag]: true })).toEqual({ conflictPolicy: policy });
  });

  it('rejects two conflict policies at once', () => {
    expect(() => resolveIssuesOverrides({ preferLocal: true, ask: true })).toThrow(
      '--prefer-local, --ask are mutually exclusive; pass only one conflict policy.',
    );
  });

  it('combines a preferred provider with a conflict policy', () => {
    expect(resolveIssuesOverrides({ local: true, preferGithub: true })).toEqual({
      preferredProvider: 'local',
      conflictPolicy: 'prefer-github',
    });
  });
});

describe('flag precedence over .issue-flow.json', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'issue-flow-flags-'));
    await writeFile(
      join(projectRoot, PROJECT_CONFIG_FILENAME),
      JSON.stringify({ issues: { preferredProvider: 'github', conflictPolicy: 'prefer-github' } }),
      'utf-8',
    );
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('lets the file win when no flag is passed', async () => {
    const config = await loadIssuesConfig({
      cli: resolveIssuesOverrides({}),
      projectRoot,
      warn: () => {},
    });

    expect(config.preferredProvider).toBe('github');
    expect(config.conflictPolicy).toBe('prefer-github');
  });

  it('lets the flags override the file, key by key', async () => {
    const config = await loadIssuesConfig({
      cli: resolveIssuesOverrides({ local: true }),
      projectRoot,
      warn: () => {},
    });

    expect(config.preferredProvider).toBe('local');
    // Untouched by the flag, so the file value survives.
    expect(config.conflictPolicy).toBe('prefer-github');
  });
});
