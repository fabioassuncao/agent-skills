import type { AgentPermission, AgentProviderId } from './types.js';

export type AgentLaunchMode = 'fresh' | 'resume' | 'fork';

export interface TtyAgentInvocation {
  provider: AgentProviderId;
  permission: AgentPermission;
  /** First turn. Travels in the argv, which has no delivery race to lose. */
  prompt?: string;
  systemPrompt?: string;
  model?: string | null;
  launchMode?: AgentLaunchMode;
  /** Conversation to resume. Absent with `resume` means "the most recent". */
  resumeConversationId?: string;
  /** Conversation to fork from. Required by `fork`. */
  forkFromConversationId?: string;
  /**
   * Claude only: pin the forked child to a conversation id we generated, so it
   * is known without having to discover it on disk afterwards.
   */
  pinConversationId?: string;
}

/**
 * Quote one argv element for a POSIX shell.
 *
 * Single quotes, with an embedded quote written as `'\''`. Everything else —
 * `$`, backticks, newlines, globs — is literal inside single quotes, which is
 * why this is the only escaping rule needed and why it is applied to *every*
 * element rather than to the ones that look dangerous.
 */
export function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Serialize an argv into a shell command line. The only place this happens. */
export function renderShellCommand(argv: readonly string[]): string {
  return argv.map(quoteShellArgument).join(' ');
}

/**
 * Serialize argv while expanding only an explicit allow-list of environment
 * references. Static text stays single-quoted and each allowed `$NAME` is
 * double-quoted, so its value remains one argument and is never re-evaluated
 * as shell syntax.
 */
export function renderShellCommandWithEnvironmentRefs(
  argv: readonly string[],
  variableNames: readonly string[],
): string {
  if (variableNames.length === 0) return renderShellCommand(argv);
  const allowed = new Set(variableNames);
  const reference = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
  return argv
    .map((argument) => {
      const parts: string[] = [];
      let offset = 0;
      for (const match of argument.matchAll(reference)) {
        const name = match[1] as string;
        if (!allowed.has(name)) continue;
        const index = match.index ?? 0;
        if (index > offset) parts.push(quoteShellArgument(argument.slice(offset, index)));
        parts.push(`"\${${name}}"`);
        offset = index + match[0].length;
      }
      if (offset === 0) return quoteShellArgument(argument);
      if (offset < argument.length) parts.push(quoteShellArgument(argument.slice(offset)));
      return parts.join('');
    })
    .join(' ');
}

function isAutonomous(permission: AgentPermission): boolean {
  return permission === 'autonomous';
}

function buildClaudeArgv(invocation: TtyAgentInvocation): string[] {
  const argv = ['claude'];
  if (isAutonomous(invocation.permission)) argv.push('--dangerously-skip-permissions');
  // Same translation the headless runner uses: `--allowedTools` alone does not
  // restrict a subagent, so a read-only invocation needs the plan mode.
  if (invocation.permission === 'read-only') argv.push('--permission-mode', 'plan');
  if (invocation.model) argv.push('--model', invocation.model);

  if (invocation.launchMode === 'fork' && invocation.forkFromConversationId !== undefined) {
    argv.push('--resume', invocation.forkFromConversationId, '--fork-session');
    if (invocation.pinConversationId !== undefined) {
      argv.push('--session-id', invocation.pinConversationId);
    }
  } else if (invocation.launchMode === 'resume') {
    // `--resume <id>` restores a specific conversation; `--continue` takes the
    // most recent one, which is what "resume" means with nothing to point at.
    if (invocation.resumeConversationId !== undefined) {
      argv.push('--resume', invocation.resumeConversationId);
    } else {
      argv.push('--continue');
    }
  } else {
    if (invocation.pinConversationId !== undefined) {
      argv.push('--session-id', invocation.pinConversationId);
    }
    if (invocation.systemPrompt !== undefined && invocation.systemPrompt !== '') {
      // Only on a fresh start: appending it to a resumed conversation would add
      // the instructions a second time to a session that already has them.
      argv.push('--append-system-prompt', invocation.systemPrompt);
    }
  }

  if (invocation.prompt !== undefined && invocation.prompt !== '') {
    argv.push('--', invocation.prompt);
  }
  return argv;
}

function buildCodexArgv(invocation: TtyAgentInvocation): string[] {
  // Always: without it the lifecycle hooks never fire and the agent's state
  // becomes unknowable (ADR-05).
  const argv = ['codex', '--enable', 'hooks'];
  if (isAutonomous(invocation.permission)) argv.push('--yolo');
  if (invocation.model) argv.push('--model', invocation.model);

  if (invocation.launchMode === 'fork' && invocation.forkFromConversationId !== undefined) {
    // `codex fork <id>` branches into a fresh conversation with inherited history.
    argv.push('fork', invocation.forkFromConversationId);
  } else if (invocation.launchMode === 'resume') {
    argv.push('resume');
    argv.push(
      ...(invocation.resumeConversationId !== undefined
        ? [invocation.resumeConversationId]
        : ['--last']),
    );
  } else if (invocation.systemPrompt !== undefined && invocation.systemPrompt !== '') {
    argv.push('-c', `developer_instructions=${invocation.systemPrompt}`);
  }

  if (invocation.prompt !== undefined && invocation.prompt !== '') {
    argv.push('--', invocation.prompt);
  }
  return argv;
}

/**
 * The argv of a TTY agent invocation.
 *
 * Throws for a provider with no TTY form rather than guessing one: a wrong
 * command in a pane fails in a way nobody can read, and a custom agent
 * (`agents/custom.ts`) is how any other binary is described.
 */
export function buildTtyAgentArgv(invocation: TtyAgentInvocation): string[] {
  switch (invocation.provider) {
    case 'claude':
      return buildClaudeArgv(invocation);
    case 'codex':
      return buildCodexArgv(invocation);
    default:
      throw new Error(
        `No built-in TTY command for provider '${invocation.provider}'. Describe it as a custom agent instead.`,
      );
  }
}

/**
 * Load the worktree's environment before the agent starts.
 *
 * `set -a` exports everything the file defines, so the agent and every process
 * it spawns inherit the worktree's ports and startup values; `set +a` restores
 * the shell afterwards so the pane behaves normally for whoever types in it.
 */
export function buildRuntimeBootstrap(runtimeEnvPath: string): string {
  return `set -a; . ${quoteShellArgument(runtimeEnvPath)}; set +a`;
}

export function buildManagedShellCommand(
  runtimeEnvPath: string,
  shellPath: string = process.env.SHELL || '/bin/bash',
): string {
  return `bash -lc ${quoteShellArgument(
    `${buildRuntimeBootstrap(runtimeEnvPath)}; exec ${quoteShellArgument(shellPath)} -i`,
  )}`;
}

export const SANDBOX_PATH_ENTRIES: readonly string[] = ['/root/.local/bin', '/usr/local/bin'];

export function buildDockerExecCommand(
  containerName: string,
  worktreePath: string,
  command: string,
): string {
  return `docker exec -it -w ${quoteShellArgument(worktreePath)} ${quoteShellArgument(
    containerName,
  )} /bin/sh -c ${quoteShellArgument(command)}`;
}

export function buildDockerShellCommand(
  containerName: string,
  worktreePath: string,
  runtimeEnvPath: string,
  shellPath = '/bin/bash',
): string {
  const preferred = quoteShellArgument(shellPath);
  return buildDockerExecCommand(
    containerName,
    worktreePath,
    `${buildSandboxBootstrap(runtimeEnvPath)}; if [ -x ${preferred} ]; then exec ${preferred} -i; elif [ -x /bin/sh ]; then exec /bin/sh -i; else echo 'issue-flow: no shell found in container' >&2; exit 127; fi`,
  );
}

/** The bootstrap of a command that runs inside a container: env, then `PATH`. */
function buildSandboxBootstrap(runtimeEnvPath: string): string {
  return `${buildRuntimeBootstrap(runtimeEnvPath)}; export PATH="$PATH:${SANDBOX_PATH_ENTRIES.join(
    ':',
  )}"`;
}

export interface PaneCommandInput {
  argv: readonly string[];
  /** Absent when the worktree has no runtime env — then nothing is sourced. */
  runtimeEnvPath?: string;
  /** Extra `PATH` entries, appended. The sandbox needs them; the host does not. */
  extraPathEntries?: readonly string[];
  /** One-shot environment file removed immediately after it is sourced. */
  environmentFilePath?: string;
  /** Closed set of variable references the argv is allowed to expand. */
  expandEnvironmentRefs?: readonly string[];
}

/** The full shell command a pane runs: bootstrap, then the agent. */
export function buildPaneCommand(input: PaneCommandInput): string {
  const parts: string[] = [];
  if (input.runtimeEnvPath !== undefined) parts.push(buildRuntimeBootstrap(input.runtimeEnvPath));
  if (input.environmentFilePath !== undefined) {
    const path = quoteShellArgument(input.environmentFilePath);
    parts.push(`set -a; . ${path}; rm -f -- ${path}; set +a`);
  }
  if (input.extraPathEntries !== undefined && input.extraPathEntries.length > 0) {
    parts.push(`export PATH="$PATH:${input.extraPathEntries.join(':')}"`);
  }
  parts.push(
    input.expandEnvironmentRefs === undefined
      ? renderShellCommand(input.argv)
      : renderShellCommandWithEnvironmentRefs(input.argv, input.expandEnvironmentRefs),
  );
  return parts.join('; ');
}
