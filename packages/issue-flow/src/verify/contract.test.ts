import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveContract } from './contract.js';

describe('resolveContract', () => {
  it('lets a declared contract win over discovery', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'verify-decl-'));
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'true' } }));
    const resolved = await resolveContract({
      cwd,
      declared: [{ id: 'lint', run: 'npm run lint', fatal: true }],
    });
    expect(resolved.source).toBe('declared');
    expect(resolved.checks.map((check) => check.id)).toEqual(['lint']);
  });

  it('discovers typecheck/lint/test scripts when nothing is declared', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'verify-disc-'));
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc', lint: 'biome', test: 'vitest' } }),
    );
    const resolved = await resolveContract({ cwd });
    expect(resolved.source).toBe('discovered');
    expect(resolved.checks.map((check) => check.id)).toEqual(['typecheck', 'lint', 'test']);
    expect(resolved.checks.find((check) => check.id === 'test')?.run).toBe('npm test');
  });

  it('discovers Makefile targets when package.json has no scripts', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'verify-make-'));
    await writeFile(join(cwd, 'Makefile'), 'test:\n\ttrue\n');
    const resolved = await resolveContract({ cwd });
    expect(resolved.source).toBe('discovered');
    expect(resolved.checks.map((check) => check.id)).toEqual(['test']);
  });

  it('resolves to empty — unverified, not green — when nothing exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'verify-empty-'));
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ name: 'bare' }));
    const resolved = await resolveContract({ cwd });
    expect(resolved).toEqual({ checks: [], source: 'empty' });
  });
});
