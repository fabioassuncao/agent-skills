import type { SessionEvent } from './events.js';
import { reduceSessionEvent } from './reducer.js';
import {
  createInitialSnapshot,
  type SessionReducerOptions,
  type SessionSnapshot,
} from './snapshot.js';

export interface SessionPublisher {
  publish(event: SessionEvent): void;
  snapshot(): SessionSnapshot;
  version(): number;
  flush(): Promise<void>;
  close(): Promise<void>;
}

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
  onWarn?: (message: string) => void;
  includeLogs?: boolean;
}

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
    } catch (error) {
      this.warnOnce(error);
    }
  }

  protected afterPublish(_event: SessionEvent): void {}

  snapshot(): SessionSnapshot {
    return this.state;
  }

  version(): number {
    return this.versionCounter;
  }

  async flush(): Promise<void> {}
  async close(): Promise<void> {}

  protected warnOnce(error: unknown): void {
    if (this.warned) return;
    this.warned = true;
    const message = error instanceof Error ? error.message : String(error);
    try {
      this.onWarn(`issue-flow: session publishing failed: ${message}`);
    } catch {}
  }
}
