import { mkdir, rename, utimes, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { reduceSessionEvent } from '../session-state.js';
import {
  DEFAULT_SESSION_HEARTBEAT_MS,
  DEFAULT_THROTTLE_MS,
  type SessionEvent,
} from './events.js';
import { createInitialSnapshot, type SessionReducerOptions, type SessionSnapshot } from './snapshot.js';

export interface SessionPublisher {
  /**
   * Publish an event. Synchronous, never throws, never returns a promise —
   * safe to call from any instrumentation point without affecting execution.
   */
  publish(event: SessionEvent): void;
  /** Current in-memory snapshot. */
  snapshot(): SessionSnapshot;
  /** Monotonic counter, bumped on every applied event (basis for ETags). */
  version(): number;
  /** Force any pending output to be written. Never rejects. */
  flush(): Promise<void>;
  /** Flush and release resources. Never rejects. */
  close(): Promise<void>;
}

/**
 * Default publisher when monitoring is off: every call is a no-op, so each
 * instrumentation point costs a method call that returns immediately.
 */
export class NullPublisher implements SessionPublisher {
  private readonly empty = createInitialSnapshot();

  publish(_event: SessionEvent): void {}

  snapshot(): SessionSnapshot {
    return this.empty;
  }

  version(): number {
    return 0;
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {}
}

export interface MemoryPublisherOptions extends SessionReducerOptions {
  /** Called at most once, on the first internal failure. */
  onWarn?: (message: string) => void;
  /**
   * When false, log events are dropped before reaching the snapshot, so no
   * log line is ever published (session.json or HTTP). Default true.
   */
  includeLogs?: boolean;
}

/**
 * In-memory publisher: reduces events over a snapshot and tracks a monotonic
 * version. Base class for publishers with an output surface (file, HTTP).
 */
export class MemoryPublisher implements SessionPublisher {
  protected state: SessionSnapshot = createInitialSnapshot();
  protected versionCounter = 0;
  private warned = false;
  private readonly onWarn: (message: string) => void;
  private readonly reducerOptions: SessionReducerOptions;
  private readonly includeLogs: boolean;

  constructor(options: MemoryPublisherOptions = {}) {
    this.onWarn = options.onWarn ?? ((message) => process.stderr.write(`${message}\n`));
    this.reducerOptions = { logLimit: options.logLimit };
    this.includeLogs = options.includeLogs ?? true;
  }

  publish(event: SessionEvent): void {
    if (event.type === 'log' && !this.includeLogs) return;
    try {
      this.state = reduceSessionEvent(this.state, event, this.reducerOptions);
      this.versionCounter++;
      this.afterPublish(event);
    } catch (err) {
      this.warnOnce(err);
    }
  }

  /** Hook for subclasses; runs inside publish()'s try/catch. */
  protected afterPublish(_event: SessionEvent): void {}

  snapshot(): SessionSnapshot {
    return this.state;
  }

  version(): number {
    return this.versionCounter;
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {}

  protected warnOnce(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    const message = err instanceof Error ? err.message : String(err);
    try {
      this.onWarn(
        `issue-flow: web monitoring hit an error (will keep retrying silently): ${message}`,
      );
    } catch {
      // Even a failing warn callback must not propagate to the pipeline.
    }
  }
}

export interface FilePublisherOptions extends MemoryPublisherOptions {
  /** Minimum interval between disk writes (ms). Default 1000. */
  throttleMs?: number;
  /** Interval between mtime-only heartbeats (ms). Zero disables it. Default 10000. */
  heartbeatMs?: number;
}

/**
 * Publisher that mirrors the snapshot to issues/N/session.json.
 *
 * Writes are atomic (write-to-temp + rename) and throttled; terminal events
 * (phase:end, session:end) force an immediate write. All I/O failures are
 * swallowed after a single warning.
 */
export class FilePublisher extends MemoryPublisher {
  private readonly filePath: string;
  private readonly throttleMs: number;
  private timer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastWriteStartedAt = 0;
  private lastWrittenVersion = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(filePath: string, options: FilePublisherOptions = {}) {
    super(options);
    this.filePath = filePath;
    this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_SESSION_HEARTBEAT_MS;
    if (heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => this.enqueueHeartbeat(), heartbeatMs);
      this.heartbeatTimer.unref();
    }
  }

  protected override afterPublish(event: SessionEvent): void {
    if (this.closed) return;
    const terminal =
      event.type === 'phase:end' || event.type === 'session:end' || event.type === 'verify:end';
    this.scheduleWrite(terminal);
  }

  private scheduleWrite(force: boolean): void {
    if (force) {
      if (this.timer !== null) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.enqueueWrite();
      return;
    }
    if (this.timer !== null) return;
    const wait = Math.max(0, this.throttleMs - (Date.now() - this.lastWriteStartedAt));
    if (wait === 0) {
      this.enqueueWrite();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.enqueueWrite();
    }, wait);
    this.timer.unref();
  }

  private enqueueWrite(): void {
    this.lastWriteStartedAt = Date.now();
    this.writeChain = this.writeChain.then(async () => {
      const version = this.versionCounter;
      if (version === this.lastWrittenVersion) return;
      const payload = `${JSON.stringify(this.state, null, 2)}\n`;
      try {
        await atomicWriteFile(this.filePath, payload);
        this.lastWrittenVersion = version;
      } catch (err) {
        this.warnOnce(err);
      }
    });
  }

  /**
   * Keep directory-based discovery alive without changing snapshot content or
   * its content-derived ETag. The write chain serializes the touch with atomic
   * snapshot replacement, and no heartbeat is attempted before the first file
   * has been written successfully.
   */
  private enqueueHeartbeat(): void {
    if (this.closed) return;
    this.writeChain = this.writeChain.then(async () => {
      if (this.closed || this.lastWrittenVersion === 0) return;
      const now = new Date();
      try {
        await utimes(this.filePath, now, now);
      } catch (err) {
        this.warnOnce(err);
      }
    });
  }

  override async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.versionCounter !== this.lastWrittenVersion) {
      this.enqueueWrite();
    }
    await this.writeChain;
  }

  override async close(): Promise<void> {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.closed = true;
    await this.flush();
  }
}

/**
 * Atomic write: write to a temp file next to the target, then rename. The
 * same-directory temp keeps the rename on a single filesystem (rename is
 * atomic; no EXDEV fallback needed, unlike an os.tmpdir() temp on Linux
 * tmpfs) and leaves nothing behind. The FilePublisher write chain is the
 * single writer, so the fixed .tmp name never races.
 *
 * The target directory (issues/N/) may not exist yet the first time a fresh
 * issue publishes — pipeline phases create it lazily, and this can be the
 * very first write. mkdir recursive is idempotent, so it's cheap to ensure
 * on every write rather than relying on call order elsewhere.
 */
async function atomicWriteFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpFile = `${path}.tmp`;
  await writeFile(tmpFile, content, 'utf-8');
  await rename(tmpFile, path);
}

