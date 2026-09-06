import { type Readable, Writable } from 'node:stream';
import type {
  ConfirmOptions as ClackConfirmOptions,
  SelectOptions as ClackSelectOptions,
} from '@clack/prompts';
import { confirm, isCancel, select } from '@clack/prompts';

type TtyStream = { readonly isTTY?: boolean };

export interface InteractivityOptions {
  stdin: unknown;
  stdout: unknown;
  ci: string | undefined;
}

function isTtyStream(stream: unknown): stream is TtyStream {
  return typeof stream === 'object' && stream !== null && 'isTTY' in stream;
}

/**
 * Whether a prompt may be displayed without surprising a headless caller.
 *
 * All process state is supplied by the caller so this policy remains pure and
 * can be shared by every interactive flow.
 */
export function isInteractive({ stdin, stdout, ci }: InteractivityOptions): boolean {
  const normalizedCi = ci?.toLowerCase();
  const inCi =
    normalizedCi !== undefined &&
    normalizedCi !== '' &&
    normalizedCi !== '0' &&
    normalizedCi !== 'false';

  return (
    isTtyStream(stdin) &&
    stdin.isTTY === true &&
    isTtyStream(stdout) &&
    stdout.isTTY === true &&
    !inCi
  );
}

export type PromptResult<Value> = { status: 'submitted'; value: Value } | { status: 'cancelled' };

export interface PromptIo {
  stdin?: Readable;
  stdout?: Writable;
  signal?: AbortSignal;
  env?: Readonly<Record<string, string | undefined>>;
}

export type SelectPromptOptions<Value> = Omit<
  ClackSelectOptions<Value>,
  'input' | 'output' | 'signal'
> &
  PromptIo;

export type ConfirmPromptOptions = Omit<ClackConfirmOptions, 'input' | 'output' | 'signal'> &
  PromptIo;

const SGR_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;:]*m`, 'g');

class NoColorOutput extends Writable {
  private readonly onResize = () => this.emit('resize');

  constructor(private readonly destination: Writable) {
    super();
    destination.on('resize', this.onResize);
  }

  get isTTY(): boolean | undefined {
    return (this.destination as Writable & TtyStream).isTTY;
  }

  get columns(): number | undefined {
    return (this.destination as Writable & { columns?: number }).columns;
  }

  get rows(): number | undefined {
    return (this.destination as Writable & { rows?: number }).rows;
  }

  release(): void {
    this.destination.off('resize', this.onResize);
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString();
    try {
      this.destination.write(text.replace(SGR_SEQUENCE, ''));
      callback();
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

function noColorRequested(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.NO_COLOR !== undefined && env.NO_COLOR !== '';
}

async function runPrompt<Value>(
  prompt: (options: {
    input: Readable;
    output: Writable;
    signal: AbortSignal;
  }) => Promise<Value | symbol>,
  io: PromptIo,
): Promise<PromptResult<Value>> {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const cancelFromSignal = () => controller.abort(io.signal?.reason);

  stdin.once('end', cancel);
  stdin.once('close', cancel);
  io.signal?.addEventListener('abort', cancelFromSignal, { once: true });

  if (stdin.readableEnded || stdin.destroyed) {
    cancel();
  }
  if (io.signal?.aborted) {
    cancelFromSignal();
  }

  const plainOutput = noColorRequested(io.env ?? process.env)
    ? new NoColorOutput(stdout)
    : undefined;

  try {
    const value = await prompt({
      input: stdin,
      output: plainOutput ?? stdout,
      signal: controller.signal,
    });

    return isCancel(value) ? { status: 'cancelled' } : { status: 'submitted', value };
  } finally {
    stdin.off('end', cancel);
    stdin.off('close', cancel);
    io.signal?.removeEventListener('abort', cancelFromSignal);
    plainOutput?.release();
  }
}

export async function promptSelect<Value>({
  stdin,
  stdout,
  signal,
  env,
  ...options
}: SelectPromptOptions<Value>): Promise<PromptResult<Value>> {
  return runPrompt(
    (io) =>
      select({
        ...options,
        ...io,
      }),
    { stdin, stdout, signal, env },
  );
}

export async function promptConfirm({
  stdin,
  stdout,
  signal,
  env,
  ...options
}: ConfirmPromptOptions): Promise<PromptResult<boolean>> {
  return runPrompt(
    (io) =>
      confirm({
        ...options,
        ...io,
      }),
    { stdin, stdout, signal, env },
  );
}
