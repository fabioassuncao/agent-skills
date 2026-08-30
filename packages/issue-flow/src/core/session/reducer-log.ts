import { stripVTControlCharacters } from 'node:util';
import { DEFAULT_LOG_LIMIT, type SessionEvent } from './events.js';
import type {
  SessionLogEntry,
  SessionProcessLogEntry,
  SessionReducerOptions,
  SessionSnapshot,
} from './snapshot.js';

export type LogEvent = Extract<
  SessionEvent,
  { type: 'log' | 'process:output' | 'execution:update' }
>;

export function applyLogEvent(
  snapshot: SessionSnapshot,
  event: LogEvent,
  options?: SessionReducerOptions,
): SessionSnapshot {
  switch (event.type) {
    case 'log': {
      const limit = options?.logLimit ?? DEFAULT_LOG_LIMIT;
      const entry: SessionLogEntry = {
        at: event.at,
        level: event.level,
        message: stripVTControlCharacters(event.message),
      };
      const logs = [...snapshot.logs, entry].slice(-Math.max(1, limit));
      return { ...snapshot, logs };
    }

    case 'process:output': {
      const limit = options?.logLimit ?? DEFAULT_LOG_LIMIT;
      const entry: SessionProcessLogEntry = {
        at: event.at,
        phase: event.phase,
        executionId: event.executionId,
        provider: event.provider,
        stream: event.stream,
        message: stripVTControlCharacters(event.message),
      };
      return {
        ...snapshot,
        processLogs: [...snapshot.processLogs, entry].slice(-Math.max(1, limit)),
      };
    }

    case 'execution:update': {
      const index = snapshot.executions.findIndex((entry) => entry.id === event.execution.id);
      const executions = [...snapshot.executions];
      if (index === -1) executions.push(event.execution);
      else executions[index] = event.execution;
      return { ...snapshot, executions };
    }

    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
