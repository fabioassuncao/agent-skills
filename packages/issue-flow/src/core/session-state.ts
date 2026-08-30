/**
 * Session state façade — re-exports the public surface of `src/core/session/`.
 *
 * Instrumentation points call publish() with SessionEvents; a pure reducer
 * folds each event into an in-memory SessionSnapshot that any surface
 * (file, HTTP endpoint, future webhooks) can consume in a single format.
 *
 * Monitoring must never affect the pipeline: publish() is synchronous and
 * never throws, and all publisher I/O failures are swallowed after a
 * single warning.
 */

export type {
  SessionLogLevel,
  SessionStatus,
  SessionPhaseStatus,
  SessionEvent,
} from './session/events.js';
export {
  DEFAULT_LOG_LIMIT,
  DEFAULT_THROTTLE_MS,
  DEFAULT_SESSION_HEARTBEAT_MS,
} from './session/events.js';
export type {
  SessionEnvironment,
  SessionLogEntry,
  SessionProcessLogEntry,
  SessionConfigurationValue,
  SessionPhaseConfiguration,
  SessionConfigurationSnapshot,
  SessionStageHistoryEntry,
  SessionUsageSnapshot,
  SessionMetricsSnapshot,
  SessionPhaseSnapshot,
  SessionStorySnapshot,
  SessionActivity,
  SessionResilienceSnapshot,
  SessionCommit,
  SessionPullRequest,
  SessionIssueSnapshot,
  SessionRepositorySnapshot,
  SessionSnapshot,
  SessionReducerOptions,
} from './session/snapshot.js';
export { createInitialSnapshot } from './session/snapshot.js';
export { reduceSessionEvent } from './session/reducer.js';
export type {
  SessionPublisher,
  MemoryPublisherOptions,
  FilePublisherOptions,
} from './session/publishers.js';
export { NullPublisher, MemoryPublisher, FilePublisher } from './session/publishers.js';
