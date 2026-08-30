import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildCodexArgv, parseCodexStream } from './codex.js';
import type { AgentEvent, AgentInvocation, ResolvedAgentSettings } from './types.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function settings(overrides: Partial<ResolvedAgentSettings> = {}): ResolvedAgentSettings {
  return {
    provider: 'codex',
    model: null,
    claude: {},
    codex: {},
    cursor: {},
    origin: { provider: 'project', model: 'default' },
    ...overrides,
  };
}

function invocation(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    prompt: 'do the thing',
    phase: 'plan',
    timeout: 900_000,
    permission: 'workspace',
    ...overrides,
  };
}

describe('buildCodexArgv', () => {
  it('emits exec --json -o --sandbox --color never and a stdin dash', () => {
    const args = buildCodexArgv(invocation(), settings(), '/tmp/last.txt');
    expect(args.slice(0, 8)).toEqual([
      'exec',
      '--json',
      '--output-last-message',
      '/tmp/last.txt',
      '--sandbox',
      'workspace-write',
      '--color',
      'never',
    ]);
    expect(args.at(-1)).toBe('-');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--dangerously-bypass-hook-trust');
  });

  it('always sets --sandbox explicitly, including read-only', () => {
    const args = buildCodexArgv(
      invocation({ permission: 'read-only' }),
      settings(),
      '/tmp/last.txt',
    );
    expect(args).toContain('--sandbox');
    expect(args).toContain('read-only');
  });

  it('keeps autonomous inside workspace-write', () => {
    const args = buildCodexArgv(
      invocation({ permission: 'autonomous', phase: 'execute' }),
      settings(),
      '/tmp/last.txt',
    );
    expect(args).toContain('workspace-write');
    expect(args).not.toContain('danger-full-access');
  });

  it('omits --model and reasoning effort unless resolved', () => {
    const args = buildCodexArgv(invocation(), settings(), '/tmp/last.txt');
    expect(args).not.toContain('--model');
    expect(args.some((a) => a.startsWith('model_reasoning_effort='))).toBe(false);
  });

  it('adds --model and -c model_reasoning_effort when resolved', () => {
    const args = buildCodexArgv(
      invocation(),
      settings({ model: 'gpt-5.6', codex: { reasoningEffort: 'low' } }),
      '/tmp/last.txt',
    );
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5.6');
    expect(args).toContain('model_reasoning_effort=low');
  });

  it('adds isolation flags only when enabled', () => {
    const off = buildCodexArgv(invocation(), settings(), '/tmp/last.txt');
    expect(off).not.toContain('--ignore-user-config');
    expect(off).not.toContain('--skip-git-repo-check');

    const on = buildCodexArgv(
      invocation(),
      settings({ codex: { ignoreUserConfig: true, skipGitRepoCheck: true } }),
      '/tmp/last.txt',
    );
    expect(on).toContain('--ignore-user-config');
    expect(on).toContain('--skip-git-repo-check');
  });

  it('repeats --add-dir and --cd when set', () => {
    const args = buildCodexArgv(
      invocation({ workingDirectory: '/repo', addDirs: ['/tmp/a'] }),
      settings(),
      '/tmp/last.txt',
    );
    expect(args).toContain('--cd');
    expect(args).toContain('/repo');
    expect(args).toContain('--add-dir');
    expect(args).toContain('/tmp/a');
  });
});

describe('parseCodexStream', () => {
  it('reads success fixtures: result, usage, sessionId, and treats item.error as non-fatal', async () => {
    const raw = await readFile(join(fixtures, 'codex-success.jsonl'), 'utf-8');
    const events: AgentEvent[] = [];
    const state = parseCodexStream(raw.split('\n'), (e) => events.push(e));

    expect(state.failed).toBe(false);
    expect(state.completed).toBe(true);
    expect(state.sessionId).toBe('01a05035-206b-7491-9ec1-dd19d317e9d5');
    expect(state.lastAgentMessage).toBe('Created hi.txt containing hi.');
    expect(state.usage).toEqual({
      inputTokens: 44734 - 22016,
      outputTokens: 194,
      cacheReadTokens: 22016,
      cacheCreationTokens: 0,
    });
    expect(events.some((e) => e.kind === 'tool' && e.name === 'Bash')).toBe(true);
    expect(events.some((e) => e.kind === 'tool' && e.name === 'Edit')).toBe(true);
    expect(events.some((e) => e.kind === 'text' && e.text.includes('Skill descriptions'))).toBe(
      true,
    );
  });

  it('marks turn.failed and a top-level error as failure', async () => {
    const raw = await readFile(join(fixtures, 'codex-failure.jsonl'), 'utf-8');
    const state = parseCodexStream(raw.split('\n'));
    expect(state.failed).toBe(true);
    expect(state.error).toBeTruthy();
  });

  it('ignores malformed lines and keeps the result', () => {
    const state = parseCodexStream([
      'not json',
      '{"type":"thread.started","thread_id":"t1"}',
      '{broken',
      '{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}',
    ]);
    expect(state.sessionId).toBe('t1');
    expect(state.lastAgentMessage).toBe('ok');
    expect(state.completed).toBe(true);
    expect(state.failed).toBe(false);
  });
});
