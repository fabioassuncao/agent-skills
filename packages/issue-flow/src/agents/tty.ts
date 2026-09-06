import type { AgentPermission, AgentProviderId } from './types.js';

/**
 * The command that starts an agent as a TUI inside a tmux pane.
 *
 * Adapted from WebMux `backend/src/services/agent-service.ts` @ d8c9d5f. The
 * upstream builds a **shell string** and quotes it by hand; §7.2 of the
 * absorption plan keeps Issue Flow's model instead, and this module is where the
 * two meet:
 *
 * - the command is assembled as **argv** (ADR-04), which is what makes it immune
 *   to injection and what the characterization test compares;
 * - it is serialized to a shell string exactly **once**, at the tmux boundary,
 *   because `send-keys` accepts nothing else. Serializing an argv for a
 *   transport that only carries strings is not the same thing as assembling a
 *   command by concatenating strings — there is one quoting function, it is
 *   applied to every element without exception, and no caller ever hands it a
 *   pre-joined fragment.
 *
 * Two details from the upstream carry their own reason and are kept exactly:
 *
 * - **The prompt goes after `--`.** Not for quoting: it means the TUI receives
 *   the prompt as its first turn, before its input loop starts, which avoids the
 *   paste/Enter race that hits an interactive TUI that is not ready yet.
 * - **`codex` always gets `--enable hooks`.** Without it the lifecycle hooks of
 *   phase 2 never fire, and agent state falls back to being unknowable.
 */

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
 * Whether the invocation runs without asking for permission.
 *
 * The upstream has a `yolo` boolean; Issue Flow has three semantic levels
 * (§45.2-L keeps them). Only `autonomous` maps to skipping permission — the
 * other two keep the harness asking, which is the point of the distinction.
 */
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
  } else if (invocation.systemPrompt !== undefined && invocation.systemPrompt !== '') {
    // Only on a fresh start: appending it to a resumed conversation would add
    // the instructions a second time to a session that already has them.
    argv.push('--append-system-prompt', invocation.systemPrompt);
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

export interface PaneCommandInput {
  argv: readonly string[];
  /** Absent when the worktree has no runtime env — then nothing is sourced. */
  runtimeEnvPath?: string;
  /** Extra `PATH` entries, appended. The sandbox needs them; the host does not. */
  extraPathEntries?: readonly string[];
}

/** The full shell command a pane runs: bootstrap, then the agent. */
export function buildPaneCommand(input: PaneCommandInput): string {
  const parts: string[] = [];
  if (input.runtimeEnvPath !== undefined) parts.push(buildRuntimeBootstrap(input.runtimeEnvPath));
  if (input.extraPathEntries !== undefined && input.extraPathEntries.length > 0) {
    parts.push(`export PATH="$PATH:${input.extraPathEntries.join(':')}"`);
  }
  parts.push(renderShellCommand(input.argv));
  return parts.join('; ');
}
