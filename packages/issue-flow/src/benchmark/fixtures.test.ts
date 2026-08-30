import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../utils/shell.js';
import { CORPUS } from './corpus.js';
import { corpusTask, materialize } from './fixtures/index.js';

describe('benchmark fixtures', () => {
  it('materializes every corpus class as an independent git repository', async () => {
    const handles = [];
    try {
      for (const task of CORPUS) {
        const fixture = await materialize(task, 1);
        handles.push(fixture);
        await access(join(fixture.root, '.git'));
        expect(fixture.issueRef).toBe('1');
        const issue = await readFile(join(fixture.root, 'issues', '1', 'issue.md'), 'utf-8');
        expect(issue).toContain(task.title);
      }
    } finally {
      await Promise.all(handles.map((handle) => handle.dispose()));
    }
  });

  it('starts two repetitions of the same class from the same unfinished state', async () => {
    const first = await materialize(corpusTask('small'), 11);
    const second = await materialize(corpusTask('small'), 12);
    try {
      const firstSum = await readFile(join(first.root, 'src', 'sum.js'), 'utf-8');
      const secondSum = await readFile(join(second.root, 'src', 'sum.js'), 'utf-8');
      expect(firstSum).toContain('return a - b');
      expect(secondSum).toContain('return a - b');
      expect(first.root).not.toBe(second.root);
      expect(firstSum).not.toBe(secondSum);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it('has a small fixture whose existing test actually fails', async () => {
    const fixture = await materialize(corpusTask('small'), 3);
    try {
      const result = await run('node', ['src/sum.test.js'], { cwd: fixture.root });
      expect(result.exitCode).not.toBe(0);
    } finally {
      await fixture.dispose();
    }
  });

  it('has a medium fixture that does not implement the requested function', async () => {
    const fixture = await materialize(corpusTask('medium'), 4);
    try {
      const greet = await readFile(join(fixture.root, 'src', 'greet.js'), 'utf-8');
      expect(greet).not.toMatch(/export function greet/);
      const result = await run('node', ['src/greet.test.js'], { cwd: fixture.root });
      expect(result.exitCode).not.toBe(0);
    } finally {
      await fixture.dispose();
    }
  });

  it('dispose removes the repository', async () => {
    const fixture = await materialize(corpusTask('trivial'), 5);
    const root = fixture.root;
    await fixture.dispose();
    await expect(access(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
