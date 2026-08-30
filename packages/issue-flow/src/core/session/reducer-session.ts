import { stripVTControlCharacters } from 'node:util';
import { setTelemetrySessionId } from '../../telemetry/session-id.js';
import type { SessionEvent } from './events.js';
import { isTerminalStage, transitionStory } from './reducer-stage.js';
import {
  createInitialSnapshot,
  emptyPhaseTiming,
  emptyUsage,
  type SessionSnapshot,
} from './snapshot.js';

export type SessionLifecycleEvent = Extract<
  SessionEvent,
  { type: 'session:start' | 'session:end' | 'issue:update' | 'verify:end' }
>;

export function applySessionEvent(
  snapshot: SessionSnapshot,
  event: SessionLifecycleEvent,
): SessionSnapshot {
  switch (event.type) {
    case 'session:start': {
      setTelemetrySessionId(event.sessionId);
      const initial = createInitialSnapshot();
      return {
        ...initial,
        sessionId: event.sessionId,
        issue: { ...initial.issue, number: event.issueNumber, url: event.issueUrl ?? null },
        status: 'running',
        startedAt: event.at,
        progress: {
          ...initial.progress,
          phasesTotal: event.phases.length,
        },
        phases: event.phases.map((name) => ({
          name,
          status: 'pending' as const,
          startedAt: null,
          endedAt: null,
          durationSeconds: null,
          error: null,
          ...emptyPhaseTiming(),
          ...emptyUsage(),
        })),
        git: {
          branch: event.branch ?? null,
          baseBranch: event.baseBranch ?? null,
          branchCreated: event.branchCreated ?? null,
          startCommit: event.startCommit ?? null,
          commits: [],
        },
        // The branch is the one piece of repository identity the session
        // already knows here; the rest waits for publishGitState. Seeding it
        // keeps git.branch and repository.branch consistent for a poll that
        // lands before the first git:update.
        repository: { ...initial.repository, branch: event.branch ?? null },
        configuration: event.configuration ?? null,
        environment: event.environment
          ? {
              node: event.environment.node,
              platform: event.environment.platform,
              agent: event.environment.agent ?? null,
              model: event.environment.model ?? null,
              cliVersion: event.environment.cliVersion ?? null,
            }
          : null,
      };
    }

    case 'issue:update':
      return {
        ...snapshot,
        issue: {
          ...snapshot.issue,
          // Merge, not replacement: the run may know a number and a URL that
          // the provider does not report (a local Issue mirroring a remote
          // one), and enriching the section must never erase them.
          number: event.number ?? snapshot.issue.number,
          url: event.url ?? snapshot.issue.url,
          title: event.title,
          description: event.description,
          labels: event.labels,
          state: event.state,
        },
      };

    case 'verify:end':
      return {
        ...snapshot,
        verification: {
          verdict: event.verdict,
          level: event.level,
          independence: event.independence,
        },
      };

    case 'session:end':
      return {
        ...snapshot,
        status: event.status,
        endedAt: event.at,
        currentPhase: null,
        currentActivity: null,
        // Close every non-terminal stage: the run is over, so nothing can be
        // 'executing'/'in_review'/'in_correction' any more. A story that never
        // reached `passes` on a run that did not complete is exactly what the
        // 'failed' stage means; anything else settles as 'done'.
        stories: snapshot.stories.map((story) => {
          if (isTerminalStage(story.stage)) return story;
          const stage =
            event.status === 'completed' && story.passes ? ('done' as const) : ('failed' as const);
          return transitionStory(story, stage, event.at, null);
        }),
        lastError: event.error
          ? { message: stripVTControlCharacters(event.error), at: event.at }
          : snapshot.lastError,
      };

    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
