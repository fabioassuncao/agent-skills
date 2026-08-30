import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import { AntigravityRunner } from './antigravity.js';
import { CursorRunner } from './cursor.js';
import type { AgentInvocation, AgentRunner, ResolvedAgentSettings } from './types.js';

type ExecaResult = Awaited<ReturnType<typeof execa>>;

const mockExeca = vi.mocked(execa);

function settings(provider: ResolvedAgentSettings['provider']): ResolvedAgentSettings {
  return {
    provider,
    model: null,
    claude: {},
    codex: {},
    cursor: {},
    antigravity: {},
    origin: { provider: 'default', model: 'default' },
  };
}

function invocation(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    prompt: 'say hi',
    phase: 'execute',
    timeout: 0,
    permission: 'autonomous',
    inactivityTimeoutMs: 20,
    ...overrides,
  };
}

/**
 * A child that prints once and then goes quiet forever — the shape the
 * watchdog exists for. It resolves only after it is killed, exactly like a
 * real process receiving SIGTERM.
 */
function silentAfterFirstLine(firstLine: string) {
  const killed: string[] = [];
  const stdout = new Readable({ read() {} });
  stdout.push(`${firstLine}\n`);

  const subprocess = new Promise((resolve) => {
    const check = setInterval(() => {
      if (killed.length > 0) {
        clearInterval(check);
        stdout.push(null);
        resolve({ stdout: '', stderr: '', exitCode: 143 } as unknown as ExecaResult);
      }
    }, 5);
    check.unref?.();
  }) as unknown as ExecaResult & {
    stdout: Readable;
    kill: (signal?: NodeJS.Signals) => boolean;
  };
  subprocess.stdout = stdout;
  subprocess.stderr = null as unknown as Readable;
  subprocess.kill = (signal?: NodeJS.Signals) => {
    killed.push(signal ?? 'SIGTERM');
    return true;
  };
  return { subprocess, killed };
}

/**
 * `classify()` never sees `error` — the executor forwards `rawOutput`. A runner
 * that reports a stall only in `error` loses the `stalled` classification and
 * the retry policy that hangs off it, which is what cursor and antigravity did.
 */
const CASES: Array<{ name: string; runner: () => AgentRunner; firstLine: string }> = [
  {
    name: 'cursor',
    runner: () => new CursorRunner(),
    firstLine: JSON.stringify({ type: 'assistant', message: { content: [] } }),
  },
  {
    name: 'antigravity',
    runner: () => new AntigravityRunner(),
    firstLine: JSON.stringify({ type: 'assistant', text: 'working' }),
  },
];

describe.each(CASES)('$name stall reporting', ({ runner, firstLine }) => {
  it('carries the stall through rawOutput, where classify() reads it', async () => {
    const { subprocess, killed } = silentAfterFirstLine(firstLine);
    mockExeca.mockReturnValue(subprocess);
    const agent = runner();

    const result = await agent.run(invocation(), settings(agent.id));

    expect(killed).toContain('SIGTERM');
    expect(result.success).toBe(false);
    expect(result.rawOutput).toContain('produced no output for');
    expect(result.rawOutput).toContain('(stalled)');
    expect(result.exitCode).not.toBe(0);
  });

  it('reports the same stall in error and in rawOutput', async () => {
    const { subprocess } = silentAfterFirstLine(firstLine);
    mockExeca.mockReturnValue(subprocess);
    const agent = runner();

    const result = await agent.run(invocation(), settings(agent.id));

    // The two must agree: `error` is what the user reads, `rawOutput` is what
    // `classify()` reads, and a stall that only one of them knows about is the
    // bug this covers. Both come from the watchdog's measured silence, not
    // from `inactivityTimeoutMs`, which is undefined on a default run.
    expect(result.error).toBe(result.rawOutput);
  });

  it('names the binary that actually stalled', async () => {
    const { subprocess } = silentAfterFirstLine(firstLine);
    mockExeca.mockReturnValue(subprocess);
    const agent = runner();

    const result = await agent.run(invocation(), settings(agent.id));

    expect(result.rawOutput).not.toContain('claude produced no output');
  });
});
