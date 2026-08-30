import { reported } from './derive.js';
import type { SessionEvent } from './events.js';
import type { SessionSnapshot } from './snapshot.js';

export type GitEvent = Extract<SessionEvent, { type: 'git:update' }>;

export function applyGitEvent(snapshot: SessionSnapshot, event: GitEvent): SessionSnapshot {
  switch (event.type) {
    case 'git:update':
      return {
        ...snapshot,
        git: {
          branch: event.branch ?? snapshot.git.branch,
          baseBranch: event.baseBranch ?? snapshot.git.baseBranch,
          branchCreated: reported(event.branchCreated, snapshot.git.branchCreated),
          startCommit: snapshot.git.startCommit,
          commits: event.commits ?? snapshot.git.commits,
        },
        repository: {
          // `undefined` is "not collected", so the previous value stands; an
          // explicit `null` is "collected and unavailable" and overwrites it.
          name: reported(event.repositoryName, snapshot.repository.name),
          remoteUrl: reported(event.remoteUrl, snapshot.repository.remoteUrl),
          branch: event.branch ?? snapshot.repository.branch,
          headCommit: reported(event.headCommit, snapshot.repository.headCommit),
          root: reported(event.repositoryRoot, snapshot.repository.root),
        },
        pullRequests: event.pullRequests ?? snapshot.pullRequests,
      };
  }
}
