// biome-ignore-all lint/suspicious/noTemplateCurlyInString: environment-reference tokens are data.
import { describe, expect, it } from 'vitest';
import {
  buildDockerExecCommand,
  buildDockerShellCommand,
  buildPaneCommand,
  buildRuntimeBootstrap,
  buildTtyAgentArgv,
  quoteShellArgument,
  renderShellCommand,
  renderShellCommandWithEnvironmentRefs,
  SANDBOX_PATH_ENTRIES,
} from './tty.js';

/**
 * **C4** of §34: starting an agent produces the exact command the pane runs, and
 * the prompt is present in the argv **after `--`**.
 *
 * Adapted from WebMux `backend/src/services/agent-service.ts` @ d8c9d5f. The
 * upstream asserts on a shell string; these assert on the argv, because that is
 * what Issue Flow builds (ADR-04) and the string is only its serialization.
 */
describe('buildTtyAgentArgv — claude', () => {
  it('starts a fresh autonomous session with the prompt after --', () => {
    expect(
      buildTtyAgentArgv({
        provider: 'claude',
        permission: 'autonomous',
        prompt: 'do the thing',
      }),
    ).toEqual(['claude', '--dangerously-skip-permissions', '--', 'do the thing']);
  });

  // The `--` is not about quoting: it makes the TUI take the prompt as its
  // first turn, before its input loop starts, which is what avoids the
  // paste/Enter race against a TUI that is not ready yet.
  it('always puts the prompt last, after the separator', () => {
    const argv = buildTtyAgentArgv({
      provider: 'claude',
      permission: 'autonomous',
      systemPrompt: 'be careful',
      prompt: 'do the thing',
    });
    expect(argv.at(-2)).toBe('--');
    expect(argv.at(-1)).toBe('do the thing');
  });

  it('omits the prompt entirely when there is none', () => {
    expect(buildTtyAgentArgv({ provider: 'claude', permission: 'autonomous' })).toEqual([
      'claude',
      '--dangerously-skip-permissions',
    ]);
  });

  // Issue Flow's three semantic levels, not the upstream's yolo boolean.
  it('translates the semantic permission rather than a yolo flag', () => {
    expect(buildTtyAgentArgv({ provider: 'claude', permission: 'workspace' })).toEqual(['claude']);
    expect(buildTtyAgentArgv({ provider: 'claude', permission: 'read-only' })).toEqual([
      'claude',
      '--permission-mode',
      'plan',
    ]);
  });

  it('appends a system prompt only on a fresh start', () => {
    expect(
      buildTtyAgentArgv({
        provider: 'claude',
        permission: 'workspace',
        systemPrompt: 'be careful',
      }),
    ).toEqual(['claude', '--append-system-prompt', 'be careful']);
    // Resuming a conversation that already has the instructions must not add
    // them a second time.
    expect(
      buildTtyAgentArgv({
        provider: 'claude',
        permission: 'workspace',
        systemPrompt: 'be careful',
        launchMode: 'resume',
        resumeConversationId: 'conv-1',
      }),
    ).toEqual(['claude', '--resume', 'conv-1']);
  });

  it('resumes a named conversation, and continues the most recent without one', () => {
    expect(
      buildTtyAgentArgv({
        provider: 'claude',
        permission: 'autonomous',
        launchMode: 'resume',
        resumeConversationId: 'conv-1',
        prompt: 'keep going',
      }),
    ).toEqual([
      'claude',
      '--dangerously-skip-permissions',
      '--resume',
      'conv-1',
      '--',
      'keep going',
    ]);
    expect(
      buildTtyAgentArgv({ provider: 'claude', permission: 'autonomous', launchMode: 'resume' }),
    ).toEqual(['claude', '--dangerously-skip-permissions', '--continue']);
  });

  it('forks a conversation and pins the child id when one was generated', () => {
    expect(
      buildTtyAgentArgv({
        provider: 'claude',
        permission: 'autonomous',
        launchMode: 'fork',
        forkFromConversationId: 'parent',
        pinConversationId: 'child',
      }),
    ).toEqual([
      'claude',
      '--dangerously-skip-permissions',
      '--resume',
      'parent',
      '--fork-session',
      '--session-id',
      'child',
    ]);
  });

  it('carries an explicit model', () => {
    expect(
      buildTtyAgentArgv({
        provider: 'claude',
        permission: 'workspace',
        model: 'claude-opus-5',
      }),
    ).toEqual(['claude', '--model', 'claude-opus-5']);
  });
});

describe('buildTtyAgentArgv — codex', () => {
  // Without `--enable hooks` the lifecycle hooks of phase 2 never fire and the
  // agent's state becomes unknowable (ADR-05).
  it('always enables hooks', () => {
    for (const permission of ['read-only', 'workspace', 'autonomous'] as const) {
      expect(buildTtyAgentArgv({ provider: 'codex', permission }).slice(0, 3)).toEqual([
        'codex',
        '--enable',
        'hooks',
      ]);
    }
  });

  it('starts a fresh session with the prompt after --', () => {
    expect(
      buildTtyAgentArgv({ provider: 'codex', permission: 'autonomous', prompt: 'do the thing' }),
    ).toEqual(['codex', '--enable', 'hooks', '--yolo', '--', 'do the thing']);
  });

  it('passes a system prompt as developer_instructions', () => {
    expect(
      buildTtyAgentArgv({ provider: 'codex', permission: 'workspace', systemPrompt: 'be careful' }),
    ).toEqual(['codex', '--enable', 'hooks', '-c', 'developer_instructions=be careful']);
  });

  it('resumes a named conversation, and takes the last one without an id', () => {
    expect(
      buildTtyAgentArgv({
        provider: 'codex',
        permission: 'autonomous',
        launchMode: 'resume',
        resumeConversationId: 'conv-1',
        prompt: 'keep going',
      }),
    ).toEqual(['codex', '--enable', 'hooks', '--yolo', 'resume', 'conv-1', '--', 'keep going']);
    expect(
      buildTtyAgentArgv({ provider: 'codex', permission: 'autonomous', launchMode: 'resume' }),
    ).toEqual(['codex', '--enable', 'hooks', '--yolo', 'resume', '--last']);
  });

  it('forks with the subcommand rather than a flag', () => {
    expect(
      buildTtyAgentArgv({
        provider: 'codex',
        permission: 'autonomous',
        launchMode: 'fork',
        forkFromConversationId: 'parent',
      }),
    ).toEqual(['codex', '--enable', 'hooks', '--yolo', 'fork', 'parent']);
  });
});

describe('buildTtyAgentArgv — unsupported providers', () => {
  // Guessing a command line would fail inside a pane, where nobody can read it.
  it('refuses a provider with no built-in TTY form', () => {
    expect(() => buildTtyAgentArgv({ provider: 'cursor', permission: 'workspace' })).toThrow(
      'custom agent',
    );
  });
});

describe('shell serialization', () => {
  // Every element, without exception — not only the ones that look dangerous.
  it('quotes each argument and escapes embedded quotes', () => {
    expect(quoteShellArgument('plain')).toBe("'plain'");
    expect(quoteShellArgument("it's")).toBe("'it'\\''s'");
    expect(quoteShellArgument('$(rm -rf /)')).toBe("'$(rm -rf /)'");
    expect(quoteShellArgument('a b\nc')).toBe("'a b\nc'");
  });

  it('renders an argv as a command line with nothing left unquoted', () => {
    expect(renderShellCommand(['claude', '--', "it's time"])).toBe("'claude' '--' 'it'\\''s time'");
  });

  it('expands only allowed environment references as one shell argument', () => {
    expect(
      renderShellCommandWithEnvironmentRefs(
        ['tool', 'prefix-${ISSUE_FLOW_AGENT_PROMPT}-suffix', '${NOT_ALLOWED}'],
        ['ISSUE_FLOW_AGENT_PROMPT'],
      ),
    ).toBe(`'tool' 'prefix-'"\${ISSUE_FLOW_AGENT_PROMPT}"'-suffix' '\${NOT_ALLOWED}'`);
  });

  // The whole point of building argv first: a prompt that looks like a command
  // is data by the time it reaches the shell.
  it('keeps an injection attempt inside the prompt argument', () => {
    const argv = buildTtyAgentArgv({
      provider: 'claude',
      permission: 'autonomous',
      prompt: "'; rm -rf ~; echo '",
    });
    // The dangerous text is still *in* the command line — it has to be, it is
    // the prompt. What matters is that it is inside one quoted argument, so the
    // shell hands it to the agent as data instead of running it.
    expect(argv.at(-1)).toBe("'; rm -rf ~; echo '");
    expect(renderShellCommand(argv)).toBe(
      "'claude' '--dangerously-skip-permissions' '--' ''\\''; rm -rf ~; echo '\\'''",
    );
  });
});

describe('buildPaneCommand', () => {
  // `set -a` exports what the file defines so the agent and everything it
  // spawns inherit the worktree's ports; `set +a` restores the shell for
  // whoever types in the pane afterwards.
  it('sources the runtime environment before the agent', () => {
    expect(buildRuntimeBootstrap('/repo/.git/issue-flow/runtime.env')).toBe(
      "set -a; . '/repo/.git/issue-flow/runtime.env'; set +a",
    );
    expect(
      buildPaneCommand({
        argv: ['claude', '--', 'go'],
        runtimeEnvPath: '/repo/.git/issue-flow/runtime.env',
      }),
    ).toBe("set -a; . '/repo/.git/issue-flow/runtime.env'; set +a; 'claude' '--' 'go'");
  });

  it('runs the agent alone when the worktree has no runtime environment', () => {
    expect(buildPaneCommand({ argv: ['claude'] })).toBe("'claude'");
  });

  it('appends extra PATH entries, which the sandbox needs and the host does not', () => {
    expect(
      buildPaneCommand({
        argv: ['claude'],
        extraPathEntries: ['/root/.local/bin', '/usr/local/bin'],
      }),
    ).toBe('export PATH="$PATH:/root/.local/bin:/usr/local/bin"; \'claude\'');
  });

  it('sources and removes one-shot agent environment before expanding references', () => {
    const command = buildPaneCommand({
      argv: ['tool', '${ISSUE_FLOW_AGENT_PROMPT}'],
      environmentFilePath: '/tmp/agent.env',
      expandEnvironmentRefs: ['ISSUE_FLOW_AGENT_PROMPT'],
    });
    expect(command).toBe(
      `set -a; . '/tmp/agent.env'; rm -f -- '/tmp/agent.env'; set +a; 'tool' "\${ISSUE_FLOW_AGENT_PROMPT}"`,
    );
  });
});

/**
 * The sandbox pane commands.
 *
 * Ported from the upstream's `builds docker commands that exec inside the
 * container` case, including its negative assertion: the *shell* enters the
 * container, so the agent command typed into it must **not** wrap itself in a
 * second `docker exec`.
 */
describe('the container pane commands', () => {
  it('execs into the container with the worktree as the working directory', () => {
    expect(buildDockerExecCommand('if-feature-1', '/repos/feature', 'echo hi')).toBe(
      "docker exec -it -w '/repos/feature' 'if-feature-1' /bin/sh -c 'echo hi'",
    );
  });

  it('opens a shell inside the container, sourcing the same runtime env', () => {
    const shell = buildDockerShellCommand(
      'if-feature-1',
      '/repos/feature',
      '/repos/main/.git/issue-flow/runtime.env',
      '/bin/zsh',
    );

    expect(shell).toContain("docker exec -it -w '/repos/feature' 'if-feature-1' /bin/sh -c");
    // Quoted twice on purpose: the whole bootstrap travels as one argument of
    // `/bin/sh -c`, so every inner quote is escaped by the single serializer.
    expect(shell).toContain(
      String.raw`set -a; . '\''/repos/main/.git/issue-flow/runtime.env'\''; set +a`,
    );
    expect(shell).toContain('export PATH="$PATH:/root/.local/bin:/usr/local/bin"');
    expect(shell).toContain(String.raw`exec '\''/bin/zsh'\'' -i`);
  });

  it('defaults to /bin/bash rather than the host shell, and falls back to /bin/sh', () => {
    const shell = buildDockerShellCommand(
      'if-feature-1',
      '/repos/feature',
      '/repos/main/.git/issue-flow/runtime.env',
    );

    expect(shell).toContain(String.raw`exec '\''/bin/bash'\'' -i`);
    expect(shell).toContain('elif [ -x /bin/sh ]; then exec /bin/sh -i;');
    expect(shell).toContain(String.raw`echo '\''issue-flow: no shell found in container'\''`);
  });

  it('builds an agent command that carries the PATH fallback and never docker', () => {
    const agent = buildPaneCommand({
      argv: buildTtyAgentArgv({ provider: 'codex', permission: 'autonomous', prompt: 'ship it' }),
      runtimeEnvPath: '/repos/main/.git/issue-flow/runtime.env',
      extraPathEntries: SANDBOX_PATH_ENTRIES,
    });

    expect(agent).toContain('export PATH="$PATH:/root/.local/bin:/usr/local/bin"');
    expect(agent).toContain("'codex' '--enable' 'hooks' '--yolo'");
    expect(agent).toContain("'--' 'ship it'");
    expect(agent).not.toContain('docker exec');
  });

  it('drops the two upstream PATH entries the image of this project never creates', () => {
    // Bun is not adopted (no `/root/.bun/bin`), and nothing in
    // `sandbox/Dockerfile.sandbox` installs a cargo binary.
    expect(SANDBOX_PATH_ENTRIES).toEqual(['/root/.local/bin', '/usr/local/bin']);
  });
});
