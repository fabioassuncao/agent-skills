import { describe, expect, it } from 'vitest';
import {
  assertComparable,
  ComparabilityError,
  type ComparabilityTuple,
  isRowInvalid,
  TUPLE_FIELDS,
} from './tuple.js';

function sample(overrides: Partial<ComparabilityTuple> = {}): ComparabilityTuple {
  return {
    task: 'small',
    harness: 'claude',
    harnessVersion: '2.1.251',
    model: 'sonnet',
    modelVersion: '4',
    effort: 'default',
    verification: 'existing-tests',
    strategy: 'pipeline',
    settingSourcesPinned: true,
    strictMcpConfig: false,
    fallbackModelPassed: false,
    ...overrides,
  };
}

describe('ComparabilityTuple', () => {
  it('accepts two identical tuples', () => {
    expect(() => assertComparable(sample(), sample())).not.toThrow();
  });

  it.each(TUPLE_FIELDS)('rejects a lone divergence in %s', (field) => {
    const left = sample();
    const right = sample({
      [field]:
        field === 'task'
          ? 'medium'
          : field === 'strategy'
            ? 'direct'
            : field === 'modelVersion'
              ? 'other'
              : field === 'settingSourcesPinned' ||
                  field === 'strictMcpConfig' ||
                  field === 'fallbackModelPassed'
                ? !left[field]
                : `other-${field}`,
    } as Partial<ComparabilityTuple>);
    expect(() => assertComparable(left, right)).toThrow(ComparabilityError);
    try {
      assertComparable(left, right);
    } catch (error) {
      expect(error).toBeInstanceOf(ComparabilityError);
      expect((error as ComparabilityError).field).toBe(field);
    }
  });

  it('ignores the declared experiment axis', () => {
    expect(() =>
      assertComparable(sample({ strictMcpConfig: false }), sample({ strictMcpConfig: true }), {
        ignore: ['strictMcpConfig'],
      }),
    ).not.toThrow();
  });

  it('marks a row invalid when --fallback-model was passed', () => {
    expect(isRowInvalid(sample({ fallbackModelPassed: true }))).toBe(true);
    expect(isRowInvalid(sample({ settingSourcesPinned: false }))).toBe(true);
    expect(isRowInvalid(sample())).toBe(false);
  });
});
