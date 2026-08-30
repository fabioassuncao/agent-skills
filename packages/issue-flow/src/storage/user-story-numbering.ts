import { readdir, readFile } from 'node:fs/promises';
import { isoNow } from '../core/state-manager.js';
import { getProjectRoot } from '../utils/git.js';
import { recordUserStoryNumbering } from './compat.js';
import { getIssuePaths } from './paths.js';
import { type ResolveIssuePathsOptions, resolveProjectPaths } from './resolve.js';
import type { UserStoryNumberingDecision } from './schemas.js';

/**
 * Continuity of `US-NNN` numbering across `plan` executions of the same
 * project (issue #36).
 *
 * The User Story `id` field is free-form — `userStorySchema` in
 * `src/schemas.ts` only requires a non-empty string, no `US-NNN` regex is
 * enforced — so every reader here tolerates an id that does not carry a
 * trailing number instead of throwing on it.
 */

const USER_STORY_ID_PAD = 3;

/** `16` -> `'US-016'`. Numbers past 999 are not padded further. */
export function formatUserStoryId(n: number): string {
  return `US-${String(n).padStart(USER_STORY_ID_PAD, '0')}`;
}

/**
 * Extract the last run of digits from a User Story id, or `null` when none is
 * found. Tolerant by design: an id like `US-001` yields `1`, but so does a
 * free-form one such as `story-1` or `v2-US-007` (the last digit run, `007`,
 * wins over the `2` version prefix) — only an id with no digits at all (e.g.
 * `add-auth`) is ignored.
 */
export function parseUserStoryNumber(id: string): number | null {
  const matches = id.match(/\d+/g);
  if (!matches || matches.length === 0) return null;

  const value = Number.parseInt(matches[matches.length - 1], 10);
  return Number.isNaN(value) ? null : value;
}

export interface HighestUserStoryNumberResult {
  number: number;
  /** Issue directory name the winning story came from. */
  issueId: string;
  /** Verbatim id of the winning story. */
  storyId: string;
}

/**
 * Loose read of one `tasks.json`: only cares about `userStories[].id` and
 * tolerates every failure (missing file, invalid JSON, unexpected shape) by
 * returning `null` — a sibling issue mid-migration, or with a corrupt plan,
 * must not abort the whole project scan.
 */
async function readUserStoryIds(tasksPath: string): Promise<string[] | null> {
  let raw: string;
  try {
    raw = await readFile(tasksPath, 'utf-8');
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as { userStories?: unknown }).userStories)
    ) {
      return null;
    }

    return (parsed as { userStories: unknown[] }).userStories
      .map((story) =>
        typeof story === 'object' &&
        story !== null &&
        typeof (story as { id?: unknown }).id === 'string'
          ? (story as { id: string }).id
          : null,
      )
      .filter((id): id is string => id !== null);
  } catch {
    return null;
  }
}

export interface FindHighestUserStoryNumberOptions extends ResolveIssuePathsOptions {
  /**
   * Issue directory to leave out of the scan — the issue the numbering is
   * being resolved for. Re-planning an issue overwrites its own `tasks.json`,
   * so counting the plan about to be replaced would push the numbering forward
   * on every `plan` re-run of the same issue.
   */
  excludeIssueId?: string;
}

/**
 * Highest User Story number already used anywhere in the project, scanning
 * every `<issuesDir>/<id>/tasks.json` regardless of which issue produced it —
 * that project-wide scope is what makes `US-NNN` unambiguous across issues.
 * The issue named by `excludeIssueId` is skipped, so re-planning is idempotent.
 *
 * `null` means no readable `tasks.json` was found (the project's first `plan`
 * run ever, or a brand-new project directory). A storage directory that exists
 * but cannot be read throws instead: silently restarting at `US-001` because
 * `~/.issue-flow` was momentarily unreadable is the worst outcome this feature
 * can produce.
 */
export async function findHighestUserStoryNumber(
  options: FindHighestUserStoryNumberOptions = {},
): Promise<HighestUserStoryNumberResult | null> {
  const { excludeIssueId, ...rootOptions } = options;
  const { projectId, issuesDir } = await resolveProjectPaths(rootOptions);

  let entries: string[];
  try {
    entries = (await readdir(issuesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    // ENOENT is the legitimate "no history yet" case. Any other failure
    // (EACCES, EIO, an unavailable mount) must not be reported as an empty
    // history, or the numbering would restart silently.
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw new Error(
      `Could not scan the project's User Story history at ${issuesDir}: ` +
        `${(error as Error).message}. Fix the storage directory, or pass --start-us <n> ` +
        'to set the numbering explicitly.',
      { cause: error },
    );
  }

  let best: HighestUserStoryNumberResult | null = null;

  for (const issueId of entries) {
    if (excludeIssueId !== undefined && issueId === excludeIssueId) continue;
    // Never hand-build an artifact path (see src/storage/AGENTS.md): asking
    // getIssuePaths() keeps a rename of `tasks.json` a one-file change instead
    // of silently making this scan find nothing.
    const { tasksFile } = getIssuePaths(projectId, issueId, { env: options.env });
    const ids = await readUserStoryIds(tasksFile);
    if (!ids) continue;

    for (const id of ids) {
      const value = parseUserStoryNumber(id);
      if (value === null) continue;
      if (best === null || value > best.number) {
        best = { number: value, issueId, storyId: id };
      }
    }
  }

  return best;
}

export interface ResolveUserStoryNumberingOptions extends ResolveIssuePathsOptions {
  /** Issue the decision is being made for — carried into the audit record. */
  issueNumber: string;
  /** `--continue` was passed explicitly. Purely cosmetic on the log message:
   * the resolved number is identical to the automatic default. */
  continueFlag?: boolean;
  /** `--start-us <n>` was passed. Wins outright over any history. */
  startUs?: number;
  /** Timestamp source, injectable for tests. */
  now?: () => string;
}

export interface UserStoryNumberingOutcome {
  decision: UserStoryNumberingDecision;
  /** Ready-to-print explanation of where the decision came from — the CLI
   * must never resolve this silently (issue #36). */
  message: string;
}

/**
 * Resolve the numbering cascade of #36:
 *
 * 1. `--start-us <n>` wins outright — history is not even scanned, since the
 *    whole point is to ignore it.
 * 2. Otherwise the project's history is scanned for the highest number used
 *    so far. This is what running with no flag at all does automatically,
 *    and what `--continue` names explicitly (the two produce the same
 *    number; the flag only changes the log message).
 * 3. No history found (the project's first `plan` ever) starts at `US-001`.
 *
 * Pure with respect to `metadata.json` — this only reads `tasks.json` files,
 * never writes. Persisting the decision is {@link determineUserStoryNumbering}
 * below, via `recordUserStoryNumbering()` in `compat.ts`.
 */
export async function resolveUserStoryNumbering(
  options: ResolveUserStoryNumberingOptions,
): Promise<UserStoryNumberingOutcome> {
  const { issueNumber, continueFlag, startUs, now, ...rootOptions } = options;
  const decidedAt = (now ?? isoNow)();

  if (startUs !== undefined) {
    const decision: UserStoryNumberingDecision = {
      nextNumber: startUs,
      source: 'start-us',
      issueNumber,
      decidedAt,
    };
    return {
      decision,
      message: `User Story numbering forced to ${formatUserStoryId(startUs)} via --start-us.`,
    };
  }

  // The issue being planned is excluded from the scan: `plan` overwrites its
  // own `tasks.json`, so counting the plan it is about to replace would push
  // the numbering forward on every re-run of `plan` for the same issue.
  const highest = await findHighestUserStoryNumber({ ...rootOptions, excludeIssueId: issueNumber });

  if (highest === null) {
    const decision: UserStoryNumberingDecision = {
      nextNumber: 1,
      source: 'none',
      issueNumber,
      decidedAt,
    };
    return {
      decision,
      message: `Starting User Story numbering at ${formatUserStoryId(1)} (no previous history found for this project).`,
    };
  }

  const nextNumber = highest.number + 1;
  const decision: UserStoryNumberingDecision = {
    nextNumber,
    source: 'history',
    issueNumber,
    decidedAt,
    detail: `${highest.storyId} (issue #${highest.issueId})`,
  };
  const via = continueFlag ? ' via --continue' : '';
  return {
    decision,
    message:
      `Continuing User Story numbering from ${formatUserStoryId(nextNumber)}${via} ` +
      `— last used was ${highest.storyId} (issue #${highest.issueId}).`,
  };
}

export interface DetermineUserStoryNumberingOptions extends ResolveUserStoryNumberingOptions {
  /** Repository root. Defaults to the git toplevel of the current directory. */
  projectRoot?: string;
}

export interface UserStoryNumberingResult extends UserStoryNumberingOutcome {
  /** `decision.nextNumber` formatted as `US-NNN`, ready for the prompt. */
  nextUserStoryId: string;
}

/**
 * The entry point commands use: resolve the cascade and persist the decision
 * into `metadata.json` in one call, so no call site can log/prompt with one
 * decision and audit a different one.
 */
export async function determineUserStoryNumbering(
  options: DetermineUserStoryNumberingOptions,
): Promise<UserStoryNumberingResult> {
  const { projectRoot: projectRootOption, ...rest } = options;
  const projectRoot = projectRootOption ?? (await getProjectRoot());

  const outcome = await resolveUserStoryNumbering({ ...rest, projectRoot });
  await recordUserStoryNumbering(projectRoot, outcome.decision, {
    env: options.env,
    now: options.now,
  });

  return { ...outcome, nextUserStoryId: formatUserStoryId(outcome.decision.nextNumber) };
}
