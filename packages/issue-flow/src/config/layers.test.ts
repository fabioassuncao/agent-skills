import { describe, expect, it } from 'vitest';
import { mergeConfigLayers } from '../config.js';

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
