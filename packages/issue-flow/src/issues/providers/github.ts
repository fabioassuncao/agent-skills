import type { ClassifiedFailure } from '../../resilience/errors.js';
import { ClassifiedError, requiresHumanAction } from '../../resilience/errors.js';
import { type ExecResult, run } from '../../utils/shell.js';
import { gh, ghProbePolicy } from '../github/index.js';
import { hashIssueContent } from '../hash.js';
import type { IssueProvider, ProviderAvailability } from '../provider.js';
import { emptyRelations, mergeRelations, parseTextualRelations, uniqueIds } from '../relations.js';
import type { Issue, IssueDraft, IssueRelations, IssueState } from '../types.js';

/** Fields requested from `gh issue view`, in the order the PRD specifies. */
const VIEW_FIELDS = 'number,title,body,labels,state,url,createdAt,updatedAt,issueType';

/** Timeout for the availability probes, matching the `init` prerequisite checks. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * gh reports a missing Issue on stderr with one of these phrasings. The match
 * must stay issue-specific: a bare /not found/ would also swallow
 * `gh: command not found`, turning a broken environment into "issue absent".
 * Anything else on a non-zero exit is a real failure (network, auth, gh not
 * installed) and must surface as a thrown error.
 */
const NOT_FOUND_PATTERN =
  /could not resolve to an issue|no issues? found|issue not found|could not find any issue/i;

interface GhLabel {
  name?: unknown;
}

interface GhIssuePayload {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  labels?: unknown;
  state?: unknown;
  url?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  issueType?: unknown;
}

function normalizeState(state: unknown): IssueState {
  return String(state ?? '').toUpperCase() === 'CLOSED' ? 'closed' : 'open';
}

function normalizeLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((label: GhLabel | string) => (typeof label === 'string' ? label : label?.name))
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

function normalizeIssueType(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value !== null && typeof value === 'object' && 'name' in value) {
    const name = (value as { name: unknown }).name;
    return typeof name === 'string' && name.length > 0 ? name : undefined;
  }
  return undefined;
}

function toIssue(payload: GhIssuePayload): Issue {
  const title = typeof payload.title === 'string' ? payload.title : '';
  const body = typeof payload.body === 'string' ? payload.body : '';
  const number = typeof payload.number === 'number' ? payload.number : null;
  const url = typeof payload.url === 'string' && payload.url.length > 0 ? payload.url : null;
  const type = normalizeIssueType(payload.issueType);

  return {
    id: number === null ? '' : String(number),
    number,
    title,
    body,
    labels: normalizeLabels(payload.labels),
    ...(type === undefined ? {} : { type }),
    state: normalizeState(payload.state),
    source: 'github',
    remoteRef: url,
    createdAt: typeof payload.createdAt === 'string' ? payload.createdAt : '',
    updatedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : '',
    contentHash: hashIssueContent(title, body),
    raw: payload,
  };
}

/** Strip a leading `#` so both `23` and `#23` are accepted. */
function normalizeId(id: string): string {
  return id.trim().replace(/^#/, '');
}

/** Page size for the relation endpoints — one page is enough in practice. */
const API_PAGE_SIZE = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `gh api <path>`, parsed as JSON.
 *
 * Answers `null` for every failure — a disabled feature (404), a plan without
 * Issue Dependencies (403), a network hiccup or unparseable output. That is the
 * whole graceful-degradation contract of `fetchRelations`: a source that cannot
 * answer contributes nothing instead of failing the discovery.
 */
async function ghApiJson(path: string): Promise<unknown> {
  try {
    const result = await gh(['api', path]);
    if (result.exitCode !== 0) return null;
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return null;
  }
}

/** `number` of an Issue-shaped payload, as a string id. */
function issueNumberOf(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const number = value.number;
  return typeof number === 'number' && Number.isInteger(number) ? String(number) : null;
}

/** Ids of an array of Issue-shaped payloads, skipping anything unusable. */
function issueNumbersOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueIds(
    value.map((entry) => issueNumberOf(entry) ?? '').filter((entry) => entry !== ''),
  );
}

/**
 * Issues that cited this one, from the timeline's `cross-referenced` events.
 *
 * Pull Requests are filtered out: they reference the Issue as *work on it*, not
 * as another demand to schedule.
 */
function crossReferences(timeline: unknown, self: string): string[] {
  if (!Array.isArray(timeline)) return [];

  const ids: string[] = [];
  for (const event of timeline) {
    if (!isRecord(event) || event.event !== 'cross-referenced') continue;
    const source = isRecord(event.source) ? event.source : null;
    const issue = isRecord(source?.issue) ? source.issue : null;
    if (issue === null || issue.pull_request !== undefined) continue;
    const number = issueNumberOf(issue);
    if (number !== null) ids.push(number);
  }

  return uniqueIds(ids, self);
}

function extractIssueNumber(output: string): string | null {
  return output.match(/\/issues\/(\d+)/)?.[1] ?? null;
}

/**
 * A failed `gh` result turned into an error that still carries its verdict.
 *
 * `run()` already classified it — every `gh` call here goes through the retry
 * chokepoint — so the kind, and with it the "retry or escalate" decision, must
 * not be flattened back into a message by the throw.
 */
function ghError(message: string, result: ExecResult): Error {
  const failure = result.failure;
  if (failure === undefined) return new Error(message);
  return new ClassifiedError(message, failure, ghAction(failure));
}

/** The action a human has to take, for the kinds that need one. */
function ghAction(failure: ClassifiedFailure): string | undefined {
  if (!requiresHumanAction(failure.kind)) return undefined;
  if (failure.kind === 'authentication') {
    return 'Run `gh auth login` to authenticate the GitHub CLI';
  }
  return undefined;
}

/**
 * A failed probe as an availability answer, keeping the classification.
 *
 * `action` is only attached when the failure actually needs a human: telling
 * someone to run `gh auth login` because their Wi-Fi dropped is worse than
 * saying nothing, and the caller uses the presence of an action to decide that
 * waiting will not help.
 */
function unavailable(result: ExecResult, action: string): ProviderAvailability {
  const failure = result.failure;
  const needsHuman = failure === undefined || requiresHumanAction(failure.kind);
  return {
    available: false,
    ...(failure === undefined ? {} : { failure }),
    ...(needsHuman ? { action } : {}),
  };
}

/**
 * Issue provider backed by the GitHub CLI.
 *
 * Every call goes through `run` (execa, no shell) so tests can mock the shell
 * layer instead of the network, and so the Issue content is identical across
 * every pipeline phase.
 */
export class GitHubIssueProvider implements IssueProvider {
  readonly name = 'github' as const;

  /** True when gh is installed and authenticated. Never throws. */
  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).available;
  }

  /**
   * Whether gh is installed and authenticated, with the reason when it is not.
   *
   * Both probes retry on the capped probe budget, so a DNS blip during a long
   * run no longer reports GitHub as unavailable and takes the whole run down
   * with it — while an authentication failure is clamped to zero attempts by
   * `resolvePolicy()` and comes back immediately, with the action to take.
   */
  async checkAvailability(): Promise<ProviderAvailability> {
    try {
      const retry = ghProbePolicy();

      const version = await run('gh', ['--version'], { retry, timeout: PROBE_TIMEOUT_MS });
      if (version.exitCode !== 0) {
        return unavailable(version, 'Install the GitHub CLI: https://cli.github.com');
      }

      const auth = await run('gh', ['auth', 'status'], { retry, timeout: PROBE_TIMEOUT_MS });
      if (auth.exitCode !== 0) {
        return unavailable(auth, 'Run `gh auth login` to authenticate the GitHub CLI');
      }

      return { available: true };
    } catch {
      return { available: false };
    }
  }

  async get(id: string): Promise<Issue | null> {
    const issueId = normalizeId(id);
    const result = await gh(['issue', 'view', issueId, '--json', VIEW_FIELDS]);

    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      if (NOT_FOUND_PATTERN.test(detail)) return null;
      throw ghError(
        `Failed to fetch GitHub issue #${issueId}: ${detail || 'gh issue view failed'}`,
        result,
      );
    }

    let payload: GhIssuePayload;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `Failed to parse gh output for issue #${issueId}: ${result.stdout.slice(0, 200)}`,
      );
    }

    return toIssue(payload);
  }

  async create(draft: IssueDraft): Promise<Issue> {
    const args = ['issue', 'create', '--title', draft.title, '--body', draft.body];
    for (const label of draft.labels) {
      args.push('--label', label);
    }
    // Only when the draft actually chose one. An organization without Issue
    // Types rejects the flag outright, so it must never be sent speculatively.
    if (draft.type !== undefined && draft.type !== '') {
      args.push('--type', draft.type);
    }

    const result = await gh(args);
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw ghError(`Failed to create GitHub issue: ${detail || 'gh issue create failed'}`, result);
    }

    const number = extractIssueNumber(result.stdout);
    if (!number) {
      throw new Error(
        `GitHub issue creation did not report an issue URL: ${result.stdout.trim() || '(no output)'}`,
      );
    }

    const created = await this.get(number);
    if (!created) {
      throw new Error(`GitHub issue #${number} was created but could not be read back`);
    }
    return created;
  }

  /**
   * Hierarchy and dependencies of an Issue, reconciled from three GitHub
   * mechanisms that only partially overlap:
   *
   * 1. **Sub-issues** (`/sub_issues` plus the `parent` field of the Issue
   *    payload) — the native hierarchy;
   * 2. **Issue Dependencies** (`/dependencies/blocked_by` and `/blocking`);
   * 3. the **textual heuristic** over the body, for repositories that adopted
   *    neither and write `Depends on #12` or `- [ ] #13` instead.
   *
   * Cross-references (`referencedBy`) come from the issue timeline, which is
   * the only place GitHub reports "who cited me" without a search query.
   *
   * Every source is queried independently and is allowed to fail on its own: an
   * organization without Issue Dependencies enabled answers 404 for two of the
   * five calls, and that has to cost the caller those two fields, never the
   * whole discovery. Only what could be read is reported — nothing here throws.
   */
  async fetchRelations(id: string): Promise<IssueRelations> {
    const issueId = normalizeId(id);
    if (!/^\d+$/.test(issueId)) {
      // A non-numeric identifier cannot address a GitHub REST endpoint; the
      // Issue simply has no relations we can discover.
      return emptyRelations(issueId);
    }

    const base = `repos/{owner}/{repo}/issues/${issueId}`;
    const [payload, subIssues, blockedBy, blocking, timeline] = await Promise.all([
      ghApiJson(base),
      ghApiJson(`${base}/sub_issues?per_page=${API_PAGE_SIZE}`),
      ghApiJson(`${base}/dependencies/blocked_by?per_page=${API_PAGE_SIZE}`),
      ghApiJson(`${base}/dependencies/blocking?per_page=${API_PAGE_SIZE}`),
      ghApiJson(`${base}/timeline?per_page=${API_PAGE_SIZE}`),
    ]);

    const issue = isRecord(payload) ? payload : null;
    // Without the REST payload the body still comes from `gh issue view`, so a
    // repository where only the REST API is blocked keeps the textual fallback.
    const body = typeof issue?.body === 'string' ? issue.body : await this.bodyFallback(issueId);

    const structured = {
      id: issueId,
      parent: issueNumberOf(issue?.parent),
      children: issueNumbersOf(subIssues),
      blockedBy: issueNumbersOf(blockedBy),
      blocking: issueNumbersOf(blocking),
      references: [],
      referencedBy: crossReferences(timeline, issueId),
    };

    return mergeRelations(structured, parseTextualRelations(body, issueId));
  }

  /** Body of an Issue when the REST payload could not be read. Never throws. */
  private async bodyFallback(issueId: string): Promise<string> {
    try {
      return (await this.get(issueId))?.body ?? '';
    } catch {
      return '';
    }
  }

  async close(id: string): Promise<void> {
    const issueId = normalizeId(id);
    const result = await gh(['issue', 'close', issueId]);

    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw ghError(
        `Failed to close GitHub issue #${issueId}: ${detail || 'gh issue close failed'}`,
        result,
      );
    }
  }
}

/** Shared instance; providers are stateless, so a singleton is enough. */
export const githubIssueProvider = new GitHubIssueProvider();
