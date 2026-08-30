import { execa } from 'execa';
import { parseUsage } from '../core/metrics.js';
import { registerChild } from '../core/shutdown.js';
import { readClaudeStream } from '../core/stream.js';
import { createWatchdog, describeStall } from '../core/watchdog.js';
import { pushRepeatedFlag } from './argv.js';
import { describeAgentFailure, reachedTimeout } from './process.js';
import {
  type AgentInvocation,
  type AgentRunner,
  type AgentRunResult,
  CLAUDE_CAPABILITIES,
  type ResolvedAgentSettings,
} from './types.js';

/**
 * Tools that let a "read-only" Claude session write anyway: a subagent
 * (`Agent`/`Task`) inherits the full toolset, `Monitor` runs shell in the
 * background, `NotebookEdit` writes files. Deny-list, not allow-list — the
 * evidence is in the issue comments (`awslabs/cli-agent-orchestrator`).
 */
const READ_ONLY_DENIED_TOOLS = [
  'Agent',
  'Task',
  'Monitor',
  'NotebookEdit',
  'Edit',
  'Write',
] as const;

function toolContext(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return shortPath(typeof input.file_path === 'string' ? input.file_path : undefined);
    case 'Glob':
    case 'Grep':
      return typeof input.pattern === 'string' ? input.pattern : '';
    case 'Bash': {
      const cmd = typeof input.command === 'string' ? input.command : '';
      return cmd.length > 60 ? `${cmd.substring(0, 57)}...` : cmd;
    }
    default:
      return '';
  }
}

function shortPath(filePath: string | undefined): string {
  if (!filePath) return '';
  const cwd = process.cwd();
  if (filePath.startsWith(cwd)) return filePath.substring(cwd.length + 1);
  const parts = filePath.split('/');
  return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : filePath;
}

function emitClaudeEvent(
  event: Record<string, unknown>,
  onEvent: AgentInvocation['onEvent'],
): void {
  if (!onEvent) return;
  if (event.type !== 'assistant') return;
  const message = event.message;
  if (typeof message !== 'object' || message === null) return;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const item = block as {
      type?: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    };
    if (item.type === 'text' && item.text) {
      onEvent({ kind: 'text', text: item.text });
    }
    if (item.type === 'tool_use' && item.name) {
      const detail = item.input ? toolContext(item.name, item.input) : '';
      onEvent({ kind: 'tool', name: item.name, ...(detail ? { detail } : {}) });
    }
  }
}

/**
 * Build the argv for one Claude invocation.
 *
 * Unconfigured `workspace` matches the historical `runHeadless` argv
 * byte for byte. Unconfigured `autonomous` matches `executeClaude`.
 * `read-only` is the one translation that changed: `--allowedTools` alone
 * does not restrict, so the runner adds `--permission-mode plan` and a
 * deny-list. `--model` and `--setting-sources` appear only when resolved.
 */
export function buildClaudeArgv(
  invocation: AgentInvocation,
  settings: ResolvedAgentSettings,
): { args: string[]; stdinMode: 'ignore' | 'prompt' } {
  if (invocation.permission === 'autonomous') {
    const args = [
      '--dangerously-skip-permissions',
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
    ];
    if (settings.model) args.push('--model', settings.model);
    if (settings.claude.ignoreUserConfig === true) {
      args.push('--setting-sources', 'project');
    }
    pushRepeatedFlag(args, '--add-dir', invocation.addDirs);
    return { args, stdinMode: 'prompt' };
  }

  const maxTurns = invocation.maxTurns ?? 10;
  const args = [
    '-p',
    invocation.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--max-turns',
    String(maxTurns),
  ];

  pushRepeatedFlag(args, '--allowedTools', invocation.allowedTools);
  pushRepeatedFlag(args, '--add-dir', invocation.addDirs);

  if (invocation.permission === 'read-only') {
    args.push('--permission-mode', 'plan');
    const allowed = new Set(invocation.allowedTools ?? []);
    const denied = READ_ONLY_DENIED_TOOLS.filter((tool) => !allowed.has(tool));
    if (denied.length > 0) {
      args.push('--disallowedTools', ...denied);
    }
  }

  if (settings.model) args.push('--model', settings.model);
  if (settings.claude.ignoreUserConfig === true) {
    args.push('--setting-sources', 'project');
  }

  return { args, stdinMode: 'ignore' };
}

export class ClaudeCodeRunner implements AgentRunner {
  readonly id = 'claude' as const;
  readonly capabilities = CLAUDE_CAPABILITIES;

  versionCommand(): { command: string; args: string[] } {
    return { command: 'claude', args: ['--version'] };
  }

  async run(invocation: AgentInvocation, settings: ResolvedAgentSettings): Promise<AgentRunResult> {
    const { args, stdinMode } = buildClaudeArgv(invocation, settings);
    const execaOptions = {
      reject: false as const,
      timeout: invocation.timeout,
      stripFinalNewline: false as const,
      ...(stdinMode === 'prompt' ? { input: invocation.prompt } : { stdin: 'ignore' as const }),
      ...(invocation.workingDirectory ? { cwd: invocation.workingDirectory } : {}),
    };

    const startTime = Date.now();
    const agent = { provider: this.id, model: settings.model } as const;
    const base = {
      agent,
      harnessVersion: peekHarnessVersion(this.id),
    };

    try {
      const subprocess = execa('claude', args, execaOptions);
      const unregister = registerChild({
        kill: (signal) => subprocess.kill(signal),
        done: subprocess.then(
          () => undefined,
          () => undefined,
        ),
      });

      const watchdog = createWatchdog({
        ...(invocation.inactivityTimeoutMs === undefined
          ? {}
          : { inactivityTimeoutMs: invocation.inactivityTimeoutMs }),
        child: {
          kill: (signal) => subprocess.kill(signal),
          done: subprocess.then(
            () => undefined,
            () => undefined,
          ),
        },
      });

      let streamed: Awaited<ReturnType<typeof readClaudeStream>> = {
        result: '',
        isError: false,
        usage: null,
        events: 0,
        raw: '',
      };
      if (subprocess.stdout) {
        streamed = await readClaudeStream(subprocess.stdout, {
          onLine: (line) => {
            watchdog.beat();
            invocation.onLine?.(line);
          },
          onEvent: (event) => emitClaudeEvent(event, invocation.onEvent),
        });
      }

      const proc = await subprocess;
      watchdog.stop();
      unregister();

      const stdout = streamed.raw === '' ? (proc.stdout?.toString() ?? '') : streamed.raw;
      const stderr = proc.stderr?.toString() ?? '';
      const rawOutput = stdout + (stderr ? `\n${stderr}` : '');
      const exitCode = proc.exitCode ?? 1;
      const elapsedMs = Date.now() - startTime;

      if (watchdog.stalled) {
        return {
          success: false,
          result: '',
          rawOutput: describeStall(watchdog.silentMs),
          exitCode: exitCode === 0 ? 1 : exitCode,
          usage: null,
          error: describeStall(watchdog.silentMs),
          ...base,
        };
      }

      if (exitCode !== 0) {
        return {
          success: false,
          result: '',
          rawOutput,
          exitCode,
          usage: null,
          error: describeAgentFailure(
            proc,
            stderr || stdout,
            invocation.timeout,
            elapsedMs,
            'claude',
          ),
          ...base,
        };
      }

      if (streamed.result !== '') {
        return {
          success: !streamed.isError,
          result: streamed.result,
          rawOutput,
          exitCode,
          usage: streamed.usage,
          error: streamed.isError ? streamed.result : null,
          ...base,
        };
      }

      try {
        const parsed = JSON.parse(stdout) as Record<string, unknown>;
        const resultText = typeof parsed.result === 'string' ? parsed.result : stdout;
        const isError = parsed.is_error === true;
        return {
          success: !isError,
          result: resultText,
          rawOutput,
          exitCode,
          usage: parseUsage(parsed),
          error: isError ? resultText : null,
          ...base,
        };
      } catch {
        return {
          success: true,
          result: rawOutput,
          rawOutput,
          exitCode,
          usage: null,
          error: null,
          ...base,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const elapsedMs = Date.now() - startTime;
      const timedOut = message.includes('timed out') || message.includes('ETIMEDOUT');
      return {
        success: false,
        result: '',
        rawOutput: message,
        exitCode: 1,
        usage: null,
        error: timedOut
          ? describeAgentFailure(
              { timedOut: reachedTimeout(invocation.timeout, elapsedMs) },
              message,
              invocation.timeout,
              elapsedMs,
              'claude',
            )
          : message,
        ...base,
      };
    }
  }
}

/** Process-wide harness versions, filled by `ensureHarnessVersion`. */
const harnessVersions = new Map<string, string | null>();

export function peekHarnessVersion(id: string): string | null | undefined {
  return harnessVersions.has(id) ? (harnessVersions.get(id) ?? null) : undefined;
}

export function cacheHarnessVersion(id: string, version: string | null): void {
  harnessVersions.set(id, version);
}

export function resetHarnessVersionCache(): void {
  harnessVersions.clear();
}
