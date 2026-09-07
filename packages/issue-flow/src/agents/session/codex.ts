import type { Readable } from 'node:stream';
import { execa } from 'execa';
import { z } from 'zod';
import { registerChild } from '../../core/shutdown.js';

/**
 * A JSON-RPC client for `codex app-server` — the structured channel's Codex half.
 *
 * ## Why a daemon and not `codex exec`
 *
 * `agents/codex.ts` runs one `codex exec` per invocation and reads its JSONL.
 * That is the right shape for a headless phase, and it is untouched. It is the
 * wrong shape for a panel: reading a thread, listing threads and interrupting a
 * turn are *control* operations, and there is no control channel into a process
 * that was started to run one turn and exit. `codex app-server` is that channel
 * — one long-lived process answering JSON-RPC over stdio for every request.
 *
 * This is not a second agent launcher (§25). It never runs a phase, never
 * produces an `AgentRunResult` and is never on the path of `issue-flow run`.
 *
 * ## The detail that must not be lost (§45.2-B)
 *
 * `rejectPending()` on process exit. Every in-flight request is a promise
 * waiting for a reply from a process that has just died; without this they wait
 * forever. The watchdog does not catch it, because there is no child of the
 * invocation to observe — the caller is simply blocked on an `await` that will
 * never settle. It is two lines and it is the difference between a failed
 * request and a hung one.
 *
 * Everything else in the port keeps the upstream's structure: a monotonic
 * request id, `initialized` sent after the handshake, every response validated
 * by schema before it is handed back, a typed `CodexAppServerRequestError` for
 * a JSON-RPC error, and stdout/stderr read by independent loops so a chatty
 * stderr can never stall the protocol.
 */

// ── Wire types ─────────────────────────────────────────────────────────────
//
// The upstream declares each shape twice — a TypeScript interface and a zod
// schema annotated to it. Here the **schema is the single source of truth** and
// the types are inferred from it. Under zod 4 a schema's key optionality is
// derived from its input type, so `unknown` fields (`error`, `gitInfo`,
// `arguments`) infer as optional and no longer satisfy an interface that
// declares them required; keeping both declarations would mean a cast at every
// parse boundary, which is exactly what schema validation is there to avoid.

const unknownValue = z.unknown();

/** Any JSON value. Rejects `undefined`, which is what makes a missing key fail. */
const jsonValue: z.ZodType<unknown> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(unknownValue),
  z.record(z.string(), unknownValue),
]);

export const CodexAppServerApprovalPolicySchema = z.enum([
  'untrusted',
  'on-failure',
  'on-request',
  'never',
]);
export type CodexAppServerApprovalPolicy = z.infer<typeof CodexAppServerApprovalPolicySchema>;

export type CodexAppServerPersonality = 'none' | 'friendly' | 'pragmatic';
export type CodexAppServerSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type CodexAppServerThreadSortKey = 'created_at' | 'updated_at';

const ContentItemSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
});

const UserMessageItemSchema = z.object({
  type: z.literal('userMessage'),
  id: z.string(),
  content: z.array(ContentItemSchema),
});

const AgentMessageItemSchema = z.object({
  type: z.literal('agentMessage'),
  id: z.string(),
  text: z.string().optional(),
  message: z.string().optional(),
  phase: z.string().nullable().optional(),
  memoryCitation: unknownValue.optional(),
});

const CommandActionSchema = z.object({
  type: z.string(),
  command: z.string().optional(),
  path: z.string().nullable().optional(),
});

const CommandExecutionItemSchema = z.object({
  type: z.literal('commandExecution'),
  id: z.string(),
  command: z.string(),
  cwd: z.string().nullable(),
  status: z.enum(['inProgress', 'completed', 'failed', 'declined']),
  // Defaulted rather than required: an older app-server omits it, and losing
  // the whole item over a missing list would hide the command from the panel.
  commandActions: z.array(CommandActionSchema).default([]),
  aggregatedOutput: z.string().nullable(),
  exitCode: z.number().nullable(),
  durationMs: z.number().nullable(),
});

const PatchChangeKindSchema = z.union([
  z.object({ type: z.literal('add') }),
  z.object({ type: z.literal('delete') }),
  z.object({ type: z.literal('update'), move_path: z.string().nullable() }),
]);

const FileUpdateChangeSchema = z.object({
  path: z.string(),
  kind: PatchChangeKindSchema,
  diff: z.string(),
});

const FileChangeItemSchema = z.object({
  type: z.literal('fileChange'),
  id: z.string(),
  changes: z.array(FileUpdateChangeSchema),
  status: z.enum(['inProgress', 'completed', 'failed', 'declined']),
});

const McpToolCallResultSchema = z.object({
  content: z.array(jsonValue),
  structuredContent: jsonValue,
  _meta: jsonValue,
});

const McpToolCallErrorSchema = z.object({ message: z.string() });

const McpToolCallItemSchema = z.object({
  type: z.literal('mcpToolCall'),
  id: z.string(),
  server: z.string(),
  tool: z.string(),
  status: z.enum(['inProgress', 'completed', 'failed']),
  arguments: jsonValue,
  mcpAppResourceUri: z.string().optional(),
  pluginId: z.string().nullable(),
  result: McpToolCallResultSchema.nullable(),
  error: McpToolCallErrorSchema.nullable(),
  durationMs: z.number().nullable(),
});

const DynamicToolCallContentItemSchema = z.union([
  z.object({ type: z.literal('inputText'), text: z.string() }),
  z.object({ type: z.literal('inputImage'), imageUrl: z.string() }),
]);

const DynamicToolCallItemSchema = z.object({
  type: z.literal('dynamicToolCall'),
  id: z.string(),
  namespace: z.string().nullable(),
  tool: z.string(),
  arguments: jsonValue,
  status: z.enum(['inProgress', 'completed', 'failed']),
  contentItems: z.array(DynamicToolCallContentItemSchema).nullable(),
  success: z.boolean().nullable(),
  durationMs: z.number().nullable(),
});

const WebSearchActionSchema = z.union([
  z.object({
    type: z.literal('search'),
    query: z.string().nullable(),
    queries: z.array(z.string()).nullable(),
  }),
  z.object({ type: z.literal('openPage'), url: z.string().nullable() }),
  z.object({
    type: z.literal('findInPage'),
    url: z.string().nullable(),
    pattern: z.string().nullable(),
  }),
  z.object({ type: z.literal('other') }),
]);

const WebSearchItemSchema = z.object({
  type: z.literal('webSearch'),
  id: z.string(),
  query: z.string(),
  action: WebSearchActionSchema.nullable(),
});

/** Items the panel knowingly renders as nothing. Named so they are not "unknown". */
const IgnoredItemSchema = z.object({
  type: z.enum([
    'hookPrompt',
    'plan',
    'reasoning',
    'collabAgentToolCall',
    'imageView',
    'imageGeneration',
    'enteredReviewMode',
    'exitedReviewMode',
    'contextCompaction',
  ]),
  id: z.string(),
});

/**
 * The last member of the union, and the reason a newer Codex does not break
 * this client: an item type nobody has modelled still parses down to its type
 * and id, so the turn around it survives.
 */
const GenericItemSchema = z.object({
  type: z.string(),
  id: z.string(),
});

const ThreadItemSchema = z.union([
  UserMessageItemSchema,
  AgentMessageItemSchema,
  CommandExecutionItemSchema,
  FileChangeItemSchema,
  McpToolCallItemSchema,
  DynamicToolCallItemSchema,
  WebSearchItemSchema,
  IgnoredItemSchema,
  GenericItemSchema,
]);

const TurnSchema = z.object({
  id: z.string(),
  items: z.array(ThreadItemSchema),
  // Deliberately `z.string()` and not an enum: a turn status this release has
  // never seen must not invalidate the thread that contains it.
  status: z.string(),
  error: unknownValue,
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
  durationMs: z.number().nullable(),
});

const ThreadStatusSchema = z.object({
  type: z.string(),
  activeFlags: z.array(z.string()).optional(),
});

const ThreadSchema = z.object({
  id: z.string(),
  forkedFromId: z.string().nullable(),
  preview: z.string(),
  ephemeral: z.boolean(),
  modelProvider: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  status: ThreadStatusSchema,
  path: z.string().nullable(),
  cwd: z.string(),
  cliVersion: z.string(),
  source: z.string(),
  agentNickname: z.string().nullable(),
  agentRole: z.string().nullable(),
  gitInfo: unknownValue,
  name: z.string().nullable(),
  turns: z.array(TurnSchema),
});

const ThreadListResponseSchema = z.object({
  data: z.array(ThreadSchema),
  nextCursor: z.string().nullable(),
});

const ThreadReadResponseSchema = z.object({ thread: ThreadSchema });

const ThreadContextSchema = z.object({
  thread: ThreadSchema,
  model: z.string(),
  modelProvider: z.string(),
  serviceTier: z.string().nullable(),
  cwd: z.string(),
  approvalPolicy: CodexAppServerApprovalPolicySchema,
  approvalsReviewer: z.string(),
  sandbox: z.object({ type: z.string() }),
  reasoningEffort: z.string().nullable(),
});

const TurnStartResponseSchema = z.object({ turn: TurnSchema });

const InitializeResponseSchema = z.object({
  userAgent: z.string(),
  codexHome: z.string(),
  platformFamily: z.string(),
  platformOs: z.string(),
});

export type CodexAppServerContentItem = z.infer<typeof ContentItemSchema>;
export type CodexAppServerUserMessageItem = z.infer<typeof UserMessageItemSchema>;
export type CodexAppServerAgentMessageItem = z.infer<typeof AgentMessageItemSchema>;
export type CodexAppServerCommandAction = z.infer<typeof CommandActionSchema>;
export type CodexAppServerCommandExecutionItem = z.infer<typeof CommandExecutionItemSchema>;
export type CodexAppServerPatchChangeKind = z.infer<typeof PatchChangeKindSchema>;
export type CodexAppServerFileUpdateChange = z.infer<typeof FileUpdateChangeSchema>;
export type CodexAppServerFileChangeItem = z.infer<typeof FileChangeItemSchema>;
export type CodexAppServerMcpToolCallItem = z.infer<typeof McpToolCallItemSchema>;
export type CodexAppServerDynamicToolCallContentItem = z.infer<
  typeof DynamicToolCallContentItemSchema
>;
export type CodexAppServerDynamicToolCallItem = z.infer<typeof DynamicToolCallItemSchema>;
export type CodexAppServerWebSearchAction = z.infer<typeof WebSearchActionSchema>;
export type CodexAppServerWebSearchItem = z.infer<typeof WebSearchItemSchema>;
export type CodexAppServerThreadItem = z.infer<typeof ThreadItemSchema>;
export type CodexAppServerTurn = z.infer<typeof TurnSchema>;
export type CodexAppServerThreadStatus = z.infer<typeof ThreadStatusSchema>;
export type CodexAppServerThread = z.infer<typeof ThreadSchema>;
export type CodexAppServerThreadListResponse = z.infer<typeof ThreadListResponseSchema>;
export type CodexAppServerThreadReadResponse = z.infer<typeof ThreadReadResponseSchema>;
export type CodexAppServerThreadContext = z.infer<typeof ThreadContextSchema>;
export type CodexAppServerTurnStartResponse = z.infer<typeof TurnStartResponseSchema>;

export interface CodexAppServerThreadListParams {
  archived?: boolean | null;
  cursor?: string | null;
  cwd?: string | null;
  limit?: number | null;
  searchTerm?: string | null;
  sortKey?: CodexAppServerThreadSortKey | null;
  sourceKinds?: string[] | null;
}

export interface CodexAppServerThreadStartParams {
  approvalPolicy?: CodexAppServerApprovalPolicy;
  cwd: string;
  ephemeral?: boolean | null;
  model?: string | null;
  modelProvider?: string | null;
  personality?: CodexAppServerPersonality | null;
  sandbox?: CodexAppServerSandboxMode | null;
  developerInstructions?: string | null;
}

export interface CodexAppServerThreadResumeParams {
  approvalPolicy?: CodexAppServerApprovalPolicy;
  cwd?: string | null;
  personality?: CodexAppServerPersonality | null;
  sandbox?: CodexAppServerSandboxMode | null;
  threadId: string;
}

export interface CodexAppServerUserInput {
  type: 'text';
  text: string;
}

export interface CodexAppServerTurnStartParams {
  approvalPolicy?: CodexAppServerApprovalPolicy;
  cwd?: string | null;
  input: CodexAppServerUserInput[];
  threadId: string;
}

export interface CodexAppServerTurnInterruptParams {
  threadId: string;
  turnId: string;
}

export interface CodexAppServerNotification {
  method: string;
  params?: unknown;
}

export interface CodexAppServerGateway {
  threadList(params: CodexAppServerThreadListParams): Promise<CodexAppServerThreadListResponse>;
  threadRead(threadId: string, includeTurns: boolean): Promise<CodexAppServerThreadReadResponse>;
  threadResume(params: CodexAppServerThreadResumeParams): Promise<CodexAppServerThreadContext>;
  threadStart(params: CodexAppServerThreadStartParams): Promise<CodexAppServerThreadContext>;
  /** Provider-native fork; the structured response is the new conversation identity. */
  threadFork(threadId: string): Promise<CodexAppServerThreadContext>;
  turnStart(params: CodexAppServerTurnStartParams): Promise<CodexAppServerTurnStartResponse>;
  turnInterrupt(params: CodexAppServerTurnInterruptParams): Promise<void>;
}

// ── Pure helpers ───────────────────────────────────────────────────────────

/**
 * Split a stdout chunk into whole JSON-RPC lines.
 *
 * The decoder is passed in and reused across calls with `{ stream: true }`
 * because a chunk boundary lands in the middle of a multi-byte character often
 * enough to matter: decoding each chunk independently corrupts any non-ASCII
 * text that straddles it, and a corrupted line is an unparseable response.
 *
 * Calling it with no `chunk` flushes: the decoder's tail is drained and
 * whatever is left in the buffer is emitted as a final line, which is how a
 * last line without a trailing newline is not lost when the process exits.
 */
export function readCodexAppServerStdoutLines(input: {
  decoder: TextDecoder;
  buffer: string;
  chunk?: Uint8Array;
}): { buffer: string; lines: string[] } {
  let buffer =
    input.buffer +
    (input.chunk ? input.decoder.decode(input.chunk, { stream: true }) : input.decoder.decode());
  const lines: string[] = [];

  while (true) {
    const newlineIndex = buffer.indexOf('\n');
    if (newlineIndex === -1) break;
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (line.length > 0) lines.push(line);
  }

  if (!input.chunk) {
    const finalLine = buffer.trim();
    buffer = '';
    if (finalLine.length > 0) lines.push(finalLine);
  }

  return { buffer, lines };
}

export function parseCodexAppServerThreadItem(raw: unknown): CodexAppServerThreadItem | null {
  const parsed = ThreadItemSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function parseCodexAppServerThreadReadResponse(
  raw: unknown,
): CodexAppServerThreadReadResponse | null {
  const parsed = ThreadReadResponseSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** A JSON-RPC error reply, kept distinct from a transport or schema failure. */
export class CodexAppServerRequestError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'CodexAppServerRequestError';
  }
}

// ── The client ─────────────────────────────────────────────────────────────

interface PendingRequest {
  reject: (reason?: unknown) => void;
  resolve: (value: unknown) => void;
}

interface CodexAppServerJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * The process the client talks to.
 *
 * An interface rather than an execa subprocess so a test can drive the protocol
 * without `codex` installed — the JSON-RPC framing, the pending map and the
 * exit path are all exercised against a fake.
 */
export interface CodexAppServerProcess {
  stdin: { write(chunk: string): unknown };
  stdout: Readable;
  stderr: Readable;
  kill(): void;
  /** Invoked once, with the exit code, when the process is gone. */
  onExit(listener: (code: number | null) => void): void;
}

export interface CodexAppServerClientOptions {
  clientName?: string;
  clientVersion?: string;
  /** Injected in tests; production spawns `codex app-server`. */
  spawn?: () => CodexAppServerProcess;
  /** Where stderr goes. Off by default — it is the provider's own diagnostics. */
  onStderr?: (chunk: string) => void;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

/**
 * Spawn the daemon.
 *
 * argv, never a shell string (ADR-04). This does not go through
 * `utils/shell.ts`'s `run()`, and deliberately so: `run()` awaits a command to
 * completion and hands back its output, which is the opposite of a process that
 * must stay alive with an open stdin. It is the same boundary
 * `agents/claude.ts` already crosses with `execa` for the streaming invocation.
 * The child is registered for shutdown so Ctrl-C does not leave a daemon behind.
 */
function spawnCodexAppServer(): CodexAppServerProcess {
  const subprocess = execa('codex', ['app-server'], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    buffer: false,
    reject: false,
  });
  const unregister = registerChild({
    kill: (signal) => subprocess.kill(signal),
    done: subprocess.then(
      () => undefined,
      () => undefined,
    ),
  });

  if (!subprocess.stdin || !subprocess.stdout || !subprocess.stderr) {
    unregister();
    throw new Error('codex app-server was spawned without the pipes the protocol needs');
  }

  return {
    stdin: subprocess.stdin,
    stdout: subprocess.stdout,
    stderr: subprocess.stderr,
    kill: () => {
      subprocess.kill();
    },
    onExit: (listener) => {
      subprocess.once('close', (code: number | null) => {
        unregister();
        listener(code);
      });
    },
  };
}

export class CodexAppServerClient implements CodexAppServerGateway {
  private readonly listeners = new Set<(notification: CodexAppServerNotification) => void>();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly spawn: () => CodexAppServerProcess;
  private readonly onStderr: ((chunk: string) => void) | null;
  private nextId = 1;
  private proc: CodexAppServerProcess | null = null;
  private readyPromise: Promise<void> | null = null;

  constructor(options: CodexAppServerClientOptions = {}) {
    this.clientName = options.clientName ?? 'issue-flow';
    this.clientVersion = options.clientVersion ?? '0.0.0';
    this.spawn = options.spawn ?? spawnCodexAppServer;
    this.onStderr = options.onStderr ?? null;
  }

  /** Thread events arrive unsolicited; this is how a panel subscribes to them. */
  onNotification(listener: (notification: CodexAppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async threadList(
    params: CodexAppServerThreadListParams,
  ): Promise<CodexAppServerThreadListResponse> {
    return await this.request('thread/list', ThreadListResponseSchema, params);
  }

  async threadRead(
    threadId: string,
    includeTurns: boolean,
  ): Promise<CodexAppServerThreadReadResponse> {
    return await this.request('thread/read', ThreadReadResponseSchema, { threadId, includeTurns });
  }

  async threadResume(
    params: CodexAppServerThreadResumeParams,
  ): Promise<CodexAppServerThreadContext> {
    return await this.request('thread/resume', ThreadContextSchema, params);
  }

  async threadStart(params: CodexAppServerThreadStartParams): Promise<CodexAppServerThreadContext> {
    return await this.request('thread/start', ThreadContextSchema, params);
  }

  async threadFork(threadId: string): Promise<CodexAppServerThreadContext> {
    return await this.request('thread/fork', ThreadContextSchema, { threadId });
  }

  async turnStart(params: CodexAppServerTurnStartParams): Promise<CodexAppServerTurnStartResponse> {
    return await this.request('turn/start', TurnStartResponseSchema, params);
  }

  async turnInterrupt(params: CodexAppServerTurnInterruptParams): Promise<void> {
    await this.request('turn/interrupt', z.unknown(), params);
  }

  /** Stop the daemon. Pending requests are rejected through the exit path. */
  close(): void {
    this.proc?.kill();
  }

  private async request<T>(method: string, schema: z.ZodType<T>, params?: unknown): Promise<T> {
    await this.ensureReady();
    return await this.requestInternal(method, schema, params);
  }

  private async ensureReady(): Promise<void> {
    if (this.readyPromise) return await this.readyPromise;

    this.readyPromise = (async () => {
      this.startProcess();
      await this.requestInternal('initialize', InitializeResponseSchema, {
        clientInfo: { name: this.clientName, version: this.clientVersion },
        capabilities: { experimentalApi: true },
      });
      // The handshake is two-step: the server does not consider the session
      // usable until this notification lands, and every later request would be
      // answered with a protocol error.
      this.send({ method: 'initialized', params: {} });
    })().catch((error: unknown) => {
      // A failed handshake must not leave a half-open client behind — the next
      // call has to be able to try again from a clean process.
      this.resetProcess();
      throw error;
    });

    return await this.readyPromise;
  }

  private startProcess(): void {
    if (this.proc) return;

    const proc = this.spawn();
    this.proc = proc;
    this.startStdoutLoop(proc);
    this.startStderrLoop(proc);
    proc.onExit((code) => {
      // §45.2-B: without this every in-flight request waits forever for a reply
      // from a process that no longer exists. There is no child of the
      // invocation for the watchdog to notice, so nothing else would ever
      // settle these promises.
      this.rejectPending(new Error(`codex app-server exited with code ${code ?? 'unknown'}`));
      this.resetProcess();
    });
  }

  private startStdoutLoop(proc: CodexAppServerProcess): void {
    const decoder = new TextDecoder();
    let buffer = '';
    proc.stdout.on('data', (chunk: Buffer) => {
      const decoded = readCodexAppServerStdoutLines({ decoder, buffer, chunk });
      buffer = decoded.buffer;
      for (const line of decoded.lines) this.handleStdoutLine(line);
    });
    proc.stdout.on('end', () => {
      const decoded = readCodexAppServerStdoutLines({ decoder, buffer });
      buffer = decoded.buffer;
      for (const line of decoded.lines) this.handleStdoutLine(line);
    });
  }

  /**
   * stderr is drained by its own listener and never mixed into the protocol.
   * An unread stderr pipe fills and blocks the child, which would stall stdout
   * and with it every pending request.
   */
  private startStderrLoop(proc: CodexAppServerProcess): void {
    const decoder = new TextDecoder();
    proc.stderr.on('data', (chunk: Buffer) => {
      if (!this.onStderr) return;
      const text = decoder.decode(chunk, { stream: true }).trim();
      if (text.length > 0) this.onStderr(text);
    });
  }

  private handleStdoutLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;

    const responseId = typeof parsed.id === 'number' ? parsed.id : null;
    if (responseId !== null) {
      this.handleResponse(responseId, parsed);
      return;
    }

    if (typeof parsed.method !== 'string') return;
    const notification: CodexAppServerNotification = {
      method: parsed.method,
      ...(parsed.params !== undefined ? { params: parsed.params } : {}),
    };
    for (const listener of this.listeners) listener(notification);
  }

  private handleResponse(id: number, raw: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);

    const responseError = this.readResponseError(raw);
    if (responseError) {
      pending.reject(
        new CodexAppServerRequestError(
          responseError.message,
          responseError.code,
          responseError.data,
        ),
      );
      return;
    }
    pending.resolve(raw.result);
  }

  private async requestInternal<T>(
    method: string,
    schema: z.ZodType<T>,
    params?: unknown,
  ): Promise<T> {
    if (!this.proc) throw new Error('codex app-server process is not available');

    const id = this.nextId;
    this.nextId += 1;

    const result = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ id, method, ...(params !== undefined ? { params } : {}) });
      } catch (error) {
        // The entry has to go before the rejection, or a later reply carrying
        // this id would resolve a promise that already settled.
        this.pending.delete(id);
        reject(error);
      }
    });

    const parsed = schema.safeParse(result);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(
        issue
          ? `codex app-server returned invalid ${method} response: ${issue.message}`
          : `codex app-server returned invalid ${method} response`,
      );
    }
    return parsed.data;
  }

  private send(payload: unknown): void {
    const proc = this.proc;
    if (!proc) throw new Error('codex app-server process is not available');
    proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private rejectPending(error: Error): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const request of pending) request.reject(error);
  }

  private resetProcess(): void {
    this.proc = null;
    this.readyPromise = null;
  }

  private readResponseError(raw: Record<string, unknown>): CodexAppServerJsonRpcError | null {
    if (!isRecord(raw.error)) return null;
    return typeof raw.error.code === 'number' && typeof raw.error.message === 'string'
      ? {
          code: raw.error.code,
          message: raw.error.message,
          ...(raw.error.data !== undefined ? { data: raw.error.data } : {}),
        }
      : null;
  }
}
