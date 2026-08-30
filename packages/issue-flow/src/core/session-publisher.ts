import { NullPublisher, type SessionPublisher } from './session/publishers.js';

/**
 * Global slot for the active SessionPublisher, following the same pattern as
 * setVerbose in verbose.ts. Instrumentation points (logger, engine, headless)
 * read the slot via getSessionPublisher(); run.ts installs a MemoryPublisher
 * for every run and a FilePublisher on top when web monitoring is enabled.
 * The default NullPublisher makes every instrumentation point a no-op
 * before a run (or a standalone command) installs a publisher.
 */

const NULL_PUBLISHER = new NullPublisher();

let _publisher: SessionPublisher = NULL_PUBLISHER;

/**
 * Install the active session publisher. Pass undefined to reset to the
 * default NullPublisher.
 */
export function setSessionPublisher(publisher: SessionPublisher | undefined): void {
  _publisher = publisher ?? NULL_PUBLISHER;
}

export function getSessionPublisher(): SessionPublisher {
  return _publisher;
}
