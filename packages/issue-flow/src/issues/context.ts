import { actionOf, classify, requiresHumanAction } from '../resilience/errors.js';
import { printError, printWarning } from '../ui/logger.js';
import { IssueResolutionError, type ResolveIssueOptions, resolveIssue } from './resolver.js';
import type { Issue, ResolvedIssue } from './types.js';

/**
 * Bridge between the resolved Issue and the phase prompts.
 *
 * Commands never fetch the Issue themselves: they resolve it once through
 * `resolveIssue` and hand the content to the template, so every phase sees the
 * exact same title/body regardless of where the demand came from.
 */

/** Path of the markdown file a local Issue lives in. */
export function localIssueRef(id: string): string {
  return `issues/${id}/issue.md`;
}

/**
 * Reference a human (or an agent) can follow to read the Issue: the remote URL
 * when there is one, the local file otherwise.
 */
export function issueReference(issue: Issue, localPath?: string): string {
  return issue.remoteRef ?? localPath ?? localIssueRef(issue.id);
}

/** Shown instead of an empty list so the prompt never renders a dangling label. */
const NO_LABELS = '(none)';

/**
 * Placeholder values every phase template consumes, replacing the former
 * `gh issue view` instruction.
 */
export function issuePlaceholders(
  resolved: ResolvedIssue,
  localPath?: string,
): Record<string, string> {
  const { issue } = resolved;
  return {
    __ISSUE_TITLE__: issue.title,
    __ISSUE_BODY__: issue.body,
    __ISSUE_LABELS__: issue.labels.length > 0 ? issue.labels.join(', ') : NO_LABELS,
    __ISSUE_SOURCE__: resolved.source,
    __ISSUE_URL__: issueReference(issue, localPath),
  };
}

export type CommandIssue = { ok: true; resolved: ResolvedIssue } | { ok: false; code: number };

/**
 * Resolve the Issue a command works on, turning a resolution failure into the
 * exit code the command returns.
 *
 * `preResolved` short-circuits the lookup: the pipeline decides the origin once
 * and passes the decision down, so a phase never re-queries the providers (and
 * never asks the user twice about the same divergence).
 *
 * `options` forwards resolver options — `run.ts` passes the configuration it
 * already loaded so `.issue-flow.json` is read (and warned about) only once.
 */
export async function resolveCommandIssue(
  id: string,
  preResolved?: ResolvedIssue,
  options?: ResolveIssueOptions,
): Promise<CommandIssue> {
  if (preResolved !== undefined) {
    return { ok: true, resolved: preResolved };
  }

  try {
    return { ok: true, resolved: await resolveIssue(id, options) };
  } catch (err) {
    if (err instanceof IssueResolutionError) {
      printError(err.message);
      printAction(err.action);
      return { ok: false, code: err.exitCode };
    }
    const message = err instanceof Error ? err.message : String(err);
    printError(`Could not resolve issue '${id}': ${message}`);
    printAction(actionOf(err) ?? requiredAction(message));
    return { ok: false, code: 1 };
  }
}

/**
 * What a human has to do about a failure that no amount of waiting fixes.
 *
 * The retry budget was already spent inside the providers — every `gh` call
 * goes through `run()` with the `network`/`rate_limit` policy — so by the time
 * a failure reaches here it is final. What is left to decide is whether it is
 * final *because a person has to act*, and that is what turns an opaque exit
 * code into an instruction.
 */
function requiredAction(message: string): string | null {
  const failure = classify({ source: 'github', stderr: message });
  if (!requiresHumanAction(failure.kind)) return null;
  if (failure.kind === 'authentication') {
    return 'Run `gh auth login` to authenticate the GitHub CLI';
  }
  return null;
}

function printAction(action: string | null | undefined): void {
  if (action !== null && action !== undefined && action !== '') {
    printWarning(`Action required: ${action}`);
  }
}
