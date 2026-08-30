import { describe, expect, it } from 'vitest';
import { analyzeTask } from './analyze.js';
import type { TaskClass } from './types.js';

const CASES: { class: TaskClass; signals: Parameters<typeof analyzeTask>[0] }[] = [
  { class: 'docs', signals: { title: 'Update README' } },
  { class: 'test', signals: { title: 'Add coverage for parser' } },
  { class: 'infra', signals: { title: 'Fix CI workflow' } },
  { class: 'analysis', signals: { title: 'Investigate the latency regression' } },
  { class: 'bugfix', signals: { title: 'Fix crash on empty input' } },
  { class: 'refactor', signals: { title: 'Extract retry helper' } },
  { class: 'feature', signals: { title: 'Implement queue cascade' } },
];

describe('analyzeTask', () => {
  it('reaches every task class', () => {
    const reached = new Set(CASES.map((item) => analyzeTask(item.signals).taskClass));
    for (const item of CASES) {
      expect(analyzeTask(item.signals).taskClass).toBe(item.class);
    }
    expect(reached.size).toBe(CASES.length);
  });

  it('marks risk from sensitive paths', () => {
    expect(analyzeTask({ title: 'tweaks', paths: ['src/auth/login.ts'] }).risk).toBe('high');
    expect(analyzeTask({ title: 'docs pass' }).risk).toBe('low');
  });
});
