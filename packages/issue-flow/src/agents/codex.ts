import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { parseCodexUsage } from '../core/metrics.js';
import { registerChild } from '../core/shutdown.js';
import { createWatchdog, describeStall } from '../core/watchdog.js';
import { printWarning } from '../ui/logger.js';
import { formatCodexConfigValue, pushRepeatedFlag } from './argv.js';
import { peekHarnessVersion } from './claude.js';
import { describeAgentFailure, reachedTimeout } from './process.js';
import {
  type AgentEvent,
  type AgentInvocation,
  type AgentRunner,
  type AgentRunResult,
  CODEX_CAPABILITIES,
  type CodexSandbox,
  type ResolvedAgentSettings,
} from './types.js';

const BANNED_CODEX_FLAGS = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
] as const;

function sandboxFor(
  permission: AgentInvocation['permission'],
  configured: CodexSandbox | undefined,
): CodexSandbox {
  if (configured === 'danger-full-access') return 'danger-full-access';
  if (permission === 'read-only') return 'read-only';
  return 'workspace-write';
}

function shortPath(filePath: string | undefined): string {
  if (!filePath) return '';
  const cwd = process.cwd();
  if (filePath.startsWith(cwd)) return filePath.substring(cwd.length + 1);
  const parts = filePath.split('/');
  return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : filePath;
}

function truncateCommand(command: string): string {
  return command.length > 60 ? `${command.substring(0, 57)}...` : command;
}

/**
 * Build the argv for one `codex exec` invocation.
 *
 * `--sandbox` is always explicit. The prompt goes on stdin (`-`) so a large
 * Issue Flow prompt never hits `ARG_MAX` and the process never blocks waiting
 * for an inherited stdin. Banned `--dangerously-bypass-*` flags have no path
 * that can introduce them.
 */
export function buildCodexArgv(
  invocation: AgentInvocation,
  settings: ResolvedAgentSettings,
  outputFile: string,
): string[] {
  const sandbox = sandboxFor(invocation.permission, settings.codex.sandbox);
  if (sandbox === 'danger-full-access') {
    printWarning(
      'agent.codex.sandbox is "danger-full-access": the Codex sandbox is off for this invocation.',
    );
  }

  const args = [
    'exec',
    '--json',
    '--output-last-message',
    outputFile,
    '--sandbox',
    sandbox,
    '--color',
    'never',
  ];

  if (invocation.workingDirectory) args.push('--cd', invocation.workingDirectory);
  pushRepeatedFlag(args, '--add-dir', invocation.addDirs);
  if (settings.model) args.push('--model', settings.model);
  if (settings.codex.reasoningEffort) {
    args.push('-c', `model_reasoning_effort=${settings.codex.reasoningEffort}`);
  }
  if (settings.codex.ignoreUserConfig === true) args.push('--ignore-user-config');
  if (settings.codex.skipGitRepoCheck === true) args.push('--skip-git-repo-check');
  for (const [key, value] of Object.entries(settings.codex.configOverrides ?? {})) {
    args.push('-c', `${key}=${formatCodexConfigValue(value)}`);
  }
  args.push('-');

  for (const banned of BANNED_CODEX_FLAGS) {
    if (args.includes(banned)) {
      throw new Error(`Internal error: banned Codex flag ${banned} reached argv.`);
    }
  }
  return args;
}

interface CodexParseState {
  result: string;
  lastAgentMessage: string;
  usage: ReturnType<typeof parseCodexUsage>;
  sessionId?: string;
  failed: boolean;
  error: string | null;
  completed: boolean;
}

function emptyCodexState(): CodexParseState {
  return {
    result: '',
    lastAgentMessage: '',
    usage: null,
    failed: false,
    error: null,
    completed: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * Consume one Codex JSONL event. `item.type === 'error'` is a warning, never
 * a failure — skill-context notices arrive that way on successful runs.
 */
export function consumeCodexEvent(
  event: Record<string, unknown>,
  state: CodexParseState,
  onEvent?: (event: AgentEvent) => void,
): void {
  const type = event.type;
  if (type === 'thread.started' && typeof event.thread_id === 'string') {
    state.sessionId = event.thread_id;
    return;
  }
  if (type === 'turn.completed') {
    state.completed = true;
    state.usage = parseCodexUsage(event.usage) ?? state.usage;
    return;
  }
  if (type === 'turn.failed') {
    state.failed = true;
    const err = asRecord(event.error);
    state.error = typeof err?.message === 'string' ? err.message : 'turn.failed';
    return;
  }
  if (type === 'error') {
    state.failed = true;
    state.error = typeof event.message === 'string' ? event.message : 'error';
    return;
  }

  const item = asRecord(event.item);
  if (!item) return;
  const itemType = item.type;

  if (type === 'item.completed' && itemType === 'agent_message' && typeof item.text === 'string') {
    state.lastAgentMessage = item.text;
    onEvent?.({ kind: 'text', text: item.text });
    return;
  }
  if (type === 'item.completed' && itemType === 'error' && typeof item.message === 'string') {
    onEvent?.({ kind: 'text', text: item.message });
    return;
  }
  if (type === 'item.started' && itemType === 'command_execution') {
    const command = typeof item.command === 'string' ? item.command : '';
    onEvent?.({ kind: 'tool', name: 'Bash', detail: truncateCommand(command) });
    return;
  }
  if (type === 'item.started' && itemType === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const first = asRecord(changes[0]);
    const path = typeof first?.path === 'string' ? first.path : '';
    onEvent?.({ kind: 'tool', name: 'Edit', detail: shortPath(path) });
    return;
  }
  if (type === 'item.completed' && itemType === 'web_search') {
    const query = typeof item.query === 'string' ? item.query : '';
    onEvent?.({ kind: 'tool', name: 'WebSearch', ...(query ? { detail: query } : {}) });
    return;
  }
  if (type === 'item.completed' && itemType === 'mcp_tool_call') {
    const server = typeof item.server === 'string' ? item.server : '';
    const tool = typeof item.tool === 'string' ? item.tool : '';
    const name = [server, tool].filter(Boolean).join('.') || 'mcp';
    onEvent?.({ kind: 'tool', name });
  }
}

export function parseCodexStream(
  lines: string[],
  onEvent?: (event: AgentEvent) => void,
): CodexParseState {
  const state = emptyCodexState();
  for (const line of lines) {
    if (line.trim() === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(event);
    if (!record) continue;
    consumeCodexEvent(record, state, onEvent);
  }
  return state;
}

export class CodexRunner implements AgentRunner {
  readonly id = 'codex' as const;
  readonly capabilities = CODEX_CAPABILITIES;

  versionCommand(): { command: string; args: string[] } {
    return { command: 'codex', args: ['--version'] };
  }

  authCommand(): { command: string; args: string[] } {
    return { command: 'codex', args: ['login', 'status'] };
  }

  async run(invocation: AgentInvocation, settings: ResolvedAgentSettings): Promise<AgentRunResult> {
    const tmp = await mkdtemp(join(tmpdir(), 'issue-flow-codex-'));
    const outputFile = join(tmp, 'last-message.txt');
    const args = buildCodexArgv(invocation, settings, outputFile);
    const agent = { provider: this.id, model: settings.model } as const;
    const base = { agent, harnessVersion: peekHarnessVersion(this.id) };
    const startTime = Date.now();

    try {
      const subprocess = execa('codex', args, {
        input: invocation.prompt,
        reject: false,
        timeout: invocation.timeout,
        stripFinalNewline: false,
        ...(invocation.workingDirectory ? { cwd: invocation.workingDirectory } : {}),
      });
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

      const collected: string[] = [];
      if (subprocess.stdout) {
        const { createInterface } = await import('node:readline');
        const lines = createInterface({ input: subprocess.stdout });
        for await (const line of lines) {
          watchdog.beat();
          invocation.onLine?.(line);
          if (line.trim() !== '') collected.push(line);
        }
      }

      const proc = await subprocess;
      watchdog.stop();
      unregister();

      const stdout = collected.join('\n');
      const stderr = proc.stderr?.toString() ?? '';
      const rawOutput = stdout + (stderr ? `\n${stderr}` : '');
      const exitCode = proc.exitCode ?? 1;
      const elapsedMs = Date.now() - startTime;
      const parsed = parseCodexStream(collected, invocation.onEvent);

      let lastMessage = '';
      try {
        lastMessage = (await readFile(outputFile, 'utf-8')).trimEnd();
      } catch {
        lastMessage = '';
      }
      const resultText = lastMessage || parsed.lastAgentMessage;

      if (watchdog.stalled) {
        return {
          success: false,
          result: '',
          rawOutput: describeStall(watchdog.silentMs),
          exitCode: exitCode === 0 ? 1 : exitCode,
          usage: null,
          error: describeStall(watchdog.silentMs),
          sessionId: parsed.sessionId,
          ...base,
        };
      }

      const failureText = describeAgentFailure(
        proc,
        stderr || stdout,
        invocation.timeout,
        elapsedMs,
        'codex',
      );

      if (exitCode !== 0 || parsed.failed) {
        return {
          success: false,
          result: resultText,
          rawOutput,
          exitCode: exitCode === 0 ? 1 : exitCode,
          usage: parsed.usage,
          error: parsed.error ?? failureText,
          sessionId: parsed.sessionId,
          ...base,
        };
      }

      return {
        success: parsed.completed && !parsed.failed,
        result: resultText,
        rawOutput,
        exitCode,
        usage: parsed.usage,
        error: parsed.failed ? parsed.error : null,
        sessionId: parsed.sessionId,
        ...base,
      };
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
              'codex',
            )
          : message,
        ...base,
      };
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
