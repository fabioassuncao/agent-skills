import { describe, expect, it } from 'vitest';
import { parsePlanResult } from './plan-result.js';

const output = (stories: unknown[]) =>
  `<task-plan>${JSON.stringify({ description: 'Plan work', stories })}</task-plan>`;

describe('parsePlanResult', () => {
  it('accepts ordered semantic stories', () => {
    expect(
      parsePlanResult(
        output([
          { key: 'base', title: 'Base', description: 'Build base', acceptanceCriteria: ['passes'] },
          {
            key: 'api',
            title: 'API',
            description: 'Build API',
            acceptanceCriteria: ['works'],
            dependsOn: ['base'],
          },
        ]),
      ).stories[1]?.dependsOn,
    ).toEqual(['base']);
  });

  it('rejects duplicate and unknown dependency keys', () => {
    const story = { key: 'a', title: 'A', description: 'Story A', acceptanceCriteria: ['passes'] };
    expect(() => parsePlanResult(output([story, story]))).toThrow('Duplicate story key');
    expect(() => parsePlanResult(output([{ ...story, dependsOn: ['missing'] }]))).toThrow(
      'unknown dependency',
    );
  });
});
