import type { AgentOrigin, AgentPhase } from './types.js';

/** Origins recorded by the last `loadAgentConfig` call. */
export interface TrackedAgentOrigins {
  provider: AgentOrigin;
  model: AgentOrigin;
  phases: Partial<Record<AgentPhase, { provider?: AgentOrigin; model?: AgentOrigin }>>;
}

let trackedOrigins: TrackedAgentOrigins | null = null;

export function setTrackedOrigins(origins: TrackedAgentOrigins | null): void {
  trackedOrigins = origins;
}

export function getTrackedOrigins(): TrackedAgentOrigins | null {
  return trackedOrigins;
}
