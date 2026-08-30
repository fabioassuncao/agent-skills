import { describe, expect, it } from 'vitest';
import { webConfigSchema } from '../schemas.js';
import {
  type GlobalConfig,
  globalConfigSchema,
  type ProjectMetadata,
  projectMetadataSchema,
  STORAGE_SCHEMA_VERSION,
} from './schemas.js';

const validMetadata: ProjectMetadata = {
  schemaVersion: STORAGE_SCHEMA_VERSION,
  projectId: 'issue-flow-a1b2c3d4e5f6',
  root: '/Users/dev/Projects/issue-flow',
  remoteUrl: 'github.com/fabioassuncao/issue-flow',
  createdAt: '2026-08-03T12:00:00.000Z',
  updatedAt: '2026-08-03T12:00:00.000Z',
  lastAttemptAt: null,
};

describe('projectMetadataSchema', () => {
  it('accepts a complete metadata file', () => {
    expect(projectMetadataSchema.parse(validMetadata)).toEqual(validMetadata);
  });

  it('accepts a null remoteUrl (project without an origin remote)', () => {
    const parsed = projectMetadataSchema.parse({ ...validMetadata, remoteUrl: null });
    expect(parsed.remoteUrl).toBeNull();
  });

  it('accepts a filled lastAttemptAt', () => {
    const parsed = projectMetadataSchema.parse({
      ...validMetadata,
      lastAttemptAt: '2026-08-04T09:30:00.000Z',
    });
    expect(parsed.lastAttemptAt).toBe('2026-08-04T09:30:00.000Z');
  });

  it('does not reject additive fields written by a newer version', () => {
    const result = projectMetadataSchema.safeParse({
      ...validMetadata,
      issueCount: 12,
      history: [{ at: '2026-08-04T09:30:00.000Z', issue: '32' }],
    });

    expect(result.success).toBe(true);
  });

  it.each([
    'schemaVersion',
    'projectId',
    'root',
    'remoteUrl',
    'createdAt',
    'updatedAt',
  ])('rejects metadata missing %s', (key) => {
    const incomplete = { ...validMetadata } as Record<string, unknown>;
    delete incomplete[key];

    expect(projectMetadataSchema.safeParse(incomplete).success).toBe(false);
  });

  it('rejects an undefined lastAttemptAt (nullable, not optional)', () => {
    const { lastAttemptAt: _omitted, ...rest } = validMetadata;

    expect(projectMetadataSchema.safeParse(rest).success).toBe(false);
  });

  it.each([
    ['schemaVersion', '1'],
    ['projectId', ''],
    ['root', ''],
    ['remoteUrl', 42],
    ['createdAt', ''],
  ])('rejects an invalid %s', (key, value) => {
    expect(projectMetadataSchema.safeParse({ ...validMetadata, [key]: value }).success).toBe(false);
  });
});

describe('globalConfigSchema', () => {
  it('accepts an empty object without materializing any key', () => {
    const parsed = globalConfigSchema.parse({});

    expect(parsed).toEqual({});
    expect(Object.keys(parsed)).toEqual([]);
  });

  it('accepts a complete configuration', () => {
    const config: GlobalConfig = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      storageDir: '/Volumes/work/issue-flow',
      web: { port: 4000, host: '127.0.0.1', refreshSeconds: 2, logLimit: 50 },
      retry: {
        retryLimit: 5,
        retryForever: false,
        backoffBaseSeconds: 30,
        backoffMaxSeconds: 900,
      },
      commit: { signoff: true, conventional: true },
    };

    expect(globalConfigSchema.parse(config)).toEqual(config);
  });

  it('keeps every sub-object partial', () => {
    const parsed = globalConfigSchema.parse({
      web: { host: 'localhost' },
      retry: { retryForever: true },
      commit: { signoff: true },
      storage: { driver: 'json', backupRetention: 2 },
    });

    expect(parsed.web).toEqual({ host: 'localhost' });
    expect(parsed.retry).toEqual({ retryForever: true });
    expect(parsed.commit).toEqual({ signoff: true });
    expect(parsed.storage).toEqual({ driver: 'json', backupRetention: 2 });
  });

  it('exposes only the machine-wide subset of the web configuration', () => {
    const parsed = globalConfigSchema.parse({
      web: { port: 4000, enabled: true, includeLogs: false },
    });

    expect(parsed.web).toEqual({ port: 4000 });
  });

  it('does not add a web.port key when the global file omits it', () => {
    const parsed = globalConfigSchema.parse({ web: { host: 'localhost' } });

    // A materialized default (or even an explicit `undefined`) would win the
    // spread merge below and silently drop the project value.
    expect(Object.hasOwn(parsed.web ?? {}, 'port')).toBe(false);
  });

  it('lets the project .issue-flow.json keep its web.port over the global file', () => {
    const globalLayer = globalConfigSchema.parse({ web: { host: 'localhost' } });
    // Raw project layer: only the keys the user actually wrote (see the test
    // below for why parsing it with webConfigSchema.partial() is not that).
    const projectLayer = { port: 4242 };

    const merged = { ...globalLayer.web, ...projectLayer };

    expect(merged.port).toBe(4242);
    // ...while a key only the global layer defines still applies.
    expect(merged.host).toBe('localhost');
  });

  it('documents that webConfigSchema.partial() still materializes defaults', () => {
    // zod 4 applies a `.default()` even through `.optional()`, so the layer
    // produced by readWebConfigFile() carries every default. A merge that puts
    // that layer above the global one would drop the global values — which is
    // exactly why globalWebConfigSchema unwraps the defaults away.
    expect(webConfigSchema.partial().parse({ port: 4242 }).host).toBe('0.0.0.0');
    expect(globalConfigSchema.parse({ web: { port: 4242 } }).web).toEqual({ port: 4242 });
  });

  it('lets the project layer stay untouched where the global file says nothing', () => {
    const globalLayer = globalConfigSchema.parse({});
    const projectLayer = webConfigSchema.partial().parse({ port: 4242, host: 'localhost' });

    expect(globalLayer.web).toBeUndefined();
    expect({ ...globalLayer.web, ...projectLayer }).toEqual(projectLayer);
  });

  it('only exposes web keys that still exist in webConfigSchema', () => {
    const globalWebKeys = Object.keys(globalConfigSchema.parse({ web: {} }).web ?? {});
    const allWebKeys = Object.keys(webConfigSchema.shape);

    // Guards against a rename in webConfigSchema silently orphaning this layer.
    expect(
      ['port', 'host', 'refreshSeconds', 'logLimit'].every((k) => allWebKeys.includes(k)),
    ).toBe(true);
    expect(globalWebKeys).toEqual([]);
  });

  it('ignores unknown top-level keys instead of failing', () => {
    const result = globalConfigSchema.safeParse({ storageDir: '/tmp/store', unknownKey: true });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ storageDir: '/tmp/store' });
  });

  it.each([
    ['web.port out of range', { web: { port: 0 } }],
    ['web.port not a number', { web: { port: 'auto' } }],
    ['web.host empty', { web: { host: '' } }],
    ['storageDir empty', { storageDir: '' }],
    ['schemaVersion not an integer', { schemaVersion: 1.5 }],
    ['retry.retryLimit negative', { retry: { retryLimit: -1 } }],
    ['retry.retryForever not a boolean', { retry: { retryForever: 'yes' } }],
    ['commit.signoff not a boolean', { commit: { signoff: 'true' } }],
    ['storage.driver unknown', { storage: { driver: 'memory' } }],
    ['storage.backupRetention negative', { storage: { backupRetention: -1 } }],
  ])('rejects %s', (_label, value) => {
    expect(globalConfigSchema.safeParse(value).success).toBe(false);
  });
});
