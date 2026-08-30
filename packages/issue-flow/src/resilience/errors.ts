/**
 * Failure taxonomy.
 *
 * Every failure the pipeline reacts to is classified here, from a structured
 * `FailureSignal`, into one `FailureKind`. The point is that the decision to
 * retry stops depending on `String.includes` over an error message: text is the
 * last resort of `classify()`, not its first move.
 *
 * The invariants of this layer — above all, that `task_execution` is never
 * retried here — are in `src/resilience/AGENTS.md`.
 */

/** What went wrong, in the terms the retry policy is written in. */
export type FailureKind =
  | 'network'
  | 'timeout'
  | 'stalled'
  | 'rate_limit'
  | 'provider_down'
  | 'provider_crash'
  | 'authentication'
  | 'configuration'
  | 'repository_state'
  | 'task_execution'
  | 'internal'
  | 'unknown';

/** Which subsystem produced the failure. */
export type FailureSource = 'agent' | 'github' | 'git' | 'filesystem' | 'internal';

/**
 * The raw evidence of a failure, as the caller observed it.
 *
 * Everything is optional but `source`: a caller hands over what it actually
 * has. `execa` supplies `exitCode`, `signal`, `timedOut` and — on the thrown
 * error — `errno`; an HTTP client supplies `httpStatus` and `retryAfter`.
 */
export interface FailureSignal {
  source: FailureSource;
  exitCode?: number | null;
  /** POSIX signal name that terminated the process (`SIGTERM`, `SIGKILL`). */
  signal?: string | null;
  /** `execa`'s own verdict that it killed the child on the configured limit. */
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  /** `ENOTFOUND`, `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`… */
  errno?: string;
  httpStatus?: number;
  /** A server's `Retry-After` header: delay in seconds, or an HTTP date. */
  retryAfter?: string | number;
  /** Set by the watchdog when a child produced no output for too long. */
  stalled?: boolean;
}

/** The verdict. `retryable` is advice; the attempt budget belongs to the policy. */
export interface ClassifiedFailure {
  kind: FailureKind;
  message: string;
  retryable: boolean;
  source: FailureSource;
  /** Present only when the server told us how long to wait. */
  retryAfterMs?: number;
}

/**
 * Kinds worth another attempt: the cause is outside the work being done and is
 * expected to pass on its own.
 */
const RETRYABLE_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>([
  'network',
  'timeout',
  'stalled',
  'rate_limit',
  'provider_down',
  'provider_crash',
]);

/**
 * Kinds that no configuration may retry. Waiting cannot fix any of them: they
 * need a human, or they belong to a different loop entirely (`task_execution`
 * is the pipeline's own correction cycle — see `AGENTS.md` here).
 */
const HUMAN_ACTION_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>([
  'authentication',
  'configuration',
  'repository_state',
  'task_execution',
]);

/** Whether this layer considers `kind` worth retrying at all. */
export function isRetryableKind(kind: FailureKind): boolean {
  return RETRYABLE_KINDS.has(kind);
}

/** Whether `kind` escalates to a human instead of being retried, ever. */
export function requiresHumanAction(kind: FailureKind): boolean {
  return HUMAN_ACTION_KINDS.has(kind);
}

/* ── carrying a verdict through a throw ─────────────────────────────────── */

/**
 * An `Error` that carries its own classification.
 *
 * A `catch` normally flattens a failure back into a string, which is exactly
 * the loss this layer exists to prevent: the caller that has to decide between
 * "retry" and "escalate to a human" then has nothing but a message again. Any
 * boundary that must throw — a provider, a phase — throws this instead.
 *
 * `action` is what a human has to do, and it is only ever set for a kind that
 * needs one (`gh auth login` for `authentication`). It is written at the throw
 * site because only that site knows which CLI is involved.
 */
export class ClassifiedError extends Error {
  readonly failure: ClassifiedFailure;
  readonly action: string | undefined;

  constructor(message: string, failure: ClassifiedFailure, action?: string) {
    super(message);
    this.name = 'ClassifiedError';
    this.failure = failure;
    this.action = action;
  }
}

/** The verdict an error carries, or `null` when it carries none. */
export function failureOf(error: unknown): ClassifiedFailure | null {
  return error instanceof ClassifiedError ? error.failure : null;
}

/** The human action an error asks for, or `null`. */
export function actionOf(error: unknown): string | null {
  return error instanceof ClassifiedError ? (error.action ?? null) : null;
}

/* ── step 1: errno ──────────────────────────────────────────────────────── */

const ERRNO_KINDS: Readonly<Record<string, FailureKind>> = {
  ENOTFOUND: 'network',
  EAI_AGAIN: 'network',
  ECONNRESET: 'network',
  ECONNREFUSED: 'network',
  ECONNABORTED: 'network',
  EHOSTUNREACH: 'network',
  ENETUNREACH: 'network',
  ENETDOWN: 'network',
  EPIPE: 'network',
  ETIMEDOUT: 'timeout',
  ENOENT: 'configuration',
  EACCES: 'configuration',
  EPERM: 'configuration',
};

function kindFromErrno(errno: string | undefined): FailureKind | undefined {
  if (!errno) return undefined;
  return ERRNO_KINDS[errno.toUpperCase()];
}

/* ── step 2: HTTP status ────────────────────────────────────────────────── */

/**
 * GitHub reports a secondary rate limit as `403`, not `429`, so the text is
 * consulted before calling a `403` an authentication failure. Everywhere else
 * the status alone decides.
 */
function kindFromHttpStatus(status: number | undefined, lowered: string): FailureKind | undefined {
  if (status === undefined || status < 400) return undefined;
  if (status === 429) return 'rate_limit';
  if (status === 401) return 'authentication';
  if (status === 403)
    return matchesAny(lowered, RATE_LIMIT_PATTERNS) ? 'rate_limit' : 'authentication';
  if (status === 408) return 'timeout';
  if (status >= 500) return 'provider_down';
  return 'configuration';
}

/* ── step 3: how the process ended ──────────────────────────────────────── */

const CRASH_SIGNALS: ReadonlySet<string> = new Set(['SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGBUS']);

function kindFromTermination(signal: FailureSignal): FailureKind | undefined {
  if (signal.stalled === true) return 'stalled';
  if (signal.timedOut === true) return 'timeout';
  const name = signal.signal?.toUpperCase();
  if (!name) return undefined;
  if (name === 'SIGTERM') return 'timeout';
  if (CRASH_SIGNALS.has(name)) return 'provider_crash';
  return undefined;
}

/* ── step 4: exit codes we know the meaning of ──────────────────────────── */

/**
 * Only codes whose meaning is unambiguous. `143` (SIGTERM) is deliberately
 * absent: the Claude CLI handles the signal itself and exits `143` for a
 * user's Ctrl+C just as it does for our timeout, so it decides nothing on its
 * own — `timedOut` or `signal` is what tells the two apart.
 */
const EXIT_CODE_KINDS: Readonly<Record<number, FailureKind>> = {
  75: 'provider_down', // EX_TEMPFAIL
  126: 'configuration', // found, not executable
  127: 'configuration', // command not found
  137: 'provider_crash', // 128 + SIGKILL, typically the OOM killer
  139: 'provider_crash', // 128 + SIGSEGV
};

function kindFromExitCode(exitCode: number | null | undefined): FailureKind | undefined {
  if (exitCode === null || exitCode === undefined) return undefined;
  return EXIT_CODE_KINDS[exitCode];
}

/* ── step 5: text, and only as a last resort ────────────────────────────── */

const RATE_LIMIT_PATTERNS = [
  'rate limit',
  'rate-limit',
  'ratelimit',
  'too many requests',
  'http 429',
] as const;

/**
 * Ordered on purpose. A message is scanned rule by rule and the first hit
 * wins, so the specific causes (rate limit, credentials) are consulted before
 * the generic ones, and `task_execution` comes last: an infrastructure failure
 * surfacing inside a test run is still an infrastructure failure.
 */
type TextPattern = string | RegExp;

const TEXT_RULES: readonly { kind: FailureKind; patterns: readonly TextPattern[] }[] = [
  { kind: 'rate_limit', patterns: RATE_LIMIT_PATTERNS },
  {
    kind: 'authentication',
    patterns: [
      'authentication failed',
      'authentication_error',
      'gh auth login',
      'not logged into',
      'bad credentials',
      'invalid api key',
      'invalid_api_key',
      'token expired',
      'expired token',
      'unauthorized',
      'http 401',
      'http 403',
    ],
  },
  {
    kind: 'network',
    patterns: [
      'connection reset',
      'connection refused',
      'connection aborted',
      'network error',
      'network unavailable',
      'temporary failure',
      'econnreset',
      'econnrefused',
      'enotfound',
      'eai_again',
      'socket hang up',
      // What Go prints, and therefore what `gh` prints: its network errors
      // never mention "connection reset", they mention the resolver.
      'no such host',
      'dial tcp',
      'i/o timeout',
      'tls handshake timeout',
      'server misbehaving',
      'error connecting to',
    ],
  },
  { kind: 'timeout', patterns: ['timed out', 'timeout', 'etimedout'] },
  {
    kind: 'provider_down',
    patterns: [
      'service unavailable',
      'temporarily unavailable',
      'overloaded',
      'bad gateway',
      'gateway timeout',
      'internal server error',
      'http 500',
      'http 502',
      'http 503',
      'http 504',
    ],
  },
  {
    kind: 'provider_crash',
    patterns: ['segmentation fault', 'core dumped', 'out of memory', 'killed by signal'],
  },
  {
    kind: 'repository_state',
    patterns: [
      'unmerged paths',
      'needs merge',
      'automatic merge failed',
      'rebase in progress',
      'you are in the middle of',
      'cherry-pick is in progress',
      'not a git repository',
    ],
  },
  {
    kind: 'configuration',
    patterns: ['command not found', 'unknown flag', 'unknown option', 'no such file or directory'],
  },
  {
    kind: 'task_execution',
    patterns: [
      'test failed',
      'tests failed',
      'failed tests',
      'failing test',
      'assertion failed',
      'assertionerror',
      'expect(received)',
      'typecheck failed',
      'npm err! test failed',
      'lint failed',
      'build failed',
      'compilation failed',
      'syntaxerror',
      'typeerror',
      'referenceerror',
      // What a runner actually prints: "Tests  3 failed | 41 passed",
      // "Test Files  1 failed (12)", "Tests: 2 failed, 8 total".
      /\b\d+\s+failed\b/,
    ],
  },
];

function matchesAny(lowered: string, patterns: readonly TextPattern[]): boolean {
  return patterns.some((pattern) =>
    typeof pattern === 'string' ? lowered.includes(pattern) : pattern.test(lowered),
  );
}

function kindFromText(lowered: string): FailureKind | undefined {
  if (!lowered) return undefined;
  for (const rule of TEXT_RULES) {
    if (matchesAny(lowered, rule.patterns)) return rule.kind;
  }
  return undefined;
}

/* ── Retry-After ────────────────────────────────────────────────────────── */

const RETRY_AFTER_IN_TEXT = /retry[\s-]?after:?\s*(\d+)/i;

/**
 * `Retry-After` is either a delay in seconds or an HTTP date. Both are
 * accepted; anything else, and a date already in the past, yields nothing
 * rather than a bogus zero.
 */
function parseRetryAfter(value: string | number | undefined, now: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number')
    return Number.isFinite(value) && value >= 0 ? value * 1000 : undefined;

  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;

  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return at > now ? at - now : undefined;
}

function resolveRetryAfterMs(signal: FailureSignal, text: string, now: number): number | undefined {
  const explicit = parseRetryAfter(signal.retryAfter, now);
  if (explicit !== undefined) return explicit;

  const inText = RETRY_AFTER_IN_TEXT.exec(text);
  return inText ? Number(inText[1]) * 1000 : undefined;
}

/* ── message ────────────────────────────────────────────────────────────── */

function combineOutput(signal: FailureSignal): string {
  return [signal.stderr, signal.stdout].filter((part) => part && part.trim() !== '').join('\n');
}

/** The output verbatim when there is any, and a synthesised line when there is not. */
function describe(signal: FailureSignal, text: string): string {
  const trimmed = text.trim();
  if (trimmed !== '') return trimmed;
  if (signal.errno) return `${signal.source} failed with ${signal.errno}`;
  if (signal.httpStatus !== undefined)
    return `${signal.source} responded HTTP ${signal.httpStatus}`;
  if (signal.timedOut === true) return `${signal.source} timed out`;
  if (signal.signal) return `${signal.source} was terminated by ${signal.signal}`;
  if (signal.exitCode !== null && signal.exitCode !== undefined) {
    return `${signal.source} exited with code ${signal.exitCode}`;
  }
  return `${signal.source} failed for an unreported reason`;
}

/* ── the classifier ─────────────────────────────────────────────────────── */

export interface ClassifyOptions {
  /** Injectable clock, so an HTTP-date `Retry-After` is testable. */
  now?: () => number;
}

/**
 * Classify a failure by precedence: errno and HTTP status first (a machine
 * told us), then how the process ended, then an exit code we know the meaning
 * of, and only then the text — which is a heuristic and is treated as one.
 */
export function classify(signal: FailureSignal, options: ClassifyOptions = {}): ClassifiedFailure {
  const now = options.now?.() ?? Date.now();
  const text = combineOutput(signal);
  const lowered = text.toLowerCase();

  const kind =
    kindFromErrno(signal.errno) ??
    kindFromHttpStatus(signal.httpStatus, lowered) ??
    kindFromTermination(signal) ??
    kindFromExitCode(signal.exitCode) ??
    kindFromText(lowered) ??
    'unknown';

  const retryAfterMs = resolveRetryAfterMs(signal, text, now);

  return {
    kind,
    message: describe(signal, text),
    retryable: isRetryableKind(kind),
    source: signal.source,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}
