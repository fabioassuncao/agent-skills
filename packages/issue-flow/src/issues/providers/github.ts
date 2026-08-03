import { run } from '../../utils/shell.js';
import { hashIssueContent } from '../hash.js';
import type { IssueProvider } from '../provider.js';
import type { Issue, IssueDraft, IssueState } from '../types.js';

/** Fields requested from `gh issue view`, in the order the PRD specifies. */
const VIEW_FIELDS = 'number,title,body,labels,state,url,createdAt,updatedAt';

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

function toIssue(payload: GhIssuePayload): Issue {
  const title = typeof payload.title === 'string' ? payload.title : '';
  const body = typeof payload.body === 'string' ? payload.body : '';
  const number = typeof payload.number === 'number' ? payload.number : null;
  const url = typeof payload.url === 'string' && payload.url.length > 0 ? payload.url : null;

  return {
    id: number === null ? '' : String(number),
    number,
    title,
    body,
    labels: normalizeLabels(payload.labels),
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

function extractIssueNumber(output: string): string | null {
  return output.match(/\/issues\/(\d+)/)?.[1] ?? null;
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
    try {
      const version = await run('gh', ['--version'], { timeout: PROBE_TIMEOUT_MS });
      if (version.exitCode !== 0) return false;

      const auth = await run('gh', ['auth', 'status'], { timeout: PROBE_TIMEOUT_MS });
      return auth.exitCode === 0;
    } catch {
      return false;
    }
  }

  async get(id: string): Promise<Issue | null> {
    const issueId = normalizeId(id);
    const result = await run('gh', ['issue', 'view', issueId, '--json', VIEW_FIELDS]);

    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      if (NOT_FOUND_PATTERN.test(detail)) return null;
      throw new Error(
        `Failed to fetch GitHub issue #${issueId}: ${detail || 'gh issue view failed'}`,
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

    const result = await run('gh', args);
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(`Failed to create GitHub issue: ${detail || 'gh issue create failed'}`);
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

  async close(id: string): Promise<void> {
    const issueId = normalizeId(id);
    const result = await run('gh', ['issue', 'close', issueId]);

    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(
        `Failed to close GitHub issue #${issueId}: ${detail || 'gh issue close failed'}`,
      );
    }
  }
}

/** Shared instance; providers are stateless, so a singleton is enough. */
export const githubIssueProvider = new GitHubIssueProvider();
