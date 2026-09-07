import { createHash } from 'node:crypto';
import { isoNow } from '../../core/state-manager.js';
import {
  closeStoredInlineIssue,
  type InlineIssueAddress,
  loadStoredInlineIssue,
  saveStoredInlineIssue,
} from '../../storage/db/inline-issues.js';
import { resolveProjectPaths } from '../../storage/resolve.js';
import { getProjectRoot } from '../../utils/git.js';
import { hashIssueContent } from '../hash.js';
import type { IssueProvider } from '../provider.js';
import type { Issue, IssueDraft } from '../types.js';

/**
 * The origin of a demand typed straight into the command line.
 *
 * §17 of the absorption plan converges `webmux oneshot` into `issue-flow run`,
 * and the first of its three clauses is that a free prompt is accepted **as an
 * Issue**, under `source: 'inline'`. That is the whole design: `--prompt` does
 * not open a second, lighter execution path with fewer guarantees — it mints an
 * Issue, and from there every phase, the acceptance contract and the
 * independent reviewer run exactly as they do for a GitHub or a local one.
 *
 * What makes it a *provider* rather than a special case inside `run` is that
 * the pipeline re-resolves its Issue by id: `resume` does, and so does the
 * closure re-query. An inline demand that only existed in the argv of one
 * invocation would be unresumable, which is the one thing a long run cannot be.
 */

/** `inline-` plus twelve hex characters. Nothing else is ours to answer for. */
const INLINE_ID = /^inline-[0-9a-f]{12}$/;

/** Longest first line still readable as a title in a terminal summary. */
const TITLE_LIMIT = 72;

export const INLINE_ISSUE_SOURCE = 'inline' as const;

/**
 * Whether an identifier belongs to this origin.
 *
 * Exported because the resolver queries **every** registered origin for every
 * identifier: without this, `issue-flow run 42` would open the database once
 * per run to learn that 42 is not an inline id. Answering from the shape is
 * both faster and the reason two origins can never claim the same identifier.
 */
export function isInlineIssueId(id: string): boolean {
  return INLINE_ID.test(id.trim());
}

/** Content-addressed identity: the same demand is the same Issue. */
export function inlineIssueId(prompt: string): string {
  const normalized = prompt.replace(/\r\n?/g, '\n').trim();
  return `inline-${createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12)}`;
}

/**
 * Title of an inline demand: its first non-empty line, shortened.
 *
 * A prompt is not written like an Issue — it has no title — and every surface
 * that shows a run (the summary, the dashboard, the branch name) needs one.
 * Taking the first line is what a person would do reading it aloud; the body
 * keeps the prompt whole, so nothing is lost by the shortening.
 */
export function inlineIssueTitle(prompt: string): string {
  const firstLine =
    prompt
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trim().replace(/^#+\s*/, ''))
      .find((line) => line.length > 0) ?? '';
  if (firstLine === '') return 'Inline prompt';
  if (firstLine.length <= TITLE_LIMIT) return firstLine;
  return `${firstLine.slice(0, TITLE_LIMIT - 1).trimEnd()}…`;
}

async function address(): Promise<InlineIssueAddress | null> {
  try {
    const project = await resolveProjectPaths();
    // The demand is stored in SQLite, so a project still on the legacy JSON
    // store has no inline origin. It is reported as unavailable rather than
    // failing mid-run: every other origin keeps working.
    if (project.storageDriver !== 'sqlite') return null;
    return {
      projectId: project.projectId,
      projectRoot: await getProjectRoot(),
      ...(project.databaseOptions === undefined
        ? {}
        : { databaseOptions: project.databaseOptions }),
    };
  } catch {
    return null;
  }
}

export class InlineIssueProvider implements IssueProvider {
  readonly name = INLINE_ISSUE_SOURCE;

  /** Never throws: an origin that cannot be used reports, it does not raise. */
  async isAvailable(): Promise<boolean> {
    return (await address()) !== null;
  }

  /**
   * `inline-<12 hex>` is minted here and nowhere else, so an identifier of that
   * shape can only be ours. Declaring it keeps `issue-flow resume inline-…`
   * from asking GitHub about an identifier it could never have.
   */
  claims(id: string): boolean {
    return isInlineIssueId(id);
  }

  async get(id: string): Promise<Issue | null> {
    const normalized = id.trim();
    if (!isInlineIssueId(normalized)) return null;
    const at = await address();
    if (at === null) return null;
    const stored = await loadStoredInlineIssue(at, normalized);
    if (stored === null) return null;
    return {
      id: stored.id,
      // Deliberately `null`: an inline demand has no number, and inventing one
      // would put it in the same namespace as the repository's real Issues.
      number: null,
      title: stored.title,
      body: stored.body,
      labels: [],
      state: stored.state,
      source: this.name,
      remoteRef: null,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      contentHash: stored.contentHash,
    };
  }

  /**
   * Record a demand.
   *
   * `draft.id` is honoured when the caller already derived one (which
   * {@link mintInlineIssue} does, from the prompt) so that re-running the same
   * `--prompt` addresses the same Issue instead of accumulating twins.
   */
  async create(draft: IssueDraft): Promise<Issue> {
    const at = await address();
    if (at === null) {
      throw new Error(
        'The inline Issue origin needs the SQLite store. Run `issue-flow init` in a git repository first.',
      );
    }
    const id =
      draft.id !== undefined && isInlineIssueId(draft.id) ? draft.id : inlineIssueId(draft.body);
    const now = isoNow();
    const stored = await saveStoredInlineIssue(at, {
      id,
      title: draft.title,
      body: draft.body,
      state: 'open',
      contentHash: hashIssueContent(draft.title, draft.body),
      createdAt: now,
      updatedAt: now,
    });
    return {
      id: stored.id,
      number: null,
      title: stored.title,
      body: stored.body,
      labels: [],
      state: stored.state,
      source: this.name,
      remoteRef: null,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      contentHash: stored.contentHash,
    };
  }

  async close(id: string): Promise<void> {
    const normalized = id.trim();
    if (!isInlineIssueId(normalized)) {
      throw new Error(`Not an inline Issue identifier: '${id}'`);
    }
    const at = await address();
    if (at === null) {
      throw new Error('The inline Issue origin is unavailable; cannot close the demand.');
    }
    if (!(await closeStoredInlineIssue(at, normalized, isoNow()))) {
      throw new Error(`Inline issue '${normalized}' does not exist in this project.`);
    }
  }
}

export const inlineIssueProvider = new InlineIssueProvider();

/**
 * Turn a free prompt into the Issue the pipeline will work on.
 *
 * Idempotent by identity: the identifier is the hash of the prompt, so the
 * second `issue-flow run --prompt "<same text>"` resumes the first one's Issue
 * rather than starting a parallel history for the same demand.
 */
export async function mintInlineIssue(prompt: string): Promise<Issue> {
  const body = prompt.replace(/\r\n?/g, '\n').trim();
  return inlineIssueProvider.create({
    id: inlineIssueId(body),
    title: inlineIssueTitle(body),
    body,
    labels: [],
  });
}
