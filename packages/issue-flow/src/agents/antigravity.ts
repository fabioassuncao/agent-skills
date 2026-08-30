import { execa } from 'execa';
import { registerChild } from '../core/shutdown.js';
import { createWatchdog, describeStall } from '../core/watchdog.js';
import { peekHarnessVersion } from './claude.js';
import { describeAgentFailure, wasTimedOut } from './process.js';
import {
  type AgentInvocation,
  type AgentRunner,
  type AgentRunResult,
  type AgentUsage,
  ANTIGRAVITY_CAPABILITIES,
  type AntigravitySettings,
  type ResolvedAgentSettings,
} from './types.js';

export const ANTIGRAVITY_MIN_VERSION = '1.1.22';
export const DEFAULT_EXECUTE_TIMEOUT_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_MAX_PROMPT_BYTES = 100_000;

const TOOL_NAMES: Record<string, string> = {
  run_command: 'Bash',
  command_status: 'Bash',
  view_file: 'Read',
  read_resource: 'Read',
  write_to_file: 'Edit',
  replace_file_content: 'Edit',
  multi_replace_file_content: 'Edit',
  notebook_edit: 'Edit',
  grep_search: 'Grep',
  find_by_name: 'Glob',
  list_dir: 'Glob',
  read_url_content: 'WebFetch',
  open_browser_url: 'WebFetch',
};

export type AntigravityStatus = 'SUCCESS' | 'ERROR' | 'CANCELED' | 'INTERRUPTED' | 'WAITING';

export interface AntigravityParsed {
  result: string;
  status: AntigravityStatus | null;
  sessionId: string | null;
  model: string | null;
  usage: AgentUsage | null;
  seenResult: boolean;
  permissionDenied: { tool: string; message: string } | null;
  warnings: string[];
  error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function formatPrintTimeout(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  let out = '';
  if (hours > 0) out += `${hours}h`;
  if (minutes > 0 || hours > 0) out += `${minutes}m`;
  out += `${seconds}s`;
  return out;
}

export function parseDurationMs(value: string | number | null | undefined): number | null {
  if (value === undefined) return DEFAULT_EXECUTE_TIMEOUT_MS;
  if (value === null) return null;
  if (typeof value === 'number') return value > 0 ? value : null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '0') return null;
  const match = trimmed.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (!match || match[0] === '') return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  const ms = ((hours * 60 + minutes) * 60 + seconds) * 1000;
  return ms > 0 ? ms : null;
}

export function resolveAntigravityTimeoutMs(
  invocation: Pick<AgentInvocation, 'timeout'>,
  settings: Pick<ResolvedAgentSettings, 'antigravity'>,
): number | null {
  if (invocation.timeout > 0) return invocation.timeout;
  return parseDurationMs(settings.antigravity.executeTimeout);
}

export function compareVersions(actual: string, minimum: string): number {
  const left = actual
    .replace(/^v/i, '')
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
  const right = minimum
    .replace(/^v/i, '')
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const a = left[i] ?? 0;
    const b = right[i] ?? 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

export function normalizeAntigravityTool(name: string): string {
  if (name.startsWith('call_mcp_tool')) return name;
  return TOOL_NAMES[name] ?? name;
}

export function parseAntigravityUsage(
  usage: unknown,
  numTurns: number | undefined,
): AgentUsage | null {
  if (!isRecord(usage)) return null;
  if (numTurns === 0) return null;
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  const cacheRead = usage.cache_read_tokens;
  const result: AgentUsage = {};
  if (typeof input === 'number' && Number.isFinite(input)) result.inputTokens = input;
  if (typeof output === 'number' && Number.isFinite(output)) result.outputTokens = output;
  if (typeof cacheRead === 'number' && Number.isFinite(cacheRead)) {
    result.cacheReadTokens = cacheRead;
  }
  if (typeof numTurns === 'number' && Number.isFinite(numTurns)) result.numTurns = numTurns;
  if (Object.keys(result).length === 0) return null;
  return result;
}

function isPermissionDenial(message: string): boolean {
  return /permission check failed|user denied permission/i.test(message);
}

function mainParameter(parameters: Record<string, unknown>): string {
  for (const key of ['CommandLine', 'TargetFile', 'Path', 'Query', 'Url', 'url']) {
    const value = parameters[key];
    if (typeof value === 'string' && value !== '') {
      return value.length > 80 ? `${value.slice(0, 77)}...` : value;
    }
  }
  return '';
}

export function consumeAntigravityEvent(
  event: Record<string, unknown>,
  onEvent: AgentInvocation['onEvent'],
  acc: AntigravityParsed,
): void {
  if (event.event === 'init') {
    if (typeof event.conversation_id === 'string') acc.sessionId = event.conversation_id;
    return;
  }

  if (event.event === 'step_update') {
    const step = isRecord(event.step_update) ? event.step_update : {};
    if (typeof step.text_delta === 'string' && step.text_delta !== '') {
      onEvent?.({ kind: 'text', text: step.text_delta });
    }
    if (step.step_type === 'tool') {
      const rawName = typeof step.tool_name === 'string' ? step.tool_name : 'tool';
      const info = isRecord(step.tool_info) ? step.tool_info : {};
      const parameters = isRecord(info.parameters) ? info.parameters : {};
      const detail = mainParameter(parameters);
      const name =
        rawName === 'call_mcp_tool' ? mcpToolName(parameters) : normalizeAntigravityTool(rawName);
      if (step.state === 'ACTIVE') {
        onEvent?.({ kind: 'tool', name, ...(detail === '' ? {} : { detail }) });
      }
      if (step.state === 'ERROR') {
        const err = isRecord(info.error) ? info.error : {};
        const message = typeof err.message === 'string' ? err.message : 'TOOL_ERROR';
        if (isPermissionDenial(message)) {
          acc.permissionDenied = { tool: rawName, message };
        } else {
          acc.warnings.push(`TOOL_ERROR on ${rawName}: ${message}`);
        }
      }
    }
    return;
  }

  if (event.event === 'result') {
    acc.seenResult = true;
    const result = isRecord(event.result) ? event.result : event;
    if (typeof result.conversation_id === 'string') acc.sessionId = result.conversation_id;
    if (typeof result.response === 'string') acc.result = result.response;
    if (typeof result.error === 'string' && result.error !== '') acc.error = result.error;
    if (typeof result.status === 'string') {
      acc.status = result.status as AntigravityStatus;
    }
    const numTurns = typeof result.num_turns === 'number' ? result.num_turns : undefined;
    acc.usage = parseAntigravityUsage(result.usage, numTurns);
  }
}

function mcpToolName(parameters: Record<string, unknown>): string {
  const server = typeof parameters.server === 'string' ? parameters.server : '';
  const tool = typeof parameters.tool === 'string' ? parameters.tool : '';
  if (server && tool) return `${server}/${tool}`;
  if (tool) return tool;
  if (server) return server;
  return 'call_mcp_tool';
}

export function parseAntigravityStream(
  raw: string,
  onEvent?: AgentInvocation['onEvent'],
): AntigravityParsed {
  const acc: AntigravityParsed = {
    result: '',
    status: null,
    sessionId: null,
    model: null,
    usage: null,
    seenResult: false,
    permissionDenied: null,
    warnings: [],
    error: null,
  };
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const event = JSON.parse(trimmed) as unknown;
      if (!isRecord(event)) continue;
      consumeAntigravityEvent(event, onEvent, acc);
    } catch {
      // Malformed NDJSON is ignored, like the other runners.
    }
  }
  return acc;
}

export function maxPromptBytesOf(settings: AntigravitySettings): number {
  return settings.maxPromptBytes ?? DEFAULT_MAX_PROMPT_BYTES;
}

export function buildAntigravityArgv(
  invocation: AgentInvocation,
  settings: ResolvedAgentSettings,
): { command: string; args: string[] } | { error: string } {
  const timeoutMs = resolveAntigravityTimeoutMs(invocation, settings);
  if (timeoutMs === null) {
    return {
      error:
        'configuration: Antigravity has nativeTimeout and received timeout: 0 without a ceiling. Set agent.antigravity.executeTimeout (default 4h).',
    };
  }

  const promptBytes = Buffer.byteLength(invocation.prompt, 'utf8');
  const limit = maxPromptBytesOf(settings.antigravity);
  if (promptBytes > limit) {
    return {
      error: `configuration: prompt exceeds Antigravity argv limit (${promptBytes} bytes > ${limit} maxPromptBytes). The promptChannel is argv; shorten the prompt or raise agent.antigravity.maxPromptBytes.`,
    };
  }

  const workspace = invocation.workingDirectory ?? process.cwd();
  const args = [
    '-p',
    invocation.prompt,
    '--output-format',
    'stream-json',
    '--print-timeout',
    formatPrintTimeout(timeoutMs),
    '--add-dir',
    workspace,
    '--dangerously-skip-permissions',
    '--disable-slash-commands',
    '--mode',
    invocation.permission === 'read-only' ? 'plan' : 'accept-edits',
  ];
  for (const dir of invocation.addDirs ?? []) {
    args.push('--add-dir', dir);
  }
  if (settings.model) args.push('--model', settings.model);
  if (settings.antigravity.effort) args.push('--effort', settings.antigravity.effort);
  if (settings.antigravity.sandbox === true) args.push('--sandbox');
  return { command: 'agy', args };
}

export function antigravityRunVerdict(input: {
  exitCode: number;
  parsed: AntigravityParsed;
  timedOut: boolean;
}): { success: boolean; error: string | null } {
  if (input.parsed.permissionDenied) {
    return {
      success: false,
      error: `configuration: permission check failed for ${input.parsed.permissionDenied.tool}. --dangerously-skip-permissions is required so Antigravity does not finish SUCCESS without writing. ${input.parsed.permissionDenied.message}`,
    };
  }
  if (input.parsed.status === 'WAITING') {
    return {
      success: false,
      error:
        'configuration: Antigravity ended waiting for human input (status: WAITING). Headless runs cannot continue from a prompt.',
    };
  }
  if (input.parsed.status === 'CANCELED' || input.parsed.status === 'INTERRUPTED') {
    return { success: false, error: `Antigravity was ${input.parsed.status.toLowerCase()}.` };
  }
  if (!input.parsed.seenResult) {
    return {
      success: false,
      error: 'configuration: Antigravity finished without a result event in the stream.',
    };
  }
  if (
    input.parsed.status === 'ERROR' ||
    input.parsed.status !== 'SUCCESS' ||
    input.exitCode !== 0 ||
    input.timedOut
  ) {
    return {
      success: false,
      error: input.parsed.error ?? `agy exited with code ${input.exitCode}`,
    };
  }
  return { success: true, error: null };
}

function configurationFailure(
  agent: AgentRunResult['agent'],
  message: string,
  rawOutput = message,
): AgentRunResult {
  return {
    success: false,
    result: '',
    rawOutput,
    exitCode: 1,
    usage: null,
    error: message,
    agent,
    harnessVersion: peekHarnessVersion('antigravity'),
  };
}

export class AntigravityRunner implements AgentRunner {
  readonly id = 'antigravity' as const;
  readonly capabilities = ANTIGRAVITY_CAPABILITIES;

  versionCommand(): { command: string; args: string[] } {
    return { command: 'agy', args: ['--version'] };
  }

  async run(invocation: AgentInvocation, settings: ResolvedAgentSettings): Promise<AgentRunResult> {
    const agent = { provider: this.id, model: settings.model } as const;
    const built = buildAntigravityArgv(invocation, settings);
    if ('error' in built) return configurationFailure(agent, built.error);

    const minimum = settings.antigravity.minVersion ?? ANTIGRAVITY_MIN_VERSION;
    const installed = peekHarnessVersion(this.id);
    if (typeof installed === 'string' && compareVersions(installed, minimum) < 0) {
      return configurationFailure(
        agent,
        `configuration: agy ${installed} is below the minimum ${minimum}. Update Antigravity CLI.`,
      );
    }

    const { command, args } = built;
    const startTime = Date.now();
    const timeoutMs = resolveAntigravityTimeoutMs(invocation, settings) ?? invocation.timeout;

    let cleanup: (() => void) | null = null;
    try {
      const subprocess = execa(command, args, {
        reject: false,
        timeout: timeoutMs > 0 ? timeoutMs : undefined,
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
      const parsed = parseAntigravityStream(stdout, invocation.onEvent);
      const warningBlock = parsed.warnings.length > 0 ? `\n${parsed.warnings.join('\n')}` : '';
      const rawOutput = stdout + (stderr ? `\n${stderr}` : '') + warningBlock;
      const exitCode = proc.exitCode ?? 1;
      const elapsedMs = Date.now() - startTime;
      const timedOut = wasTimedOut(proc, timeoutMs, elapsedMs);
      const stalled = watchdog.stalled;
      const authFailed = /not logged into antigravity|authentication required/i.test(
        `${stderr}\n${stdout}`,
      );

      // A stall has to survive as text in `rawOutput`: that is the field the
      // executor forwards to `classify()`, and `error` never reaches it. Same
      // shape as claude.ts and codex.ts.
      if (stalled) {
        return {
          success: false,
          result: '',
          rawOutput: describeStall(watchdog.silentMs, 'agy'),
          exitCode: 1,
          usage: parsed.usage,
          error: describeStall(watchdog.silentMs, 'agy'),
          agent: { provider: this.id, model: parsed.model ?? settings.model },
          sessionId: parsed.sessionId ?? undefined,
          harnessVersion: peekHarnessVersion(this.id),
        };
      }

      if (authFailed) {
        return {
          success: false,
          result: parsed.result,
          rawOutput,
          exitCode: timedOut ? 1 : exitCode,
          usage: parsed.usage,
          error: stderr.trim() || 'You are not logged into Antigravity.',
          agent: { provider: this.id, model: parsed.model ?? settings.model },
          sessionId: parsed.sessionId ?? undefined,
          harnessVersion: peekHarnessVersion(this.id),
        };
      }

      const verdict = antigravityRunVerdict({ exitCode, parsed, timedOut });
      if (!verdict.success) {
        return {
          success: false,
          result: parsed.result,
          rawOutput,
          exitCode:
            timedOut || (exitCode === 0 && verdict.error?.startsWith('configuration:') === true)
              ? 1
              : exitCode,
          usage: parsed.usage,
          error: timedOut
            ? describeAgentFailure(proc, stderr || rawOutput, timeoutMs, elapsedMs, command)
            : (verdict.error ?? parsed.error ?? (stderr.trim() || rawOutput)),
          agent: { provider: this.id, model: parsed.model ?? settings.model },
          sessionId: parsed.sessionId ?? undefined,
          harnessVersion: peekHarnessVersion(this.id),
        };
      }

      return {
        success: true,
        result: parsed.result,
        rawOutput,
        exitCode,
        usage: parsed.usage,
        error: null,
        agent: { provider: this.id, model: parsed.model ?? settings.model },
        sessionId: parsed.sessionId ?? undefined,
        harnessVersion: peekHarnessVersion(this.id),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const missing = /ENOENT|not found|command not found/i.test(message);
      return configurationFailure(
        agent,
        missing
          ? 'configuration: agy is not installed. Install Antigravity CLI: https://antigravity.google/docs/cli/install/'
          : message,
      );
    } finally {
      cleanup?.();
    }
  }
}
