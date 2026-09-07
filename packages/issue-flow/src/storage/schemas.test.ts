import { describe, expect, it } from 'vitest';
import { webConfigSchema } from '../schemas.js';
import { type GlobalConfig, globalConfigSchema } from './schemas.js';

describe('globalConfigSchema', () => {
  it('accepts an empty object without materializing any key', () => {
    const parsed = globalConfigSchema.parse({});

    expect(parsed).toEqual({});
    expect(Object.keys(parsed)).toEqual([]);
  });

  it('accepts a complete configuration', () => {
    const config: GlobalConfig = {
      schemaVersion: 1,
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
      storage: { retention: { executions: 30 } },
    });

    expect(parsed.web).toEqual({ host: 'localhost' });
    expect(parsed.retry).toEqual({ retryForever: true });
    expect(parsed.commit).toEqual({ signoff: true });
    expect(parsed.storage).toEqual({ retention: { executions: 30 } });
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
    ['storage.retention.executions negative', { storage: { retention: { executions: -1 } } }],
  ])('rejects %s', (_label, value) => {
    expect(globalConfigSchema.safeParse(value).success).toBe(false);
  });
});
