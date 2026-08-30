import { describe, expect, it } from 'vitest';
import { classify } from '../resilience/errors.js';
import {
  ANTIGRAVITY_MIN_VERSION,
  antigravityRunVerdict,
  buildAntigravityArgv,
  compareVersions,
  DEFAULT_EXECUTE_TIMEOUT_MS,
  formatPrintTimeout,
  normalizeAntigravityTool,
  parseAntigravityStream,
  parseAntigravityUsage,
  parseDurationMs,
  resolveAntigravityTimeoutMs,
} from './antigravity.js';
import { buildClaudeArgv } from './claude.js';
import { buildCodexArgv } from './codex.js';
import { buildCursorArgv } from './cursor.js';
import { antigravitySettingsSchema } from './schemas.js';
import type { AgentEvent, AgentInvocation, ResolvedAgentSettings } from './types.js';
import {
  ANTIGRAVITY_CAPABILITIES,
  CLAUDE_CAPABILITIES,
  CODEX_CAPABILITIES,
  CURSOR_CAPABILITIES,
} from './types.js';

function settings(overrides: Partial<ResolvedAgentSettings> = {}): ResolvedAgentSettings {
  return {
    provider: 'antigravity',
    model: null,
    claude: {},
    codex: {},
    cursor: {},
    antigravity: {},
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
  const built = buildAntigravityArgv(invocation(inv), settings(resolved));
  if ('error' in built) throw new Error(built.error);
  return built.args;
}

describe('buildAntigravityArgv', () => {
  it('always emits the headless invariants', () => {
    const { command, args } = buildAntigravityArgv(invocation(), settings()) as {
      command: string;
      args: string[];
    };
    expect(command).toBe('agy');
    expect(args[0]).toBe('-p');
    expect(args[1]).toBe('say hi');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--print-timeout');
    expect(args).toContain('--add-dir');
  });

  it('always adds the workspace, plus one --add-dir per extra directory', () => {
    const args = argvOf({
      workingDirectory: '/repo',
      addDirs: ['/home/user/.issue-flow'],
    });
    const dirs = args.flatMap((value, i) => (value === '--add-dir' ? [args[i + 1]] : []));
    expect(dirs).toEqual(['/repo', '/home/user/.issue-flow']);
  });

  it('translates permission through --mode and keeps skip-permissions', () => {
    expect(argvOf({ permission: 'read-only' })).toEqual(
      expect.arrayContaining(['--mode', 'plan', '--dangerously-skip-permissions']),
    );
    expect(argvOf({ permission: 'workspace' })).toEqual(
      expect.arrayContaining(['--mode', 'accept-edits', '--dangerously-skip-permissions']),
    );
    expect(argvOf({ permission: 'autonomous' })).toEqual(
      expect.arrayContaining(['--mode', 'accept-edits', '--dangerously-skip-permissions']),
    );
  });

  it('adds --model and --effort only when resolved', () => {
    const plain = argvOf();
    expect(plain).not.toContain('--model');
    expect(plain).not.toContain('--effort');
    const configured = argvOf(
      {},
      { model: 'gemini-3.5-flash-medium', antigravity: { effort: 'high' } },
    );
    expect(configured).toEqual(
      expect.arrayContaining(['--model', 'gemini-3.5-flash-medium', '--effort', 'high']),
    );
  });

  it('adds --sandbox only with opt-in', () => {
    expect(argvOf()).not.toContain('--sandbox');
    expect(argvOf({}, { antigravity: { sandbox: true } })).toContain('--sandbox');
  });

  it('translates timeout: N and never omits --print-timeout when timeout is 0', () => {
    const finite = argvOf({ timeout: 300_000 });
    const timeoutAt = finite.indexOf('--print-timeout');
    expect(finite[timeoutAt + 1]).toBe('5m0s');

    const unbounded = argvOf({ timeout: 0 });
    const unboundedAt = unbounded.indexOf('--print-timeout');
    expect(unbounded[unboundedAt + 1]).toBe(formatPrintTimeout(DEFAULT_EXECUTE_TIMEOUT_MS));
  });

  it('fails as configuration when timeout: 0 has no ceiling', () => {
    const built = buildAntigravityArgv(
      invocation({ timeout: 0 }),
      settings({ antigravity: { executeTimeout: null } }),
    );
    expect(built).toMatchObject({ error: expect.stringMatching(/configuration:.*timeout: 0/) });
  });

  it('fails as configuration before spawn when the prompt exceeds maxPromptBytes', () => {
    const built = buildAntigravityArgv(
      invocation({ prompt: 'x'.repeat(50) }),
      settings({ antigravity: { maxPromptBytes: 10 } }),
    );
    expect(built).toMatchObject({ error: expect.stringMatching(/configuration: prompt exceeds/) });
  });
});

describe('parseAntigravityStream', () => {
  const successFixture = [
    JSON.stringify({
      event: 'init',
      conversation_id: 'conv-1',
      init: { cwd: '/repo', permission_mode: 'accept-edits', tools: ['run_command'] },
    }),
    JSON.stringify({
      event: 'step_update',
      step_update: {
        step_index: 1,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: 'hello',
        usage: { input_tokens: 10, output_tokens: 4, thinking_tokens: 2, cache_read_tokens: 0 },
      },
    }),
    JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'conv-1',
        status: 'SUCCESS',
        response: 'done',
        duration_seconds: 1.2,
        num_turns: 1,
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          thinking_tokens: 2,
          cache_read_tokens: 0,
          total_tokens: 14,
        },
      },
    }),
  ].join('\n');

  it('reads result, session and usage from NDJSON', () => {
    const parsed = parseAntigravityStream(successFixture);
    expect(parsed.result).toBe('done');
    expect(parsed.sessionId).toBe('conv-1');
    expect(parsed.status).toBe('SUCCESS');
    expect(parsed.seenResult).toBe(true);
    expect(parsed.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 0,
      numTurns: 1,
    });
    expect(parsed.usage).not.toHaveProperty('costUsd');
  });

  it('treats permission denial plus SUCCESS as a configuration failure signal', () => {
    const raw = [
      JSON.stringify({
        event: 'step_update',
        step_update: {
          state: 'ERROR',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: {
            error: {
              type: 'TOOL_ERROR',
              message:
                'permission check failed for command "ls -1": user denied permission to run command:\nls -1',
            },
          },
        },
      }),
      JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: '', num_turns: 1, usage: { input_tokens: 1 } },
      }),
    ].join('\n');
    const parsed = parseAntigravityStream(raw);
    expect(parsed.status).toBe('SUCCESS');
    expect(parsed.permissionDenied?.tool).toBe('run_command');
  });

  it('keeps unrelated TOOL_ERROR as a warning, not a failure', () => {
    const raw = [
      JSON.stringify({
        event: 'step_update',
        step_update: {
          state: 'ERROR',
          step_type: 'tool',
          tool_name: 'write_to_file',
          tool_info: {
            error: { type: 'TOOL_ERROR', message: 'path is outside the project' },
          },
        },
      }),
      JSON.stringify({
        event: 'result',
        result: { status: 'SUCCESS', response: 'ok', num_turns: 1 },
      }),
    ].join('\n');
    const parsed = parseAntigravityStream(raw);
    expect(parsed.permissionDenied).toBeNull();
    expect(parsed.warnings[0]).toMatch(/TOOL_ERROR on write_to_file/);
    expect(parsed.status).toBe('SUCCESS');
  });

  it('maps WAITING, CANCELED, INTERRUPTED and ERROR', () => {
    expect(parseAntigravityStream('{"event":"result","result":{"status":"WAITING"}}').status).toBe(
      'WAITING',
    );
    expect(parseAntigravityStream('{"event":"result","result":{"status":"CANCELED"}}').status).toBe(
      'CANCELED',
    );
    expect(
      parseAntigravityStream('{"event":"result","result":{"status":"INTERRUPTED"}}').status,
    ).toBe('INTERRUPTED');
    expect(
      parseAntigravityStream(
        '{"event":"result","result":{"status":"ERROR","error":"invalid model"}}',
      ).error,
    ).toBe('invalid model');
  });

  it('does not treat a missing result event as success', () => {
    expect(parseAntigravityStream('{"event":"init","conversation_id":"x"}').seenResult).toBe(false);
  });

  it('ignores malformed lines', () => {
    const parsed = parseAntigravityStream(
      `not-json\n{"event":"result","result":{"status":"SUCCESS","response":"ok","num_turns":1}}\n`,
    );
    expect(parsed.result).toBe('ok');
    expect(parsed.seenResult).toBe(true);
  });

  it('normalizes tool names and emits ACTIVE tools', () => {
    const events: AgentEvent[] = [];
    parseAntigravityStream(
      JSON.stringify({
        event: 'step_update',
        step_update: {
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'view_file',
          tool_info: { parameters: { TargetFile: '/tmp/a' } },
        },
      }),
      (event) => events.push(event),
    );
    expect(events).toEqual([{ kind: 'tool', name: 'Read', detail: '/tmp/a' }]);
  });
});

describe('antigravityRunVerdict', () => {
  it('fails configuration on permission denial even when status is SUCCESS and exit is 0', () => {
    const parsed = parseAntigravityStream(
      [
        JSON.stringify({
          event: 'step_update',
          step_update: {
            state: 'ERROR',
            step_type: 'tool',
            tool_name: 'run_command',
            tool_info: {
              error: {
                type: 'TOOL_ERROR',
                message: 'permission check failed: user denied permission',
              },
            },
          },
        }),
        JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS', response: '', num_turns: 1 },
        }),
      ].join('\n'),
    );
    const verdict = antigravityRunVerdict({ exitCode: 0, parsed, timedOut: false });
    expect(verdict.success).toBe(false);
    expect(verdict.error).toMatch(/configuration: permission check failed for run_command/);
    expect(classify({ source: 'agent', exitCode: 0, stdout: verdict.error ?? '' }).kind).toBe(
      'configuration',
    );
  });

  it('fails configuration on WAITING', () => {
    const parsed = parseAntigravityStream(
      '{"event":"result","result":{"status":"WAITING","response":""}}',
    );
    const verdict = antigravityRunVerdict({ exitCode: 0, parsed, timedOut: false });
    expect(verdict.success).toBe(false);
    expect(verdict.error).toMatch(/waiting for human input/);
    expect(classify({ source: 'agent', exitCode: 0, stdout: verdict.error ?? '' }).kind).toBe(
      'configuration',
    );
  });

  it('fails when the result event is missing even with exit 0', () => {
    const parsed = parseAntigravityStream('{"event":"init","conversation_id":"x"}');
    const verdict = antigravityRunVerdict({ exitCode: 0, parsed, timedOut: false });
    expect(verdict.success).toBe(false);
    expect(verdict.error).toMatch(/without a result event/);
  });

  it('succeeds when a non-permission TOOL_ERROR is followed by SUCCESS', () => {
    const parsed = parseAntigravityStream(
      [
        JSON.stringify({
          event: 'step_update',
          step_update: {
            state: 'ERROR',
            step_type: 'tool',
            tool_name: 'write_to_file',
            tool_info: { error: { type: 'TOOL_ERROR', message: 'path is outside the project' } },
          },
        }),
        JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS', response: 'ok', num_turns: 1 },
        }),
      ].join('\n'),
    );
    expect(parsed.warnings.length).toBe(1);
    expect(antigravityRunVerdict({ exitCode: 0, parsed, timedOut: false }).success).toBe(true);
  });
});

describe('normalizeAntigravityTool', () => {
  it('maps each family to the renderer name', () => {
    expect(normalizeAntigravityTool('run_command')).toBe('Bash');
    expect(normalizeAntigravityTool('command_status')).toBe('Bash');
    expect(normalizeAntigravityTool('view_file')).toBe('Read');
    expect(normalizeAntigravityTool('read_resource')).toBe('Read');
    expect(normalizeAntigravityTool('write_to_file')).toBe('Edit');
    expect(normalizeAntigravityTool('replace_file_content')).toBe('Edit');
    expect(normalizeAntigravityTool('grep_search')).toBe('Grep');
    expect(normalizeAntigravityTool('find_by_name')).toBe('Glob');
    expect(normalizeAntigravityTool('list_dir')).toBe('Glob');
    expect(normalizeAntigravityTool('read_url_content')).toBe('WebFetch');
    expect(normalizeAntigravityTool('open_browser_url')).toBe('WebFetch');
  });
});

describe('parseAntigravityUsage', () => {
  it('maps the reported fields and never invents costUsd', () => {
    const usage = parseAntigravityUsage(
      {
        input_tokens: 10,
        output_tokens: 4,
        thinking_tokens: 2,
        cache_read_tokens: 8,
        total_tokens: 14,
      },
      1,
    );
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 8,
      numTurns: 1,
    });
    expect(usage).not.toHaveProperty('costUsd');
    expect((usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)).toBe(14);
  });

  it('returns null when num_turns is 0', () => {
    expect(
      parseAntigravityUsage(
        {
          input_tokens: 0,
          output_tokens: 0,
          thinking_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: 0,
        },
        0,
      ),
    ).toBeNull();
  });
});

describe('capabilities and nativeTimeout', () => {
  it('declares the four-provider matrix without changing Claude, Codex or Cursor argv', () => {
    expect(CLAUDE_CAPABILITIES.promptChannel).toBe('both');
    expect(CLAUDE_CAPABILITIES.nativeTimeout).toBe(false);
    expect(CODEX_CAPABILITIES.promptChannel).toBe('both');
    expect(CODEX_CAPABILITIES.nativeTimeout).toBe(false);
    expect(CURSOR_CAPABILITIES.promptChannel).toBe('argv');
    expect(CURSOR_CAPABILITIES.nativeTimeout).toBe(false);
    expect(ANTIGRAVITY_CAPABILITIES).toMatchObject({
      extraDirectories: 'flag',
      toolAllowlist: false,
      maxTurns: false,
      osSandbox: true,
      modelSelection: true,
      modelDiscovery: true,
      usage: 'tokens-only',
      sessionResume: true,
      authProbe: 'none',
      promptChannel: 'argv',
      nativeTimeout: true,
    });

    const claude = buildClaudeArgv(invocation({ phase: 'prd' }), {
      provider: 'claude',
      model: null,
      claude: {},
      codex: {},
      cursor: {},
      antigravity: {},
      origin: { provider: 'default', model: 'default' },
    });
    expect(claude.args).not.toContain('--print-timeout');
    expect(claude.args).not.toContain('--disable-slash-commands');

    const cursor = buildCursorArgv(invocation(), {
      provider: 'cursor',
      model: null,
      claude: {},
      codex: {},
      cursor: {},
      antigravity: {},
      origin: { provider: 'default', model: 'default' },
    });
    expect(cursor.args).not.toContain('--print-timeout');
    expect(cursor.args).not.toContain('--dangerously-skip-permissions');

    const codex = buildCodexArgv(
      invocation({ phase: 'prd', permission: 'workspace' }),
      {
        provider: 'codex',
        model: null,
        claude: {},
        codex: {},
        cursor: {},
        antigravity: {},
        origin: { provider: 'default', model: 'default' },
      },
      '/tmp/codex-out.txt',
    );
    expect(codex).not.toContain('--print-timeout');
  });

  it('rejects skipPermissions: false', () => {
    const result = antigravitySettingsSchema.safeParse({ skipPermissions: false });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toMatch(/cannot be false/);
  });

  it('resolves timeout: 0 without a ceiling to null', () => {
    expect(
      resolveAntigravityTimeoutMs({ timeout: 0 }, { antigravity: { executeTimeout: null } }),
    ).toBeNull();
    expect(resolveAntigravityTimeoutMs({ timeout: 0 }, { antigravity: {} })).toBe(
      DEFAULT_EXECUTE_TIMEOUT_MS,
    );
  });

  it('compares versions against the floor', () => {
    expect(compareVersions('1.1.22', ANTIGRAVITY_MIN_VERSION)).toBe(0);
    expect(compareVersions('1.1.21', ANTIGRAVITY_MIN_VERSION)).toBeLessThan(0);
    expect(compareVersions('1.2.0', ANTIGRAVITY_MIN_VERSION)).toBeGreaterThan(0);
  });

  it('parses duration strings used in config', () => {
    expect(parseDurationMs('4h')).toBe(DEFAULT_EXECUTE_TIMEOUT_MS);
    expect(parseDurationMs('5m0s')).toBe(300_000);
    expect(formatPrintTimeout(300_000)).toBe('5m0s');
  });
});
