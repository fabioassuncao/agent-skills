import { spawn, spawnSync } from 'node:child_process';

export type PtyBackend = 'node-pty' | 'script' | 'python3';

export interface PtySession {
  readonly backend: PtyBackend;
  readonly pid: number | undefined;
  write(data: string): void;
  /** Resize the pty itself. A no-op on the wrapper backends, which cannot. */
  resize(cols: number, rows: number): void;
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (exitCode: number) => void): void;
  kill(): void;
}

export interface SpawnPtyOptions {
  /** Shell command line to run on the pty. */
  command: string;
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  /** Force a backend. Tests use it; production detects. */
  backend?: PtyBackend;
}

let cachedWrapper: 'script' | 'python3' | null | undefined;

function commandExists(command: string): boolean {
  return spawnSync('which', [command], { stdio: 'ignore' }).status === 0;
}

export function detectPtyWrapper(): 'script' | 'python3' | null {
  if (cachedWrapper !== undefined) return cachedWrapper;
  if (process.platform === 'darwin') {
    cachedWrapper = 'python3';
    return cachedWrapper;
  }
  cachedWrapper = commandExists('script') ? 'script' : commandExists('python3') ? 'python3' : null;
  return cachedWrapper;
}

/** Test seam: the detection is cached for the process lifetime. */
export function resetPtyWrapperCache(): void {
  cachedWrapper = undefined;
}

/** The argv that runs `command` under a wrapper. Pure, so it can be compared. */
export function buildPtyArgs(wrapper: 'script' | 'python3', command: string): string[] {
  if (wrapper === 'python3') {
    return ['python3', '-c', 'import pty,sys;pty.spawn(sys.argv[1:])', 'bash', '-c', command];
  }
  // `-q` suppresses the transcript banner; `/dev/null` discards the typescript
  // file `script` insists on writing.
  return ['script', '-q', '-c', command, '/dev/null'];
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    },
  ): {
    pid: number;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    onData(listener: (chunk: string) => void): void;
    onExit(listener: (event: { exitCode: number }) => void): void;
    kill(): void;
  };
}

/**
 * Load `node-pty` if it is both installed and actually usable.
 *
 * The usability check is a real spawn, not a `require`: the failure mode this
 * exists for is a module that imports fine and then throws at `fork` because
 * its native helper cannot execute.
 */
async function loadNodePty(): Promise<NodePtyModule | null> {
  try {
    const module = (await import('node-pty')) as unknown as NodePtyModule;
    const probe = module.spawn('/bin/sh', ['-c', 'exit 0'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: {},
    });
    probe.kill();
    return module;
  } catch {
    return null;
  }
}

let cachedNodePty: NodePtyModule | null | undefined;

async function nodePty(): Promise<NodePtyModule | null> {
  if (cachedNodePty === undefined) cachedNodePty = await loadNodePty();
  return cachedNodePty;
}

/** Test seam. */
export function resetNodePtyCache(): void {
  cachedNodePty = undefined;
}

function wrapperSession(options: SpawnPtyOptions, wrapper: 'script' | 'python3'): PtySession {
  const [file, ...args] = buildPtyArgs(wrapper, options.command);
  const child = spawn(file as string, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');

  return {
    backend: wrapper,
    pid: child.pid,
    write: (data) => {
      child.stdin.write(data);
    },
    resize: () => {},
    onData: (listener) => {
      child.stdout.on('data', (chunk: string) => listener(chunk));
      // stderr goes to the same stream: a terminal has one output, and an error
      // the wrapper prints is something the viewer needs to see.
      child.stderr.on('data', (chunk: string) => listener(chunk));
    },
    onExit: (listener) => {
      child.on('close', (code) => listener(code ?? 0));
    },
    kill: () => {
      child.kill();
    },
  };
}

/**
 * Start a command on a pty.
 *
 * Throws only when there is no usable backend at all, and the message names
 * what to install — the one thing the user can act on.
 */
export async function spawnPty(options: SpawnPtyOptions): Promise<PtySession> {
  if (options.backend !== 'script' && options.backend !== 'python3') {
    const module = await nodePty();
    if (module !== null) {
      const term = module.spawn('/bin/sh', ['-c', options.command], {
        name: 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env,
      });
      return {
        backend: 'node-pty',
        pid: term.pid,
        write: (data) => term.write(data),
        resize: (cols, rows) => term.resize(cols, rows),
        onData: (listener) => term.onData(listener),
        onExit: (listener) => term.onExit(({ exitCode }) => listener(exitCode)),
        kill: () => term.kill(),
      };
    }
  }

  const wrapper =
    options.backend === 'script' || options.backend === 'python3'
      ? options.backend
      : detectPtyWrapper();
  if (wrapper === null) {
    throw new Error(
      'No pseudo-terminal backend available. Install util-linux (which provides `script`) or python3, then try again.',
    );
  }
  return wrapperSession(options, wrapper);
}
