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
  SessionEvent,
  SessionLogLevel,
  SessionPhaseStatus,
  SessionStatus,
} from './session/events.js';
export {
  DEFAULT_LOG_LIMIT,
  DEFAULT_SESSION_HEARTBEAT_MS,
} from './session/events.js';
export type {
  MemoryPublisherOptions,
  SessionPublisher,
} from './session/publishers.js';
export { MemoryPublisher, NullPublisher } from './session/publishers.js';
export { reduceSessionEvent } from './session/reducer.js';
export type {
  SessionActivity,
  SessionCommit,
  SessionConfigurationSnapshot,
  SessionConfigurationValue,
  SessionEnvironment,
  SessionIssueSnapshot,
  SessionLogEntry,
  SessionMetricsSnapshot,
  SessionPhaseConfiguration,
  SessionPhaseSnapshot,
  SessionProcessLogEntry,
  SessionPullRequest,
  SessionReducerOptions,
  SessionRepositorySnapshot,
  SessionResilienceSnapshot,
  SessionSnapshot,
  SessionStageHistoryEntry,
  SessionStorySnapshot,
  SessionUsageSnapshot,
} from './session/snapshot.js';
export { createInitialSnapshot } from './session/snapshot.js';
