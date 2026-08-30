import { loadIssuesConfig, loadPolicyConfig } from '../config.js';
import { DEFAULT_HEADLESS_TIMEOUT_MS, runHeadless } from '../core/headless.js';
import { applyPlaceholders, loadPrompt } from '../core/prompt-resolver.js';
import { publishPhaseMetrics } from '../core/session-metrics.js';
import { isoNow } from '../core/state-manager.js';
import { getGlobalTimeout } from '../core/verbose.js';
import { ensureProvidersRegistered } from '../issues/bootstrap.js';
import { localIssueRef } from '../issues/context.js';
import { IssueDraftParseError, parseIssueDraft } from '../issues/draft.js';
import { createMissingLabels, reconcileLabels } from '../issues/label-policy.js';
import { getProvider } from '../issues/registry.js';
import type { Issue, IssueDraft, IssueGenerateTarget } from '../issues/types.js';
import { loadRepositoryPolicy } from '../policy/index.js';
import { resolvePolicyPlaceholders } from '../policy/placeholders.js';
import { resolveProjectPaths } from '../storage/resolve.js';
import { printError, printInfo, printSuccess, printWarning } from '../ui/logger.js';

/** Human-readable pointer to a created Issue. */
function issueLocation(issue: Issue): string {
  return issue.remoteRef ?? localIssueRef(issue.id);
}

/**
 * Ask the agent for the Issue content.
 *
 * The agent only drafts: creation belongs to the providers, so the same draft
 * can be persisted to GitHub, to the local files, or to both.
 */
async function draftIssue(promptText: string): Promise<IssueDraft> {
  // The duplicate check reads the local issues, which live in the global
  // storage: the path has to be handed over (and allowed) explicitly, since it
  // is outside the working directory the agent is started in.
  const { issuesDir } = await resolveProjectPaths();

  const template = await loadPrompt('generate');
  const prompt = applyPlaceholders(template, {
    // The repository's own conventions. Empty when it declares none, which is
    // what keeps the rendered prompt identical to the pre-policy one.
    ...(await resolvePolicyPlaceholders()),
    __USER_PROMPT__: promptText,
    __LOCAL_ISSUES_DIR__: issuesDir,
  });

  const startedAtMs = Date.now();
  const result = await runHeadless({
    prompt,
    maxTurns: 15,
    timeout: getGlobalTimeout() ?? DEFAULT_HEADLESS_TIMEOUT_MS,
    // json (not text) so the CLI reports usage: the envelope's `result` field
    // carries the same assistant text parseIssueDraft() already consumed.
    outputFormat: 'json',
    allowedTools: ['Bash', 'Read', 'Glob', 'Grep'],
    addDirs: [issuesDir],
    statusMessage: 'Drafting issue...',
  });
  // Before the success check: the tokens were spent either way.
  publishPhaseMetrics('generate', result.cost, startedAtMs);

  if (!result.success) {
    throw new Error(`Issue creation failed: ${result.error}`);
  }

  return parseIssueDraft(result.result);
}

/**
 * Create the GitHub Issue and mirror it locally.
 *
 * The remote comes first on purpose: it owns the identifier, and the mirror has
 * to reuse it so both copies describe one demand. A remote failure therefore
 * leaves nothing behind, and a mirror failure is reported with the remote
 * reference that already exists.
 */
async function createBoth(draft: IssueDraft): Promise<Issue[]> {
  const remote = await getProvider('github').create(draft);

  try {
    const mirror = await getProvider('local').create({
      ...draft,
      id: remote.id,
      ...(remote.remoteRef
        ? {
            remote: {
              provider: 'github' as const,
              ref: remote.remoteRef,
              syncedAt: isoNow(),
              syncedContentHash: remote.contentHash,
            },
          }
        : {}),
    });
    return [remote, mirror];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `GitHub issue created at ${issueLocation(remote)}, but the local mirror was not written: ` +
        `${message}. Nothing else was persisted; re-run with --local to create the mirror.`,
    );
  }
}

async function createIssues(target: IssueGenerateTarget, draft: IssueDraft): Promise<Issue[]> {
  if (target === 'both') {
    return createBoth(draft);
  }
  return [await getProvider(target).create(draft)];
}

/**
 * Reconcile the draft's labels with the ones the repository really has.
 *
 * Two failures are being prevented here, and only one of them is cosmetic.
 * GitHub rejects an issue whose label does not exist, so an invented label costs
 * the whole Issue. And a tool that creates the label instead rewrites a taxonomy
 * the team may have curated deliberately — which is worse, because it succeeds.
 *
 * Never throws: a policy that could not be resolved leaves the draft untouched.
 */
async function applyLabelPolicy(draft: IssueDraft): Promise<IssueDraft> {
  let known: Awaited<ReturnType<typeof loadRepositoryPolicy>>['issues']['labels'];
  let allowCreation: boolean;
  try {
    const policy = await loadRepositoryPolicy();
    known = policy.issues.labels;
    const config = await loadPolicyConfig({ projectRoot: policy.root });
    allowCreation = config.issues.allowLabelCreation ?? false;
  } catch {
    return draft;
  }

  const { labels, missing } = reconcileLabels(draft.labels, known);
  if (missing.length === 0) {
    return { ...draft, labels };
  }

  if (!allowCreation) {
    printWarning(
      `Dropping ${missing.length} label(s) this repository does not have: ${missing.join(', ')}. ` +
        'Issue Flow does not create labels; set policy.issues.allowLabelCreation to change that.',
    );
    return { ...draft, labels };
  }

  const created = await createMissingLabels(missing, printWarning);
  return { ...draft, labels: [...labels, ...created] };
}

export async function runGenerate(
  promptText: string,
  target?: IssueGenerateTarget,
): Promise<number> {
  const config = await loadIssuesConfig();
  const destination = target ?? config.defaultGenerateTarget;

  ensureProvidersRegistered();

  let draft: IssueDraft;
  try {
    draft = await draftIssue(promptText);
  } catch (err) {
    if (err instanceof IssueDraftParseError) {
      printError(`Could not read the generated Issue draft: ${err.message}`);
    } else {
      printError(err instanceof Error ? err.message : String(err));
    }
    return 1;
  }

  const finalDraft = await applyLabelPolicy(draft);
  if (finalDraft.template !== undefined) {
    printInfo(`Following the repository's Issue Template: ${finalDraft.template}`);
  }
  if (finalDraft.type !== undefined) {
    printInfo(`Issue Type: ${finalDraft.type}`);
  }

  let created: Issue[];
  try {
    created = await createIssues(destination, finalDraft);
  } catch (err) {
    printError(err instanceof Error ? err.message : String(err));
    return 1;
  }

  for (const issue of created) {
    printSuccess(`Issue created (${issue.source}): ${issueLocation(issue)}`);
  }
  return 0;
}
