import { basename } from 'node:path';
import { type Options as ExecaOptions, execa } from 'execa';
import {
  type ClassifiedFailure,
  classify,
  type FailureSignal,
  type FailureSource,
} from '../resilience/errors.js';
import type { RetryPolicy } from '../resilience/policy.js';
import { type RetryPolicyFor, withRetry } from '../resilience/retry.js';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * The classified failure of the last attempt. Only ever set on the retry
   * path, and only when that attempt failed — a caller that passes no `retry`
   * gets exactly the three fields it has always got.
   */
  failure?: ClassifiedFailure;
  /** How many times the command actually ran. Only set on the retry path. */
  attempts?: number;
}

/** What `onRetryAttempt` is told once an attempt has produced a result. */
export interface RunRetryAttempt {
  /** 1-based number of the attempt that just finished. */
  attempt: number;
  result: ExecResult;
  /** `null` when the attempt succeeded. */
  failure: ClassifiedFailure | null;
  /** Whether another attempt follows this one. */
  willRetry: boolean;
  /** The wait before that next attempt; `0` when there is none. */
  delayMs: number;
}

export interface RunOptions extends ExecaOptions {
  /** Skip global diagnostics when a non-zero exit is an expected probe result. */
  diagnostics?: boolean;
  /**
   * Opt in to retrying this invocation.
   *
   * Absent — the default, and what every call site of this project did before
   * this option existed — means one `execa` call with `reject: false` and no
   * extra attempt, byte for byte.
   *
   * Only pass a policy for a command whose non-zero exit means *it failed*.
   * A command whose non-zero exit is a legitimate answer (`git rev-parse
   * --verify --quiet`, `gh pr view` on a branch with no PR) is safe anyway —
   * an unclassifiable exit lands on `unknown`, which is not a retryable kind —
   * but the intent is worth being explicit about.
   *
   * A function instead of a policy resolves it from the failure that actually
   * happened, which is how one `gh` call gets the `network` budget for a DNS
   * blip and the `rate_limit` budget for a rate limit.
   */
  retry?: RetryPolicy | RetryPolicyFor;
  /** Overrides the subsystem inferred from `command` (`git`, `gh`). */
  source?: FailureSource;
  /**
   * Cuts a pending backoff short. Named apart from execa's own `cancelSignal`
   * because it governs the wait *between* attempts, not the child process.
   */
  retrySignal?: AbortSignal;
  /** Observe each attempt: log it, publish an event, persist the error. */
  onRetryAttempt?: (info: RunRetryAttempt) => void | Promise<void>;
}

/* ── which subsystem produced the failure ───────────────────────────────── */

const SOURCE_BY_COMMAND: Readonly<Record<string, FailureSource>> = {
  git: 'git',
  gh: 'github',
};

function inferSource(command: string): FailureSource {
  return SOURCE_BY_COMMAND[basename(command)] ?? 'internal';
}

function diagnoseCommandFailure(command: string, args: string[], result: ExecResult): void {
  if (result.exitCode === 0) return;
  void import('../storage/diagnostics.js').then(({ writeDiagnostic }) => {
    writeDiagnostic({
      level: 'warning',
      message: `Command failed: ${basename(command)}`,
      context: {
        command: basename(command),
        args,
        exitCode: result.exitCode,
        stderr: result.stderr.slice(0, 4_000),
      },
    });
  });
}

/* ── git invocations that are never repeated ────────────────────────────── */

/**
 * `git` global options that swallow the token after them, so the subcommand of
 * `git -C /repo push --force` is `push` and not `/repo`.
 */
const GIT_GLOBAL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--super-prefix',
]);

/**
 * git invocations no retry policy may repeat, whatever the caller asked for.
 *
 * `true` means the subcommand is never retried; a list means it is destructive
 * only when one of those tokens is present. This is the second of the Epic's
 * three limits — *no destructive operation is run automatically to fix state* —
 * enforced at the one chokepoint every `git` call of the project goes through.
 *
 * It errs on the side of not retrying: a sequencer operation left half-applied
 * (`rebase`, `cherry-pick`, `merge`, `am`, `revert`) is exactly the state a
 * blind second attempt turns into a lost commit, so those are absolute even
 * though a transient failure of one of them is conceivable.
 */
const DESTRUCTIVE_GIT_COMMANDS: Readonly<Record<string, true | readonly string[]>> = {
  rebase: true,
  'cherry-pick': true,
  revert: true,
  merge: true,
  am: true,
  restore: true,
  'filter-branch': true,
  gc: true,
  prune: true,
  'update-ref': true,
  push: ['-f', '--force', '--force-with-lease', '--force-if-includes', '--delete', '--mirror'],
  reset: ['--hard', '--merge', '--keep'],
  clean: ['-f', '--force'],
  checkout: ['-f', '--force', '-B'],
  switch: ['-f', '--force', '--discard-changes'],
  branch: ['-d', '-D', '--delete', '-M'],
  tag: ['-d', '--delete', '-f', '--force'],
  stash: ['drop', 'clear', 'pop'],
  worktree: ['remove', 'prune'],
  submodule: ['deinit'],
};

function gitSubcommand(args: readonly string[]): { name: string; rest: readonly string[] } | null {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(arg)) {
      index++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    return { name: arg, rest: args.slice(index + 1) };
  }
  return null;
}

/**
 * Whether `rest` carries `token`. Long options also match their `=value` form,
 * and a short option also matches bundled into another (`git clean -fd` is
 * `-f -d`), which is how `-f` is actually written in practice.
 */
function hasToken(rest: readonly string[], token: string): boolean {
  if (token.startsWith('--')) {
    return rest.some((arg) => arg === token || arg.startsWith(`${token}=`));
  }
  if (token.startsWith('-')) {
    const letter = token.slice(1);
    return rest.some((arg) => /^-[A-Za-z]+$/.test(arg) && arg.slice(1).includes(letter));
  }
  return rest.includes(token);
}

/** Whether this invocation may be retried at all, whatever the policy says. */
export function isRetryableInvocation(command: string, args: readonly string[]): boolean {
  if (basename(command) !== 'git') return true;

  const subcommand = gitSubcommand(args);
  if (subcommand === null) return true;

  const rule = DESTRUCTIVE_GIT_COMMANDS[subcommand.name];
  if (rule === undefined) return true;
  if (rule === true) return false;

  return !rule.some((token) => hasToken(subcommand.rest, token));
}

/* ── the failure signal ─────────────────────────────────────────────────── */

/**
 * The fields execa puts on a failed result when `reject: false` is set. They
 * are not on its success type, hence the narrowing: `code` is where the spawn
 * errno lands (`ENOENT`, `ETIMEDOUT`, `ECONNRESET`, `EAI_AGAIN`), and
 * `originalMessage` is the only place the reason shows up when the child never
 * started and therefore wrote nothing to stderr.
 */
interface ExecaFailureFields {
  code?: unknown;
  signal?: unknown;
  timedOut?: unknown;
  originalMessage?: unknown;
  shortMessage?: unknown;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function toFailureSignal(raw: unknown, result: ExecResult, source: FailureSource): FailureSignal {
  const fields = (raw ?? {}) as ExecaFailureFields;
  const errno = asString(fields.code);
  const signal = asString(fields.signal);
  // A command that never started has an empty stderr; execa's own message is
  // then the only evidence there is, so it stands in for the missing output.
  const stderr =
    result.stderr.trim() !== ''
      ? result.stderr
      : (asString(fields.originalMessage) ?? asString(fields.shortMessage) ?? '');

  return {
    source,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr,
    ...(errno === undefined ? {} : { errno }),
    ...(signal === undefined ? {} : { signal }),
    ...(fields.timedOut === true ? { timedOut: true } : {}),
  };
}

/* ── the executor ───────────────────────────────────────────────────────── */

async function execOnce(
  command: string,
  args: string[],
  options: ExecaOptions,
): Promise<{ result: ExecResult; raw: unknown }> {
  const raw = await execa(command, args, {
    reject: false,
    ...options,
  });

  return {
    raw,
    result: {
      stdout: raw.stdout?.toString() ?? '',
      stderr: raw.stderr?.toString() ?? '',
      exitCode: raw.exitCode ?? 1,
    },
  };
}

/**
 * Execute a command with arguments and capture its output.
 * Uses execa which calls execFile internally (no shell injection risk).
 * Does not throw on non-zero exit codes.
 *
 * With `options.retry` it becomes the retrying chokepoint every `gh` and `git`
 * call of the project already passes through: the failure is classified from
 * structured evidence (errno, signal, `timedOut`, exit code — text last) and
 * handed to `withRetry`, the single retry executor. Without it nothing changes.
 */
export async function run(
  command: string,
  args: string[] = [],
  options?: RunOptions,
): Promise<ExecResult> {
  const {
    retry,
    source,
    retrySignal,
    onRetryAttempt,
    diagnostics = true,
    ...execaOptions
  } = options ?? {};

  if (retry === undefined || !isRetryableInvocation(command, args)) {
    const result = (await execOnce(command, args, execaOptions)).result;
    if (diagnostics) diagnoseCommandFailure(command, args, result);
    return result;
  }

  const failureSource = source ?? inferSource(command);

  const outcome = await withRetry(
    async () => {
      const { result, raw } = await execOnce(command, args, execaOptions);
      const failure =
        result.exitCode === 0 ? null : classify(toFailureSignal(raw, result, failureSource));
      return { result, failure };
    },
    {
      policy: retry,
      evaluate: (attempt) => attempt.failure,
      ...(retrySignal === undefined ? {} : { signal: retrySignal }),
      ...(onRetryAttempt === undefined
        ? {}
        : {
            onAttempt: (info) =>
              onRetryAttempt({
                attempt: info.attempt,
                result: info.value.result,
                failure: info.value.failure,
                willRetry: info.willRetry,
                delayMs: info.delayMs,
              }),
          }),
    },
  );

  const result = {
    ...outcome.value.result,
    attempts: outcome.attempts,
    ...(outcome.failure === null ? {} : { failure: outcome.failure }),
  };
  if (diagnostics) diagnoseCommandFailure(command, args, result);
  return result;
}
