import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyPlaceholders, loadPrompt, resolvePackageDir } from './prompt-resolver.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('applyPlaceholders', () => {
  it('preserves replacement syntax and placeholder-like user data literally', () => {
    const value = "$& $$ $` $' __OTHER__ <!-- if:__OTHER__ -->";
    expect(
      applyPlaceholders('__BODY__\n__OTHER__', {
        __BODY__: value,
        __OTHER__: 'resolved',
      }),
    ).toBe(`${value}\nresolved`);
  });

  it('should replace __PRD_FILE__ placeholder', () => {
    const template = 'Read the PRD at __PRD_FILE__';
    const result = applyPlaceholders(template, {
      __PRD_FILE__: '/path/to/tasks.json',
    });
    expect(result).toBe('Read the PRD at /path/to/tasks.json');
  });

  it('should replace __PROGRESS_FILE__ placeholder', () => {
    const template = 'Write progress to __PROGRESS_FILE__';
    const result = applyPlaceholders(template, {
      __PROGRESS_FILE__: '/path/to/progress.txt',
    });
    expect(result).toBe('Write progress to /path/to/progress.txt');
  });

  it('should replace multiple placeholders', () => {
    const template = 'PRD: __PRD_FILE__, Progress: __PROGRESS_FILE__';
    const result = applyPlaceholders(template, {
      __PRD_FILE__: '/a/tasks.json',
      __PROGRESS_FILE__: '/b/progress.txt',
    });
    expect(result).toBe('PRD: /a/tasks.json, Progress: /b/progress.txt');
  });

  it('should replace all occurrences of the same placeholder', () => {
    const template = '__PRD_FILE__ and __PRD_FILE__ again';
    const result = applyPlaceholders(template, {
      __PRD_FILE__: '/path/tasks.json',
    });
    expect(result).toBe('/path/tasks.json and /path/tasks.json again');
  });

  it('should leave template unchanged if no matching placeholders', () => {
    const template = 'No placeholders here';
    const result = applyPlaceholders(template, {
      __PRD_FILE__: '/path',
    });
    expect(result).toBe('No placeholders here');
  });

  it('should handle empty template', () => {
    const result = applyPlaceholders('', { __PRD_FILE__: '/path' });
    expect(result).toBe('');
  });
});

describe('resolvePackageDir', () => {
  it('resolves prompts/ from the source tree (src/core/)', () => {
    expect(resolvePackageDir('prompts')).toBe(join(packageRoot, 'prompts'));
  });

  // Was `web/public` — the previous panel's directory, removed by §50.8. The
  // case keeps its subject (a nested package directory found from `dist/`) with
  // the directory that actually ships now.
  it('resolves web/dist from the compiled dist/ layout', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'issue-flow-package-layout-'));
    mkdirSync(join(fixture, 'web', 'dist'), { recursive: true });

    try {
      const resolved = resolvePackageDir(join('web', 'dist'), join(fixture, 'dist'));
      expect(resolved).toBe(join(fixture, 'web', 'dist'));
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('resolves prompts/ from the compiled dist/ layout', () => {
    const resolved = resolvePackageDir('prompts', join(packageRoot, 'dist'));
    expect(resolved).toBe(join(packageRoot, 'prompts'));
  });

  it('returns null when the directory cannot be located', () => {
    expect(resolvePackageDir('definitely-not-a-package-dir')).toBeNull();
  });
});

describe('loadPrompt', () => {
  it('should load the execute prompt template', async () => {
    const content = await loadPrompt('execute');
    expect(content).toContain('__PRD_FILE__');
    expect(content).toContain('__PROGRESS_FILE__');
  });

  it('should load the analyze prompt template', async () => {
    const content = await loadPrompt('analyze');
    expect(content).toContain('__ISSUE_NUMBER__');
    expect(content).toContain('<issue-analysis>');
  });

  it('should load the review prompt template', async () => {
    const content = await loadPrompt('review');
    expect(content).toContain('__ISSUE_NUMBER__');
    expect(content).toContain('<review-result>');
  });

  it('should throw for a non-existent prompt', async () => {
    await expect(loadPrompt('nonexistent')).rejects.toThrow('Prompt template not found');
  });
});
