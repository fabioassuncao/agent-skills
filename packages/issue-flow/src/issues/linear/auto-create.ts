import type { ResolvedAgentSessionContext } from '../../agents/session/context.js';
import { openManagedWorktrees } from '../../agents/session/worktree-control.js';
import { branchMatchesLinearIssue, type LinearClient, type LinearIssue } from './client.js';

export const LINEAR_AUTO_CREATE_INTERVAL_MS = 60_000;
export const LINEAR_AUTO_CREATE_LABEL = 'issue-flow';

export interface LinearAutoCreateDeps {
  context: ResolvedAgentSessionContext;
  client: LinearClient;
  agentId: string;
  watchTeams?: readonly string[];
  processed?: Set<string>;
  signal?: AbortSignal;
  openWorktrees?: typeof openManagedWorktrees;
  onInfo?: (message: string) => void;
  onError?: (message: string) => void;
}

function hasAutoCreateLabel(issue: LinearIssue): boolean {
  return issue.labels.some((label) => label.name.trim().toLowerCase() === LINEAR_AUTO_CREATE_LABEL);
}

export function filterLinearAutoCreateIssues(
  issues: readonly LinearIssue[],
  existingBranches: ReadonlySet<string>,
  processed: ReadonlySet<string>,
  watchTeams: readonly string[] = [],
): LinearIssue[] {
  const teams = new Set(watchTeams.map((key) => key.toUpperCase()));
  return issues.filter(
    (issue) =>
      issue.state.type === 'unstarted' &&
      hasAutoCreateLabel(issue) &&
      (teams.size === 0 || teams.has(issue.team.key.toUpperCase())) &&
      !processed.has(issue.id) &&
      ![...existingBranches].some((branch) => branchMatchesLinearIssue(branch, issue.branchName)),
  );
}

/** One headless Linear pickup pass. No issue title or description enters logs. */
export async function runLinearAutoCreateOnce(deps: LinearAutoCreateDeps): Promise<string[]> {
  const processed = deps.processed ?? new Set<string>();
  const issues = await deps.client.fetchAssignedIssues({ signal: deps.signal });
  if (deps.signal?.aborted) return [];
  const eligibleIds = new Set(
    issues
      .filter((issue) => issue.state.type === 'unstarted' && hasAutoCreateLabel(issue))
      .map((issue) => issue.id),
  );
  for (const id of processed) if (!eligibleIds.has(id)) processed.delete(id);

  // Use git's raw registry rather than only live managed worktrees. A stale or
  // externally-created registration still owns its branch and must suppress a
  // second creation attempt.
  const existing = new Set(
    (await deps.context.git.listWorktrees(deps.context.projectRoot))
      .filter((entry) => !entry.bare && entry.branch !== null)
      .map((entry) => entry.branch as string),
  );
  const created: string[] = [];
  for (const issue of filterLinearAutoCreateIssues(issues, existing, processed, deps.watchTeams)) {
    if (deps.signal?.aborted) break;
    try {
      const result = await (deps.openWorktrees ?? openManagedWorktrees)(
        { initial: deps.context, resolveContext: async () => deps.context },
        {
          agents: [deps.agentId],
          mode: 'new',
          branch: issue.branchName,
          prompt: `${issue.title}\n\n${issue.description ?? ''}`.trim(),
          source: 'ui',
        },
      );
      created.push(result.primaryBranch);
      processed.add(issue.id);
      deps.onInfo?.(`created worktree for Linear issue ${issue.identifier}`);
    } catch (error) {
      processed.add(issue.id);
      deps.onError?.(
        `failed to create worktree for Linear issue ${issue.identifier}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return created;
}
