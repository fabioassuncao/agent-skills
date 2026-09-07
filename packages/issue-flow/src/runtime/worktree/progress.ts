/**
 * What is being created right now.
 *
 * Ported from WebMux `backend/src/services/worktree-creation-service.ts`
 * @ d8c9d5f (40 LOC). Creating a worktree takes long enough — a checkout, a
 * hook, a runtime — that a caller polling "which worktrees exist" would see
 * nothing at all until it finished. This is what makes the gap observable, and
 * it is also the lock that stops two creations of the same branch.
 */

export type WorktreeCreationPhase =
  | 'creating_worktree'
  | 'running_post_create_hook'
  | 'preparing_runtime'
  | 'starting_session'
  | 'reconciling';

/** Who asked for the worktree. Kept from the upstream: it survives into the UI. */
export type WorktreeSource = 'cli' | 'ui' | 'api' | 'oneshot';

export interface WorktreeCreationProgress {
  branch: string;
  baseBranch?: string;
  path: string;
  phase: WorktreeCreationPhase;
  source: WorktreeSource;
}

export class WorktreeCreationTracker {
  private readonly creating = new Map<string, WorktreeCreationProgress>();

  set(progress: WorktreeCreationProgress): void {
    this.creating.set(progress.branch, { ...progress });
  }

  clear(branch: string): boolean {
    return this.creating.delete(branch);
  }

  has(branch: string): boolean {
    return this.creating.has(branch);
  }

  /** Sorted by branch so a poller sees a stable order rather than insertion order. */
  list(): WorktreeCreationProgress[] {
    return [...this.creating.values()]
      .sort((left, right) => left.branch.localeCompare(right.branch))
      .map((state) => ({ ...state }));
  }
}
