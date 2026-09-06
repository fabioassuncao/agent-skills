import { describe, expect, it } from 'vitest';
import {
  buildOpenCodeArgv,
  buildOpenCodePermission,
  interpretOpenCodeAuth,
  opencodeRunVerdict,
  parseOpenCodeStream,
  parseOpenCodeUsage,
} from './opencode.js';
import { opencodeSettingsSchema } from './schemas.js';
import type { AgentInvocation, ResolvedAgentSettings } from './types.js';
import { OPENCODE_CAPABILITIES } from './types.js';

function settings(overrides: Partial<ResolvedAgentSettings> = {}): ResolvedAgentSettings {
  return {
    provider: 'opencode',
    model: null,
    claude: {},
    codex: {},
    cursor: {},
    antigravity: {},
    opencode: {},
    origin: { provider: 'default', model: 'default' },
    ...overrides,
  };
}

function invocation(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    prompt: 'say hi',
    phase: 'prd',
    timeout: 900_000,
    permission: 'workspace',
    ...overrides,
  };
}

function argvOf(
  inv: Partial<AgentInvocation> = {},
  resolved: Partial<ResolvedAgentSettings> = {},
): string[] {
  const built = buildOpenCodeArgv(invocation(inv), settings(resolved));
  if ('error' in built) throw new Error(built.error);
  return built.args;
}

describe('buildOpenCodeArgv', () => {
  it('runs opencode run with json, dir, auto and the prompt', () => {
    const args = argvOf({ workingDirectory: '/tmp/ws' });
    expect(args).toEqual(['run', '--format', 'json', '--dir', '/tmp/ws', '--auto', 'say hi']);
  });

  it('passes provider/model and variant when configured', () => {
    const args = argvOf({}, { model: 'opencode-go/qwen3.8-flash', opencode: { variant: 'high' } });
    expect(args).toContain('--model');
    expect(args).toContain('opencode-go/qwen3.8-flash');
    expect(args).toContain('--variant');
    expect(args).toContain('high');
  });

  it('rejects a bare model alias', () => {
    const built = buildOpenCodeArgv(invocation(), settings({ model: 'sonnet' }));
    expect(built).toEqual({
      error:
        'configuration: OpenCode model must be provider/model (for example opencode-go/qwen3.8-flash).',
    });
  });

  it('rejects a prompt that exceeds maxPromptBytes', () => {
    const built = buildOpenCodeArgv(
      invocation({ prompt: '0123456789' }),
      settings({ opencode: { maxPromptBytes: 4 } }),
    );
    expect('error' in built).toBe(true);
    if ('error' in built) expect(built.error).toMatch(/maxPromptBytes/);
  });

  it('puts the permission policy in OPENCODE_PERMISSION, never in argv', () => {
    const built = buildOpenCodeArgv(
      invocation({ permission: 'read-only', addDirs: ['/tmp/store'] }),
      settings(),
    );
    if ('error' in built) throw new Error(built.error);
    expect(built.args.join(' ')).not.toMatch(/secret|token|api[_-]?key/i);
    const policy = JSON.parse(built.env.OPENCODE_PERMISSION ?? '{}') as Record<string, unknown>;
    expect(policy.edit).toBe('deny');
    expect(policy.question).toBe('deny');
    expect(policy.external_directory).toMatchObject({
      '*': 'deny',
      '/tmp/store': 'allow',
      '/tmp/store/**': 'allow',
    });
  });
});

describe('buildOpenCodePermission', () => {
  it('denies workspace writes and mutating bash in read-only', () => {
    const policy = buildOpenCodePermission('read-only');
    expect(policy.edit).toBe('deny');
    expect(policy.bash).toMatchObject({ '*': 'allow', 'rm *': 'deny', 'git commit *': 'deny' });
  });

  it('allows edit and bash for workspace and autonomous', () => {
    expect(buildOpenCodePermission('workspace').edit).toBe('allow');
    expect(buildOpenCodePermission('autonomous').bash).toBe('allow');
  });

  it('never grants a wildcard external directory', () => {
    expect(buildOpenCodePermission('autonomous').external_directory).toEqual({ '*': 'deny' });
  });
});

describe('parseOpenCodeStream', () => {
  it('accumulates text, tools, session, usage and ignores unknown lines', () => {
    const events: Array<{ kind: string; name?: string; text?: string }> = [];
    const parsed = parseOpenCodeStream(
      [
        'not-json',
        JSON.stringify({
          type: 'step_start',
          sessionID: 'ses_abc',
          part: { type: 'step-start' },
        }),
        JSON.stringify({
          type: 'text',
          sessionID: 'ses_abc',
          part: { type: 'text', text: 'Hello' },
        }),
        JSON.stringify({
          type: 'tool_use',
          part: {
            type: 'tool',
            tool: 'read',
            state: { status: 'completed', input: { path: 'README.md' } },
          },
        }),
        JSON.stringify({ type: 'unknown_future', extra: true }),
        JSON.stringify({
          type: 'step_finish',
          part: {
            type: 'step-finish',
            reason: 'stop',
            tokens: { input: 12, output: 4, cache: { read: 2 } },
          },
        }),
      ].join('\n'),
      (event) => events.push(event),
    );
    expect(parsed.result).toBe('Hello');
    expect(parsed.sessionId).toBe('ses_abc');
    expect(parsed.seenTerminal).toBe(true);
    expect(parsed.usage).toEqual({ inputTokens: 12, outputTokens: 4, cacheReadTokens: 2 });
    expect(events).toEqual([
      { kind: 'text', text: 'Hello' },
      { kind: 'tool', name: 'read', detail: 'README.md' },
    ]);
  });

  it('records a permission denial from a tool error', () => {
    const parsed = parseOpenCodeStream(
      JSON.stringify({
        type: 'tool_use',
        part: {
          tool: 'edit',
          state: { status: 'error', error: { message: 'permission denied: edit' } },
        },
      }),
    );
    expect(parsed.permissionDenied).toEqual({
      tool: 'edit',
      message: 'permission denied: edit',
    });
  });

  it('leaves usage null when tokens are absent', () => {
    const parsed = parseOpenCodeStream(
      JSON.stringify({
        type: 'step_finish',
        part: { type: 'step-finish', reason: 'stop' },
      }),
    );
    expect(parsed.usage).toBeNull();
  });
});

describe('opencodeRunVerdict', () => {
  const ok = {
    result: 'done',
    sessionId: 'ses_1',
    model: null,
    usage: null,
    seenTerminal: true,
    error: null,
    permissionDenied: null,
  };

  it('requires terminal evidence besides exit 0', () => {
    const verdict = opencodeRunVerdict({
      exitCode: 0,
      parsed: { ...ok, result: '', seenTerminal: false },
      timedOut: false,
    });
    expect(verdict.success).toBe(false);
    expect(verdict.error).toMatch(/terminal event/);
  });

  it('accepts a successful stop with exit 0', () => {
    expect(opencodeRunVerdict({ exitCode: 0, parsed: ok, timedOut: false })).toEqual({
      success: true,
      error: null,
    });
  });

  it('fails a permission denial as configuration', () => {
    const verdict = opencodeRunVerdict({
      exitCode: 0,
      parsed: {
        ...ok,
        permissionDenied: { tool: 'edit', message: 'denied' },
      },
      timedOut: false,
    });
    expect(verdict.success).toBe(false);
    expect(verdict.error).toMatch(/^configuration:/);
  });
});

describe('interpretOpenCodeAuth', () => {
  it('confirms a listed provider and rejects empty or missing credentials', () => {
    expect(interpretOpenCodeAuth('anthropic\nopenai')).toBe(true);
    expect(interpretOpenCodeAuth('')).toBe(false);
    expect(interpretOpenCodeAuth('No credentials found')).toBe(false);
  });
});

describe('parseOpenCodeUsage', () => {
  it('does not invent zeros or cost', () => {
    expect(parseOpenCodeUsage({})).toBeNull();
    expect(parseOpenCodeUsage({ input: 3 })).toEqual({ inputTokens: 3 });
    expect(parseOpenCodeUsage({ input: 3 })).not.toHaveProperty('costUsd');
  });
});

describe('OPENCODE_CAPABILITIES', () => {
  it('declares real capabilities without claiming cost', () => {
    expect(OPENCODE_CAPABILITIES).toMatchObject({
      extraDirectories: 'flag',
      addDirs: true,
      modelSelection: true,
      modelDiscovery: true,
      usage: 'tokens-only',
      reportsCost: false,
      sessionResume: true,
      authProbe: 'text',
      bareModelAliases: false,
      promptChannel: 'argv',
    });
  });
});

describe('opencodeSettingsSchema', () => {
  it('accepts a partial settings block', () => {
    expect(opencodeSettingsSchema.safeParse({ variant: 'high' }).success).toBe(true);
    expect(opencodeSettingsSchema.safeParse({ maxPromptBytes: 0 }).success).toBe(false);
  });
});
