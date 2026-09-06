import { describe, expect, it } from 'vitest';
import { buildCursorArgv, consumeCursorEvent, parseCursorStream } from './cursor.js';
import { cursorSettingsSchema } from './schemas.js';
import type { AgentInvocation, ResolvedAgentSettings } from './types.js';

function settings(overrides: Partial<ResolvedAgentSettings> = {}): ResolvedAgentSettings {
  return {
    provider: 'cursor',
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

describe('buildCursorArgv', () => {
  it('always uses stream-json and an explicit workspace', () => {
    const { command, args } = buildCursorArgv(invocation(), settings());
    expect(command).toBe('cursor-agent');
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'stream-json']);
    expect(args).toContain('--workspace');
    expect(args.at(-1)).toBe('say hi');
  });

  it('puts --force on workspace and autonomous, never on read-only', () => {
    expect(buildCursorArgv(invocation({ permission: 'workspace' }), settings()).args).toContain(
      '--force',
    );
    expect(buildCursorArgv(invocation({ permission: 'autonomous' }), settings()).args).toContain(
      '--force',
    );
    const readOnly = buildCursorArgv(invocation({ permission: 'read-only' }), settings()).args;
    expect(readOnly).not.toContain('--force');
    expect(readOnly).toContain('--mode');
    expect(readOnly).toContain('plan');
  });

  it('never emits --trust or --yolo', () => {
    const { args } = buildCursorArgv(invocation(), settings());
    expect(args).not.toContain('--trust');
    expect(args).not.toContain('--yolo');
    expect(args).not.toContain('--api-key');
  });

  it('adds --model and --sandbox when configured', () => {
    const { args } = buildCursorArgv(
      invocation(),
      settings({ model: 'sonnet-4', cursor: { sandbox: 'enabled' } }),
    );
    expect(args).toContain('--model');
    expect(args).toContain('sonnet-4');
    expect(args).toContain('--sandbox');
    expect(args).toContain('enabled');
  });
});

describe('parseCursorStream', () => {
  it('reads result, session and model from NDJSON', () => {
    const raw = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'sess-1',
        model: 'sonnet-4',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hello' }] },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done',
        session_id: 'sess-1',
      }),
    ].join('\n');
    const parsed = parseCursorStream(raw);
    expect(parsed.result).toBe('done');
    expect(parsed.sessionId).toBe('sess-1');
    expect(parsed.model).toBe('sonnet-4');
    expect(parsed.isError).toBe(false);
  });

  it('ignores malformed lines', () => {
    expect(parseCursorStream('not-json\n{"type":"result","result":"ok"}\n').result).toBe('ok');
  });

  it('emits tool events from tool_call started', () => {
    const events: string[] = [];
    consumeCursorEvent(
      {
        type: 'tool_call',
        subtype: 'started',
        tool_call: { readToolCall: { args: { path: '/tmp/a' } } },
      },
      (event) => {
        if (event.kind === 'tool') events.push(`${event.name}:${event.detail ?? ''}`);
      },
    );
    expect(events).toEqual(['Read:/tmp/a']);
  });
});

describe('cursor settings schema', () => {
  it('rejects force: false', () => {
    const result = cursorSettingsSchema.safeParse({ force: false });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.message).toMatch(/cannot be false/);
  });
});
