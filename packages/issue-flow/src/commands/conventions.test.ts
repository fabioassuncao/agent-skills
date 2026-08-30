import { describe, expect, it, vi } from 'vitest';

vi.mock('../policy/index.js', () => ({
  loadRepositoryPolicy: async () => ({
    issues: { titleConvention: null },
    git: { branchConvention: null, typeMap: null },
  }),
}));

vi.mock('../issues/resolver.js', () => ({
  resolveIssue: async (id: string) => ({
    issue: {
      number: Number(id),
      title: 'Execução autônoma resiliente',
      labels: ['architecture'],
    },
  }),
}));

import {
  runConventionsBranch,
  runConventionsCommit,
  runConventionsPrTitle,
} from './conventions.js';

describe('issue-flow conventions', () => {
  it('prints a deterministic branch for an issue', async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    const code = await runConventionsBranch({ issue: '63' });
    log.mockRestore();
    expect(code).toBe(0);
    expect(lines[0]).toBe('feat/63-execucao-autonoma-resiliente');
  });

  it('formats a conventional commit', async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(String(line));
    });
    const code = await runConventionsCommit({
      type: 'fix',
      scope: 'runner',
      subject: 'recover created PR after missing URL',
      issue: '68',
    });
    log.mockRestore();
    expect(code).toBe(0);
    expect(lines[0]).toBe('fix(runner): recover created PR after missing URL\n\nRefs #68');
  });

  it('formats a PR title', async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    const code = await runConventionsPrTitle({ issue: '63' });
    log.mockRestore();
    expect(code).toBe(0);
    expect(lines[0]).toBe('feat: Execução autônoma resiliente');
  });
});
