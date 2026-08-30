import { execa } from 'execa';
import { registerChild } from '../core/shutdown.js';
import { createWatchdog, describeStall } from '../core/watchdog.js';
import { peekHarnessVersion } from './claude.js';
import { describeAgentFailure, wasTimedOut } from './process.js';
import {
  type AgentInvocation,
  type AgentRunner,
  type AgentRunResult,
  CURSOR_CAPABILITIES,
  type ResolvedAgentSettings,
} from './types.js';

export const CURSOR_MIN_VERSION = '2026.01.23';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toolName(call: Record<string, unknown>): { name: string; detail: string } {
  if (isRecord(call.readToolCall)) {
    const args = isRecord(call.readToolCall.args) ? call.readToolCall.args : {};
    return { name: 'Read', detail: typeof args.path === 'string' ? args.path : '' };
  }
  if (isRecord(call.writeToolCall)) {
    const args = isRecord(call.writeToolCall.args) ? call.writeToolCall.args : {};
    return { name: 'Edit', detail: typeof args.path === 'string' ? args.path : '' };
  }
  const key = Object.keys(call).find((name) => name.endsWith('ToolCall'));
  return { name: key?.replace(/ToolCall$/, '') ?? 'tool', detail: '' };
}

export function consumeCursorEvent(
  event: Record<string, unknown>,
  onEvent: AgentInvocation['onEvent'],
): { text?: string; sessionId?: string; model?: string; isError?: boolean; result?: string } {
  if (event.type === 'system' && event.subtype === 'init') {
    return {
      sessionId: typeof event.session_id === 'string' ? event.session_id : undefined,
      model: typeof event.model === 'string' ? event.model : undefined,
    };
  }
  if (event.type === 'assistant') {
    const message = isRecord(event.message) ? event.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const texts: string[] = [];
    for (const block of content) {
      if (isRecord(block) && typeof block.text === 'string') texts.push(block.text);
    }
    const text = texts.join('');
    if (text && onEvent) onEvent({ kind: 'text', text });
    return { text };
  }
  if (event.type === 'tool_call' && event.subtype === 'started') {
    const call = isRecord(event.tool_call) ? event.tool_call : {};
    const { name, detail } = toolName(call);
    onEvent?.({ kind: 'tool', name, ...(detail === '' ? {} : { detail }) });
    return {};
  }
  if (event.type === 'result') {
    return {
      result: typeof event.result === 'string' ? event.result : '',
      sessionId: typeof event.session_id === 'string' ? event.session_id : undefined,
      isError: event.is_error === true,
    };
  }
  return {};
}

export function parseCursorStream(
  raw: string,
  onEvent?: AgentInvocation['onEvent'],
): {
  result: string;
  isError: boolean;
  sessionId: string | null;
  model: string | null;
  text: string;
} {
  let result = '';
  let isError = false;
  let sessionId: string | null = null;
  let model: string | null = null;
  const texts: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const event = JSON.parse(trimmed) as unknown;
      if (!isRecord(event)) continue;
      const seen = consumeCursorEvent(event, onEvent);
      if (seen.result !== undefined) result = seen.result;
      if (seen.isError === true) isError = true;
      if (seen.sessionId) sessionId = seen.sessionId;
      if (seen.model) model = seen.model;
      if (seen.text) texts.push(seen.text);
    } catch {
      // Malformed NDJSON is ignored, like the other runners.
    }
  }
  return { result, isError, sessionId, model, text: texts.join('') };
}

export function buildCursorArgv(
  invocation: AgentInvocation,
  settings: ResolvedAgentSettings,
): { command: string; args: string[] } {
  const args = ['-p', '--output-format', 'stream-json'];
  args.push('--workspace', invocation.workingDirectory ?? process.cwd());
  if (settings.model) args.push('--model', settings.model);
  if (invocation.permission === 'read-only') {
    args.push('--mode', 'plan');
  } else {
    args.push('--force');
  }
  if (settings.cursor.sandbox !== undefined) {
    args.push('--sandbox', settings.cursor.sandbox);
  }
  if (settings.cursor.approveMcps === true) {
    args.push('--approve-mcps');
  }
  args.push(invocation.prompt);
  return { command: 'cursor-agent', args };
}

export class CursorRunner implements AgentRunner {
  readonly id = 'cursor' as const;
  readonly capabilities = CURSOR_CAPABILITIES;

  versionCommand(): { command: string; args: string[] } {
    return { command: 'cursor-agent', args: ['--version'] };
  }

  authCommand(): { command: string; args: string[] } {
    return { command: 'cursor-agent', args: ['status'] };
  }

  async run(invocation: AgentInvocation, settings: ResolvedAgentSettings): Promise<AgentRunResult> {
    const { command, args } = buildCursorArgv(invocation, settings);
    const startTime = Date.now();
    const agent = { provider: this.id, model: settings.model } as const;

    let cleanup: (() => void) | null = null;
    try {
      const subprocess = execa(command, args, {
        reject: false,
        timeout: invocation.timeout,
        stripFinalNewline: false,
        stdin: 'ignore',
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
      // The stream can reject; the watchdog timer and the shutdown registry
      // must not outlive the call either way.
      cleanup = () => {
        watchdog.stop();
        unregister();
      };

      const chunks: string[] = [];
      if (subprocess.stdout) {
        subprocess.stdout.on('data', (chunk: Buffer | string) => {
          watchdog.beat();
          const text = chunk.toString();
          chunks.push(text);
          invocation.onLine?.(text);
        });
      }
      if (subprocess.stderr) {
        subprocess.stderr.on('data', () => {
          watchdog.beat();
        });
      }

      const proc = await subprocess;
      watchdog.stop();
      unregister();

      const stdout = chunks.join('') || proc.stdout?.toString() || '';
      const stderr = proc.stderr?.toString() ?? '';
      const parsed = parseCursorStream(stdout, invocation.onEvent);
      const rawOutput = stdout + (stderr ? `\n${stderr}` : '');
      const exitCode = proc.exitCode ?? 1;
      const elapsedMs = Date.now() - startTime;
      const timedOut = wasTimedOut(proc, invocation.timeout, elapsedMs);
      const authFailed = /authentication required/i.test(stderr) && stdout.trim() === '';
      const stalled = watchdog.stalled;
      const success = exitCode === 0 && parsed.result !== '' && !parsed.isError && !timedOut;

      // A stall has to survive as text in `rawOutput`: that is the field the
      // executor forwards to `classify()`, and `error` never reaches it. Same
      // shape as claude.ts and codex.ts.
      if (stalled) {
        return {
          success: false,
          result: '',
          rawOutput: describeStall(watchdog.silentMs, 'cursor-agent'),
          exitCode: exitCode === 0 ? 1 : exitCode,
          usage: null,
          error: describeStall(watchdog.silentMs, 'cursor-agent'),
          agent: { provider: this.id, model: parsed.model ?? settings.model },
          sessionId: parsed.sessionId ?? undefined,
          harnessVersion: peekHarnessVersion(this.id),
        };
      }

      return {
        success,
        result: parsed.result || parsed.text,
        rawOutput,
        exitCode: timedOut ? 1 : exitCode,
        usage: null,
        error: success
          ? null
          : authFailed
            ? stderr.trim()
            : describeAgentFailure(
                proc,
                stderr || rawOutput,
                invocation.timeout,
                elapsedMs,
                command,
              ),
        agent: { provider: this.id, model: parsed.model ?? settings.model },
        sessionId: parsed.sessionId ?? undefined,
        harnessVersion: peekHarnessVersion(this.id),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        result: '',
        rawOutput: message,
        exitCode: 1,
        usage: null,
        error: message,
        agent,
        harnessVersion: peekHarnessVersion(this.id),
      };
    } finally {
      cleanup?.();
    }
  }
}
