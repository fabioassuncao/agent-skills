import type { Readable, Writable } from 'node:stream';
import { loadIssuesConfig } from '../config.js';
import { actionOf, type ClassifiedFailure, failureOf } from '../resilience/errors.js';
import { printInfo, printWarning } from '../ui/logger.js';
import { isInteractive, promptSelect } from '../ui/prompts.js';
import { ensureProvidersRegistered } from './bootstrap.js';
import type { ProviderAvailability } from './provider.js';
import { getProvider, getRegisteredSources } from './registry.js';
import type { Issue, IssueSource, IssuesConfig, ResolvedIssue } from './types.js';

/**
 * Failure to settle on an Issue. Carries the exit code the CLI should return,
 * so callers propagate it instead of inventing their own.
 */
export class IssueResolutionError extends Error {
  readonly exitCode: number;
  /**
   * The verdict of the origin that failed, when one origin failed for a reason
   * worth naming. It is what tells "this Issue does not exist" apart from
   * "GitHub could not be reached", which are the same message today.
   */
  readonly failure: ClassifiedFailure | undefined;
  /** What a human has to do, for a failure that waiting cannot fix. */
  readonly action: string | undefined;

  constructor(
    message: string,
    exitCode = 1,
    details: { failure?: ClassifiedFailure; action?: string } = {},
  ) {
    super(message);
    this.name = 'IssueResolutionError';
    this.exitCode = exitCode;
    this.failure = details.failure;
    this.action = details.action;
  }
}

export interface ResolveIssueOptions {
  /** Already-resolved provider configuration. Defaults to loadIssuesConfig(). */
  config?: IssuesConfig;
  /** Origins to query. Defaults to every registered source. */
  sources?: IssueSource[];
  /**
   * Whether a prompt may be shown. Defaults to a real TTY outside CI, which is
   * what keeps `ask` from ever blocking a headless run.
   */
  interactive?: boolean;
  /** Input stream for the conflict prompt. Defaults to process.stdin. */
  stdin?: Readable;
  /** Output stream for the conflict prompt. Defaults to process.stdout. */
  stdout?: Writable;
  /** Abort the conflict prompt without choosing an origin. */
  signal?: AbortSignal;
  /** Informational sink. Defaults to printInfo. */
  info?: (message: string) => void;
  /** Warning sink. Defaults to printWarning. */
  warn?: (message: string) => void;
}

/**
 * Labels shown to users for the built-in origins. An origin registered from
 * outside this package is displayed under its own name, so a new provider needs
 * no entry here.
 */
const SOURCE_LABELS: Record<string, string> = {
  github: 'GitHub',
  local: 'local',
};

function sourceLabel(source: IssueSource): string {
  return SOURCE_LABELS[source] ?? source;
}

/** Same label, capitalized for the numbered prompt ('local' -> 'Local'). */
function promptLabel(source: IssueSource): string {
  const label = sourceLabel(source);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

interface Candidate {
  source: IssueSource;
  issue: Issue | null;
  /** Why the origin produced nothing, used only to explain a total miss. */
  reason: string | null;
  /** The classified verdict behind `reason`, when the origin could give one. */
  failure?: ClassifiedFailure;
  /** What a human has to do about it (`gh auth login`), when that applies. */
  action?: string;
}

/** A candidate that actually produced an Issue. */
interface FoundCandidate extends Candidate {
  issue: Issue;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Narrow the origins to the ones that claim the identifier, when any does.
 *
 * An origin may own a namespace no other one could produce — `inline-<hash>`
 * is minted by Issue Flow itself. Asking every other origin about such an
 * identifier costs a network round-trip and a warning about a failure that was
 * never a failure. When nobody claims it, nothing changes: every origin is
 * queried and the divergence machinery settles what they answer.
 *
 * A provider whose `claims` throws is treated as not claiming: the predicate is
 * an optimization, and it must never be the reason an Issue cannot be found.
 */
function narrowToClaimants(sources: IssueSource[], id: string): IssueSource[] {
  const claimants = sources.filter((source) => {
    try {
      return getProvider(source).claims?.(id) === true;
    } catch {
      return false;
    }
  });
  return claimants.length > 0 ? claimants : sources;
}

/**
 * Read one origin without letting it break the others.
 *
 * An unavailable provider or a failed read degrades to "no candidate" plus a
 * reason: as long as another origin has the Issue the pipeline keeps going, and
 * when nothing is found the reasons are surfaced in the final error so a broken
 * environment is never reported as a missing Issue.
 */
async function fetchCandidate(
  source: IssueSource,
  id: string,
  warn: (message: string) => void,
): Promise<Candidate> {
  let provider: ReturnType<typeof getProvider>;
  try {
    provider = getProvider(source);
  } catch (err) {
    return { source, issue: null, reason: errorMessage(err) };
  }

  let availability: ProviderAvailability;
  try {
    availability = (await provider.checkAvailability?.()) ?? {
      available: await provider.isAvailable(),
    };
  } catch (err) {
    return { source, issue: null, reason: `provider unavailable (${errorMessage(err)})` };
  }
  if (!availability.available) {
    // The classified reason replaces the flat "provider unavailable": a
    // credential that expired and a network that blipped were indistinguishable
    // before, and only one of them is worth telling a human about.
    const reason = availability.failure?.message ?? 'provider unavailable';
    return {
      source,
      issue: null,
      reason,
      ...(availability.failure === undefined ? {} : { failure: availability.failure }),
      ...(availability.action === undefined ? {} : { action: availability.action }),
    };
  }

  try {
    const issue = await provider.get(id);
    return { source, issue, reason: issue === null ? 'not found' : null };
  } catch (err) {
    const reason = errorMessage(err);
    // A real failure (network, auth, corrupted metadata) must be visible even
    // when the other origin answers.
    warn(`Could not read issue '${id}' from ${sourceLabel(source)}: ${reason}`);
    const failure = failureOf(err);
    const action = actionOf(err);
    return {
      source,
      issue: null,
      reason,
      ...(failure === null ? {} : { failure }),
      ...(action === null ? {} : { action }),
    };
  }
}

function shortHash(hash: string): string {
  const hex = hash.startsWith('sha256:') ? hash.slice('sha256:'.length) : hash;
  return hex.slice(0, 12);
}

/** One line per origin describing what differs, without dumping every body. */
function describeCandidate(source: IssueSource, issue: Issue): string {
  const lines = issue.body.length === 0 ? 0 : issue.body.split('\n').length;
  return (
    `  ${sourceLabel(source).padEnd(6)} title: "${issue.title}" | body: ${lines} line(s), ` +
    `${issue.body.length} char(s) | updated: ${issue.updatedAt} | hash: ${shortHash(issue.contentHash)}`
  );
}

/** 'local and GitHub', 'local, GitHub and memory' — origins in query order. */
function listSources(candidates: FoundCandidate[]): string {
  const labels = candidates.map((candidate) => sourceLabel(candidate.source));
  if (labels.length <= 1) {
    return labels.join('');
  }
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** Outside the open string domain accepted by IssueSource, so no provider can collide with it. */
const CANCEL_CHOICE = Symbol('issue-flow:cancel');

/**
 * Interactive choice between the divergent versions.
 *
 * The options come from the origins that actually answered, so a third provider
 * simply shows up without this function knowing which origins exist. Cancel is
 * always the last option.
 */
async function promptChoice(
  sources: IssueSource[],
  preferred: IssueSource,
  stdin: Readable,
  stdout: Writable,
  signal?: AbortSignal,
): Promise<IssueSource | typeof CANCEL_CHOICE> {
  const result = await promptSelect<IssueSource | typeof CANCEL_CHOICE>({
    message: 'Which version should be used?',
    options: [
      ...sources.map((source) => ({ value: source, label: promptLabel(source) })),
      { value: CANCEL_CHOICE, label: 'Cancel' },
    ],
    initialValue: preferred,
    stdin,
    stdout,
    signal,
  });
  return result.status === 'cancelled' ? CANCEL_CHOICE : result.value;
}

function buildResolved(
  issue: Issue,
  source: IssueSource,
  local: Issue | null,
  github: Issue | null,
  divergent: boolean,
): ResolvedIssue {
  return { issue, source, local, github, divergent };
}

/** Origin `conflictPolicy` points at, or `null` for 'ask'. */
function policyTarget(policy: IssuesConfig['conflictPolicy']): IssueSource | null {
  if (policy === 'prefer-local') {
    return 'local';
  }
  if (policy === 'prefer-github') {
    return 'github';
  }
  return null;
}

/**
 * Single entry point every command uses to decide which Issue the pipeline
 * works on.
 *
 * The logic is written against the origins that answered, never against a fixed
 * list of sources: registering a new provider is enough for it to take part in
 * the resolution, be reported in a divergence and appear in the prompt.
 *
 * Scenarios:
 * - only one origin has it -> that one, no questions asked;
 * - several, same contentHash -> equivalence is reported and the preferred
 *   origin wins, without a prompt;
 * - several, different content -> the divergence is reported and
 *   `conflictPolicy` decides (`ask` prompts on a TTY, falls back to
 *   `preferredProvider` with a warning anywhere else);
 * - none -> IssueResolutionError, which carries the CLI exit code.
 */
export async function resolveIssue(
  id: string,
  opts: ResolveIssueOptions = {},
): Promise<ResolvedIssue> {
  const info = opts.info ?? printInfo;
  const warn = opts.warn ?? printWarning;
  const config = opts.config ?? (await loadIssuesConfig({ warn }));

  ensureProvidersRegistered();
  const sources = narrowToClaimants(opts.sources ?? getRegisteredSources(), id);

  // Each origin is an independent I/O call (network for GitHub, disk for
  // local); querying them concurrently instead of one-by-one keeps the total
  // latency at the slowest origin instead of the sum of all of them, without
  // changing which candidate wins (order is preserved by Promise.all).
  const candidates: Candidate[] = await Promise.all(
    sources.map((source) => fetchCandidate(source, id, warn)),
  );

  const issueOf = (source: IssueSource): Issue | null =>
    candidates.find((candidate) => candidate.source === source)?.issue ?? null;
  const local = issueOf('local');
  const github = issueOf('github');

  const found = candidates.filter(
    (candidate): candidate is FoundCandidate => candidate.issue !== null,
  );

  if (found.length === 0) {
    const details = candidates
      .map((candidate) => `${sourceLabel(candidate.source)}: ${candidate.reason ?? 'not found'}`)
      .join('; ');
    const where = details.length > 0 ? ` (${details})` : '';

    // An origin that needs a human is the answer, not a footnote: reporting
    // "Issue not found" for an expired credential sends the user looking for
    // the wrong problem, and no amount of retrying would have helped.
    const blocking = candidates.find((candidate) => candidate.action !== undefined);
    if (blocking !== undefined) {
      throw new IssueResolutionError(
        `Cannot read issue '${id}' from ${sourceLabel(blocking.source)}: ${blocking.reason}`,
        1,
        {
          ...(blocking.failure === undefined ? {} : { failure: blocking.failure }),
          ...(blocking.action === undefined ? {} : { action: blocking.action }),
        },
      );
    }

    throw new IssueResolutionError(`Issue '${id}' not found in any registered origin${where}`);
  }

  const build = (candidate: FoundCandidate, divergent: boolean): ResolvedIssue =>
    buildResolved(candidate.issue, candidate.source, local, github, divergent);

  const firstFound = found[0] as FoundCandidate;
  if (found.length === 1) {
    return build(firstFound, false);
  }

  // Several origins have it. The preferred one wins whenever it is among them;
  // otherwise the first origin queried does, so an unrelated preference never
  // leaves the pipeline without an Issue.
  const preferred =
    found.find((candidate) => candidate.source === config.preferredProvider) ?? firstFound;

  const distinct = new Set(found.map((candidate) => candidate.issue.contentHash));
  if (distinct.size === 1) {
    info(
      `Issue '${id}' has identical content in ${listSources(found)}; using ${sourceLabel(preferred.source)}.`,
    );
    return build(preferred, false);
  }

  info(`Issue '${id}' differs between origins:`);
  for (const candidate of found) {
    info(describeCandidate(candidate.source, candidate.issue));
  }

  const target = policyTarget(config.conflictPolicy);
  if (target !== null) {
    const chosen = found.find((candidate) => candidate.source === target);
    if (chosen !== undefined) {
      info(`Conflict policy '${config.conflictPolicy}': using the ${sourceLabel(target)} version.`);
      return build(chosen, true);
    }
    // The policy names an origin that has no version of this Issue: say so
    // instead of silently picking for the user under its name.
    warn(
      `Conflict policy '${config.conflictPolicy}' does not apply to Issue '${id}' ` +
        `(${sourceLabel(target)} has no version of it); using ${sourceLabel(preferred.source)}.`,
    );
    return build(preferred, true);
  }

  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const interactive = opts.interactive ?? isInteractive({ stdin, stdout, ci: process.env.CI });
  if (!interactive) {
    warn(
      `Divergent Issue '${id}' and conflict policy 'ask' in a non-interactive environment; ` +
        `using the preferred provider (${sourceLabel(preferred.source)}).`,
    );
    return build(preferred, true);
  }

  const choice = await promptChoice(
    found.map((candidate) => candidate.source),
    preferred.source,
    stdin,
    stdout,
    opts.signal,
  );
  if (choice === CANCEL_CHOICE) {
    throw new IssueResolutionError(
      `Cancelled: Issue '${id}' diverges between ${listSources(found)}.`,
    );
  }
  const picked = found.find((candidate) => candidate.source === choice) as FoundCandidate;
  return build(picked, true);
}
