import { execa } from 'execa';
import { registerChild } from '../core/shutdown.js';
import { createWatchdog, describeStall } from '../core/watchdog.js';
import { compareVersions } from './antigravity.js';
import { peekHarnessVersion } from './claude.js';
import { describeAgentFailure, wasTimedOut } from './process.js';
import {
  type AgentInvocation,
  type AgentPermission,
  type AgentRunner,
  type AgentRunResult,
  type AgentUsage,
  OPENCODE_CAPABILITIES,
  type OpenCodeSettings,
  type ResolvedAgentSettings,
} from './types.js';

export const OPENCODE_MIN_VERSION = '1.15.0';
export const DEFAULT_MAX_PROMPT_BYTES = 100_000;
export const OPENCODE_INSTALL_URL = 'https://opencode.ai/docs';

const MUTATING_BASH: readonly string[] = [
  'rm *',
  'rmdir *',
  'mv *',
  'cp *',
  'chmod *',
  'chown *',
  'mkdir *',
  'touch *',
  'tee *',
  'git add *',
  'git commit *',
  'git push *',
  'git checkout *',
  'git reset *',
  'git rebase *',
  'npm install *',
  'npm ci *',
  'pnpm install *',
  'yarn add *',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export interface OpenCodeParsed {
  result: string;
  sessionId: string | null;
  model: string | null;
  usage: AgentUsage | null;
  seenTerminal: boolean;
  error: string | null;
  permissionDenied: { tool: string; message: string } | null;
}

export function maxPromptBytesOf(settings: OpenCodeSettings): number {
  return settings.maxPromptBytes ?? DEFAULT_MAX_PROMPT_BYTES;
}

export function interpretOpenCodeAuth(text: string): boolean {
  const cleaned = text.replaceAll(`${String.fromCharCode(27)}[`, '[').trim();
  if (cleaned === '') return false;
  if (/no credentials|not logged|not authenticated|no providers/i.test(cleaned)) return false;
  return /[a-z0-9][a-z0-9._-]*/i.test(cleaned);
}

export function parseOpenCodeUsage(tokens: unknown): AgentUsage | null {
  if (!isRecord(tokens)) return null;
  const result: AgentUsage = {};
  if (typeof tokens.input === 'number' && Number.isFinite(tokens.input)) {
    result.inputTokens = tokens.input;
  }
  if (typeof tokens.output === 'number' && Number.isFinite(tokens.output)) {
    result.outputTokens = tokens.output;
  }
  const cache = isRecord(tokens.cache) ? tokens.cache : {};
  if (typeof cache.read === 'number' && Number.isFinite(cache.read)) {
    result.cacheReadTokens = cache.read;
  }
  if (typeof cache.write === 'number' && Number.isFinite(cache.write)) {
    result.cacheCreationTokens = cache.write;
  }
  return Object.keys(result).length === 0 ? null : result;
}

function isPermissionDenial(message: string): boolean {
  return /permission|denied|not allowed|external_directory/i.test(message);
}

function toolDetail(name: string, input: Record<string, unknown>): string {
  const key =
    name === 'bash' || name === 'read' || name === 'edit' || name === 'write'
      ? ['command', 'path', 'filePath', 'file']
      : ['path', 'pattern', 'query', 'url', 'command'];
  for (const field of key) {
    const value = input[field];
    if (typeof value === 'string' && value !== '') {
      return value.length > 80 ? `${value.slice(0, 77)}...` : value;
    }
  }
  return '';
}

function extractError(event: Record<string, unknown>): string {
  if (typeof event.error === 'string' && event.error !== '') return event.error;
  const error = isRecord(event.error) ? event.error : {};
  const data = isRecord(error.data) ? error.data : {};
  if (typeof data.message === 'string' && data.message !== '') return data.message;
  if (typeof error.message === 'string' && error.message !== '') return error.message;
  if (typeof error.name === 'string' && error.name !== '') return error.name;
  return 'OpenCode reported an error';
}

export function consumeOpenCodeEvent(
  event: Record<string, unknown>,
  onEvent: AgentInvocation['onEvent'],
  acc: OpenCodeParsed,
): void {
  if (typeof event.sessionID === 'string' && event.sessionID !== '') {
    acc.sessionId = event.sessionID;
  }

  if (event.type === 'text') {
    const part = isRecord(event.part) ? event.part : {};
    if (typeof part.text === 'string' && part.text !== '') {
      acc.result += part.text;
      onEvent?.({ kind: 'text', text: part.text });
    }
    return;
  }

  if (event.type === 'tool_use') {
    const part = isRecord(event.part) ? event.part : {};
    const name = typeof part.tool === 'string' ? part.tool : 'tool';
    const state = isRecord(part.state) ? part.state : {};
    const input = isRecord(state.input) ? state.input : {};
    const detail = toolDetail(name, input);
    onEvent?.({ kind: 'tool', name, ...(detail === '' ? {} : { detail }) });
    const error = isRecord(state.error) ? state.error : {};
    const message =
      typeof error.message === 'string'
        ? error.message
        : typeof state.status === 'string' && state.status === 'error'
          ? `${name} failed`
          : '';
    if (message !== '' && isPermissionDenial(message)) {
      acc.permissionDenied = { tool: name, message };
    }
    return;
  }

  if (event.type === 'step_finish') {
    const part = isRecord(event.part) ? event.part : {};
    if (part.reason === 'stop') acc.seenTerminal = true;
    const usage = parseOpenCodeUsage(part.tokens);
    if (usage) acc.usage = usage;
    return;
  }

  if (event.type === 'error') {
    acc.error = extractError(event);
    acc.seenTerminal = true;
  }
}

export function parseOpenCodeStream(
  raw: string,
  onEvent?: AgentInvocation['onEvent'],
): OpenCodeParsed {
  const acc: OpenCodeParsed = {
    result: '',
    sessionId: null,
    model: null,
    usage: null,
    seenTerminal: false,
    error: null,
    permissionDenied: null,
  };
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const event = JSON.parse(trimmed) as unknown;
      if (!isRecord(event)) continue;
      consumeOpenCodeEvent(event, onEvent, acc);
    } catch {
      // Malformed NDJSON is ignored, like the other runners.
    }
  }
  return acc;
}

export function buildOpenCodePermission(
  permission: AgentPermission,
  addDirs: readonly string[] = [],
): Record<string, unknown> {
  const external: Record<string, string> = { '*': 'deny' };
  for (const dir of addDirs) {
    const normalized = dir.replace(/\\/g, '/').replace(/\/$/, '');
    if (normalized === '') continue;
    external[normalized] = 'allow';
    external[`${normalized}/**`] = 'allow';
  }

  const bash =
    permission === 'read-only'
      ? Object.fromEntries([['*', 'allow'], ...MUTATING_BASH.map((rule) => [rule, 'deny'])])
      : 'allow';

  return {
    edit: permission === 'read-only' ? 'deny' : 'allow',
    bash,
    question: 'deny',
    external_directory: external,
  };
}

export function buildOpenCodeArgv(
  invocation: AgentInvocation,
  settings: ResolvedAgentSettings,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } | { error: string } {
  if (settings.model && !settings.model.includes('/')) {
    return {
      error:
        'configuration: OpenCode model must be provider/model (for example opencode-go/qwen3.8-flash).',
    };
  }

  const promptBytes = Buffer.byteLength(invocation.prompt, 'utf8');
  const limit = maxPromptBytesOf(settings.opencode);
  if (promptBytes > limit) {
    return {
      error: `configuration: prompt exceeds OpenCode argv limit (${promptBytes} bytes > ${limit} maxPromptBytes). The promptChannel is argv; shorten the prompt or raise agent.opencode.maxPromptBytes.`,
    };
  }

  const workspace = invocation.workingDirectory ?? process.cwd();
  const args = ['run', '--format', 'json', '--dir', workspace, '--auto'];
  if (settings.model) args.push('--model', settings.model);
  if (settings.opencode.variant) args.push('--variant', settings.opencode.variant);
  args.push(invocation.prompt);

  return {
    command: 'opencode',
    args,
    env: {
      ...process.env,
      OPENCODE_PERMISSION: JSON.stringify(
        buildOpenCodePermission(invocation.permission, invocation.addDirs ?? []),
      ),
    },
  };
}

export function opencodeRunVerdict(input: {
  exitCode: number;
  parsed: OpenCodeParsed;
  timedOut: boolean;
}): { success: boolean; error: string | null } {
  if (input.parsed.permissionDenied) {
    return {
      success: false,
      error: `configuration: permission denied for ${input.parsed.permissionDenied.tool}. ${input.parsed.permissionDenied.message}`,
    };
  }
  if (input.parsed.error) {
    return { success: false, error: input.parsed.error };
  }
  const hasTerminalEvidence =
    input.parsed.seenTerminal || input.parsed.result.trim() !== '' || input.parsed.error !== null;
  if (!hasTerminalEvidence) {
    return {
      success: false,
      error: 'configuration: OpenCode finished without a terminal event in the stream.',
    };
  }
  if (input.exitCode !== 0 || input.timedOut) {
    return {
      success: false,
      error: input.parsed.error ?? `opencode exited with code ${input.exitCode}`,
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
    harnessVersion: peekHarnessVersion('opencode'),
  };
}

export class OpenCodeRunner implements AgentRunner {
  readonly id = 'opencode' as const;
  readonly capabilities = OPENCODE_CAPABILITIES;

  versionCommand(): { command: string; args: string[] } {
    return { command: 'opencode', args: ['--version'] };
  }

  authCommand(): { command: string; args: string[] } {
    return { command: 'opencode', args: ['auth', 'list'] };
  }

  async run(invocation: AgentInvocation, settings: ResolvedAgentSettings): Promise<AgentRunResult> {
    const agent = { provider: this.id, model: settings.model } as const;
    const built = buildOpenCodeArgv(invocation, settings);
    if ('error' in built) return configurationFailure(agent, built.error);

    const minimum = settings.opencode.minVersion ?? OPENCODE_MIN_VERSION;
    const installed = peekHarnessVersion(this.id);
    if (typeof installed === 'string' && compareVersions(installed, minimum) < 0) {
      return configurationFailure(
        agent,
        `configuration: opencode ${installed} is below the minimum ${minimum}. Update OpenCode CLI.`,
      );
    }

    const { command, args, env } = built;
    const startTime = Date.now();
    const timeoutMs = invocation.timeout;

    let cleanup: (() => void) | null = null;
    try {
      const subprocess = execa(command, args, {
        reject: false,
        timeout: timeoutMs > 0 ? timeoutMs : undefined,
        stripFinalNewline: false,
        stdin: 'ignore',
        env,
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
      const parsed = parseOpenCodeStream(stdout, invocation.onEvent);
      const rawOutput = stdout + (stderr ? `\n${stderr}` : '');
      const exitCode = proc.exitCode ?? 1;
      const elapsedMs = Date.now() - startTime;
      const timedOut = wasTimedOut(proc, timeoutMs, elapsedMs);
      const stalled = watchdog.stalled;
      const authFailed =
        /not authenticated|unauthorized|no api key|auth required|login required/i.test(
          `${stderr}\n${stdout}`,
        );

      if (stalled) {
        return {
          success: false,
          result: '',
          rawOutput: describeStall(watchdog.silentMs, 'opencode'),
          exitCode: 1,
          usage: parsed.usage,
          error: describeStall(watchdog.silentMs, 'opencode'),
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
          error: stderr.trim() || 'OpenCode is not authenticated.',
          agent: { provider: this.id, model: parsed.model ?? settings.model },
          sessionId: parsed.sessionId ?? undefined,
          harnessVersion: peekHarnessVersion(this.id),
        };
      }

      const verdict = opencodeRunVerdict({ exitCode, parsed, timedOut });
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
          ? `configuration: opencode is not installed. Install OpenCode CLI: ${OPENCODE_INSTALL_URL}`
          : message,
      );
    } finally {
      cleanup?.();
    }
  }
}
