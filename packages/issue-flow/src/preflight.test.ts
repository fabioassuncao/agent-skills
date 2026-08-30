import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./utils/shell.js', () => ({
  run: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
}));

import { setAgentCliOverrides, validateDependencies } from './config.js';
import { run } from './utils/shell.js';

const mockRun = vi.mocked(run);

/** Every binary the preflight asked about, in order. */
function probed(): string[] {
  return mockRun.mock.calls.map(([command]) => command);
}

beforeEach(() => {
  mockRun.mockClear();
  mockRun.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
});

afterEach(() => {
  setAgentCliOverrides({});
});

describe('validateDependencies', () => {
  it('still asks only for git and claude when nothing is configured', async () => {
    expect(await validateDependencies()).toEqual([]);
    expect(probed()).toEqual(['git', 'claude']);
  });

  it.each([
    ['cursor', 'cursor-agent'],
    ['antigravity', 'agy'],
    ['codex', 'codex'],
  ] as const)('asks for the binary %s actually runs', async (provider, binary) => {
    setAgentCliOverrides({ forceProvider: provider });

    expect(await validateDependencies()).toEqual([]);

    // Mapping every non-Codex provider to `claude` demanded the wrong CLI for
    // Cursor and let an Antigravity run start with no `agy` installed.
    expect(probed()).toContain(binary);
    if (binary !== 'claude') expect(probed()).not.toContain('claude');
  });

  it('names the missing binary and how to install it', async () => {
    setAgentCliOverrides({ forceProvider: 'cursor' });
    mockRun.mockImplementation(async (command: string) => ({
      stdout: '',
      stderr: '',
      exitCode: command === 'cursor-agent' ? 1 : 0,
    }));

    const errors = await validateDependencies();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('cursor-agent');
    expect(errors[0]).toContain('cursor.com/install');
  });
});
