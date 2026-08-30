import {
  DEFAULT_SESSION_HEARTBEAT_MS,
  MemoryPublisher,
  type MemoryPublisherOptions,
  type SessionEvent,
  type SessionPublisher,
} from '../../core/session-state.js';
import { type PlanRepositoryContext, saveSessionEvent, touchStoredSession } from './repository.js';

/**
 * SQLite history surface for a live session.
 *
 * The reducer remains synchronous and in-memory just like every other session
 * publisher. Database writes are serialized behind it and failures are reduced
 * to the publisher's best-effort warning contract, never a pipeline failure.
 */
export class SqliteSessionPublisher extends MemoryPublisher implements SessionPublisher {
  private readonly context: PlanRepositoryContext;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly heartbeatTimer: NodeJS.Timeout;
  private closed = false;

  constructor(context: PlanRepositoryContext, options: MemoryPublisherOptions = {}) {
    super(options);
    this.context = context;
    this.heartbeatTimer = setInterval(() => this.enqueueHeartbeat(), DEFAULT_SESSION_HEARTBEAT_MS);
    this.heartbeatTimer.unref();
  }

  protected override afterPublish(event: SessionEvent): void {
    if (this.closed) return;
    const sessionId = this.snapshot().sessionId;
    // Events before session:start do not belong to a durable run yet.
    if (sessionId === null) return;
    const snapshot = this.snapshot();
    const sequence = this.version();
    this.writeChain = this.writeChain.then(async () => {
      try {
        await saveSessionEvent(this.context, { sessionId, sequence, event, snapshot });
      } catch (error) {
        this.warnOnce(error);
      }
    });
  }

  override async flush(): Promise<void> {
    await this.writeChain;
  }

  override async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    await this.flush();
  }

  private enqueueHeartbeat(): void {
    if (this.closed) return;
    const sessionId = this.snapshot().sessionId;
    if (sessionId === null || this.snapshot().status !== 'running') return;
    this.writeChain = this.writeChain.then(async () => {
      try {
        await touchStoredSession(this.context, sessionId);
      } catch (error) {
        this.warnOnce(error);
      }
    });
  }
}
