import { describe, expect, it } from 'vitest';
import { buildClaudeArgv } from './claude.js';
import type { AgentInvocation, ResolvedAgentSettings } from './types.js';

function settings(overrides: Partial<ResolvedAgentSettings> = {}): ResolvedAgentSettings {
  return {
    provider: 'claude',
    model: null,
    claude: {},
    codex: {},
    cursor: {},
    origin: { provider: 'default', model: 'default' },
    ...overrides,
  };
}

function invocation(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    prompt: 'test',
    phase: 'analyze',
    timeout: 900_000,
    permission: 'workspace',
    maxTurns: 10,
    ...overrides,
  };
}

describe('buildClaudeArgv', () => {
  it('matches the historical runHeadless argv for workspace without a model', () => {
    expect(buildClaudeArgv(invocation(), settings()).args).toEqual([
      '-p',
      'test',
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '10',
    ]);
    expect(buildClaudeArgv(invocation(), settings()).stdinMode).toBe('ignore');
  });

  it('omits --model when none is resolved', () => {
    const { args } = buildClaudeArgv(invocation(), settings());
    expect(args).not.toContain('--model');
  });

  it('adds --model only when resolved', () => {
    const { args } = buildClaudeArgv(invocation(), settings({ model: 'claude-sonnet-5' }));
    expect(args.slice(-2)).toEqual(['--model', 'claude-sonnet-5']);
  });

  it('repeats --allowedTools and --add-dir', () => {
    const { args } = buildClaudeArgv(
      invocation({ allowedTools: ['Read', 'Write'], addDirs: ['/tmp/a', '/tmp/b'] }),
      settings(),
    );
    expect(args).toEqual([
      '-p',
      'test',
      '--output-format',
      'stream-json',
      '--verbose',
      '--max-turns',
      '10',
      '--allowedTools',
      'Read',
      '--allowedTools',
      'Write',
      '--add-dir',
      '/tmp/a',
      '--add-dir',
      '/tmp/b',
    ]);
  });

  it('matches the historical executeClaude argv for autonomous', () => {
    const { args, stdinMode } = buildClaudeArgv(
      invocation({ permission: 'autonomous', phase: 'execute' }),
      settings(),
    );
    expect(args).toEqual([
      '--dangerously-skip-permissions',
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    expect(stdinMode).toBe('prompt');
  });

  it('adds --permission-mode plan and a deny-list for read-only', () => {
    const { args } = buildClaudeArgv(
      invocation({ permission: 'read-only', allowedTools: ['Read', 'Glob', 'Grep'] }),
      settings(),
    );
    expect(args).toContain('--permission-mode');
    expect(args).toContain('plan');
    expect(args).toContain('--disallowedTools');
    expect(args).toContain('Agent');
    expect(args).toContain('Write');
  });

  it('does not deny a tool the phase explicitly allowed', () => {
    const { args } = buildClaudeArgv(
      invocation({ permission: 'read-only', allowedTools: ['Read', 'Write'] }),
      settings(),
    );
    const denyAt = args.indexOf('--disallowedTools');
    const denied = args.slice(denyAt + 1);
    expect(denied).not.toContain('Write');
  });

  it('passes --setting-sources project when ignoreUserConfig is set', () => {
    const { args } = buildClaudeArgv(
      invocation(),
      settings({ claude: { ignoreUserConfig: true } }),
    );
    expect(args).toContain('--setting-sources');
    expect(args).toContain('project');
  });

  it('never emits --fallback-model', () => {
    const { args } = buildClaudeArgv(invocation(), settings({ model: 'opus' }));
    expect(args).not.toContain('--fallback-model');
  });
});
