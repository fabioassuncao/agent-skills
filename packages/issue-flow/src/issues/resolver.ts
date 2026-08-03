import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { loadIssuesConfig } from '../config.js';
import { printInfo, printWarning } from '../ui/logger.js';
import { ensureProvidersRegistered } from './bootstrap.js';
import { getProvider, getRegisteredSources } from './registry.js';
import type { Issue, IssueSource, IssuesConfig, ResolvedIssue } from './types.js';

/**
 * Failure to settle on an Issue. Carries the exit code the CLI should return,
 * so callers propagate it instead of inventing their own.
 */
export class IssueResolutionError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'IssueResolutionError';
    this.exitCode = exitCode;
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
  stdin?: NodeJS.ReadableStream;
  /** Output stream for the conflict prompt. Defaults to process.stdout. */
  stdout?: NodeJS.WritableStream;
  /** Informational sink. Defaults to printInfo. */
  info?: (message: string) => void;
  /** Warning sink. Defaults to printWarning. */
  warn?: (message: string) => void;
}

/** How many invalid answers are tolerated before the prompt gives up. */
const MAX_PROMPT_ATTEMPTS = 3;

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
}

/** A candidate that actually produced an Issue. */
interface FoundCandidate extends Candidate {
  issue: Issue;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

  let available: boolean;
  try {
    available = await provider.isAvailable();
  } catch (err) {
    return { source, issue: null, reason: `provider unavailable (${errorMessage(err)})` };
  }
  if (!available) {
    return { source, issue: null, reason: 'provider unavailable' };
  }

  try {
    const issue = await provider.get(id);
    return { source, issue, reason: issue === null ? 'not found' : null };
  } catch (err) {
    const reason = errorMessage(err);
    // A real failure (network, auth, corrupted metadata) must be visible even
    // when the other origin answers.
    warn(`Could not read issue '${id}' from ${sourceLabel(source)}: ${reason}`);
    return { source, issue: null, reason };
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

/**
 * Turn a readline interface into an awaitable line reader.
 *
 * Lines are queued instead of read on demand: `rl.question` drops whatever
 * arrives between two questions, which silently loses a piped answer typed
 * ahead of the prompt. Resolves `null` once the input is exhausted, so EOF ends
 * the prompt instead of hanging the process.
 */
function createLineReader(
  rl: ReadlineInterface,
  output: NodeJS.WritableStream,
): (query: string) => Promise<string | null> {
  const queued: string[] = [];
  let pending: ((line: string | null) => void) | null = null;
  let closed = false;

  rl.on('line', (line: string) => {
    if (pending !== null) {
      const resolve = pending;
      pending = null;
      resolve(line);
      return;
    }
    queued.push(line);
  });
  rl.on('close', () => {
    closed = true;
    if (pending !== null) {
      const resolve = pending;
      pending = null;
      resolve(null);
    }
  });

  return (query: string) =>
    new Promise<string | null>((resolve) => {
      const buffered = queued.shift();
      if (buffered !== undefined) {
        resolve(buffered);
        return;
      }
      if (closed) {
        resolve(null);
        return;
      }
      output.write(query);
      pending = resolve;
    });
}

/**
 * Interactive choice between the divergent versions.
 *
 * The options are numbered from the origins that actually answered, so a third
 * provider simply shows up as `[3] Memory` without this function knowing which
 * origins exist. Cancel is always the last option.
 */
async function promptChoice(
  sources: IssueSource[],
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  warn: (message: string) => void,
): Promise<IssueSource | 'cancel'> {
  const options = sources.map((source, index) => `[${index + 1}] ${promptLabel(source)}`);
  const cancelOption = sources.length + 1;
  const query = `Which version should be used? ${options.join('  ')}  [${cancelOption}] Cancel: `;
  const numbers = Array.from({ length: cancelOption }, (_, index) => String(index + 1));
  const accepted = `${numbers.slice(0, -1).join(', ')} or ${numbers[numbers.length - 1]}`;

  const rl = createInterface({ input: stdin, output: stdout });
  const ask = createLineReader(rl, stdout);
  try {
    for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt++) {
      const answer = await ask(query);
      if (answer === null) {
        return 'cancel';
      }
      const choice = answer.trim();
      const picked = sources[Number(choice) - 1];
      if (choice.length > 0 && picked !== undefined) {
        return picked;
      }
      if (choice === String(cancelOption)) {
        return 'cancel';
      }
      warn(`Invalid choice: '${choice}'. Enter ${accepted}.`);
    }
    return 'cancel';
  } finally {
    rl.close();
  }
}

function isInteractiveByDefault(): boolean {
  const ci = process.env.CI;
  const inCi = ci !== undefined && ci !== '' && ci !== '0' && ci.toLowerCase() !== 'false';
  return Boolean(process.stdin.isTTY) && !inCi;
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
  const sources = opts.sources ?? getRegisteredSources();

  const candidates: Candidate[] = [];
  for (const source of sources) {
    candidates.push(await fetchCandidate(source, id, warn));
  }

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

  const interactive = opts.interactive ?? isInteractiveByDefault();
  if (!interactive) {
    warn(
      `Divergent Issue '${id}' and conflict policy 'ask' in a non-interactive environment; ` +
        `using the preferred provider (${sourceLabel(preferred.source)}).`,
    );
    return build(preferred, true);
  }

  const choice = await promptChoice(
    found.map((candidate) => candidate.source),
    opts.stdin ?? process.stdin,
    opts.stdout ?? process.stdout,
    warn,
  );
  if (choice === 'cancel') {
    throw new IssueResolutionError(
      `Cancelled: Issue '${id}' diverges between ${listSources(found)}.`,
    );
  }
  const picked = found.find((candidate) => candidate.source === choice) as FoundCandidate;
  return build(picked, true);
}
