let activeSessionId: string | null = null;

/** Last `session:start` id, so an execution can correlate without being bound late. */
export function setTelemetrySessionId(sessionId: string | null): void {
  activeSessionId = sessionId;
}

export function getTelemetrySessionId(): string | null {
  return activeSessionId;
}
