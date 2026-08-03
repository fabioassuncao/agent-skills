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

/** Label shown to users for each origin. */
const SOURCE_LABELS: Record<IssueSource, string> = {
  github: 'GitHub',
  local: 'local',
};

interface Candidate {
  issue: Issue | null;
  /** Why the origin produced nothing, used only to explain a total miss. */
  reason: string | null;
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
    return { issue: null, reason: errorMessage(err) };
  }

  let available: boolean;
  try {
    available = await provider.isAvailable();
  } catch (err) {
    return { issue: null, reason: `provider unavailable (${errorMessage(err)})` };
  }
  if (!available) {
    return { issue: null, reason: 'provider unavailable' };
  }

  try {
    const issue = await provider.get(id);
    return { issue, reason: issue === null ? 'not found' : null };
  } catch (err) {
    const reason = errorMessage(err);
    // A real failure (network, auth, corrupted metadata) must be visible even
    // when the other origin answers.
    warn(`Could not read issue '${id}' from ${SOURCE_LABELS[source]}: ${reason}`);
    return { issue: null, reason };
  }
}

function shortHash(hash: string): string {
  const hex = hash.startsWith('sha256:') ? hash.slice('sha256:'.length) : hash;
  return hex.slice(0, 12);
}

/** One line per origin describing what differs, without dumping both bodies. */
function describeCandidate(source: IssueSource, issue: Issue): string {
  const lines = issue.body.length === 0 ? 0 : issue.body.split('\n').length;
  return (
    `  ${SOURCE_LABELS[source].padEnd(6)} title: "${issue.title}" | body: ${lines} line(s), ` +
    `${issue.body.length} char(s) | updated: ${issue.updatedAt} | hash: ${shortHash(issue.contentHash)}`
  );
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

/** Interactive choice between the two divergent versions. */
async function promptChoice(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  warn: (message: string) => void,
): Promise<IssueSource | 'cancel'> {
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = createLineReader(rl, stdout);
  try {
    for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt++) {
      const answer = await ask('Which version should be used? [1] Local  [2] GitHub  [3] Cancel: ');
      if (answer === null) {
        return 'cancel';
      }
      const choice = answer.trim();
      if (choice === '1') {
        return 'local';
      }
      if (choice === '2') {
        return 'github';
      }
      if (choice === '3') {
        return 'cancel';
      }
      warn(`Invalid choice: '${choice}'. Enter 1, 2 or 3.`);
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

/**
 * Single entry point every command uses to decide which Issue the pipeline
 * works on.
 *
 * Scenarios:
 * - only one origin has it -> that one, no questions asked;
 * - both, same contentHash -> equivalence is reported and the preferred origin
 *   wins, without a prompt;
 * - both, different content -> the divergence is reported and `conflictPolicy`
 *   decides (`ask` prompts on a TTY, falls back to `preferredProvider` with a
 *   warning anywhere else);
 * - neither -> IssueResolutionError, which carries the CLI exit code.
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

  const candidates = new Map<IssueSource, Candidate>();
  for (const source of sources) {
    candidates.set(source, await fetchCandidate(source, id, warn));
  }

  const local = candidates.get('local')?.issue ?? null;
  const github = candidates.get('github')?.issue ?? null;

  if (local === null && github === null) {
    const details = [...candidates.entries()]
      .map(([source, candidate]) => `${SOURCE_LABELS[source]}: ${candidate.reason ?? 'not found'}`)
      .join('; ');
    const where = details.length > 0 ? ` (${details})` : '';
    throw new IssueResolutionError(`Issue '${id}' not found in any registered origin${where}`);
  }

  if (local !== null && github === null) {
    return buildResolved(local, 'local', local, github, false);
  }
  if (github !== null && local === null) {
    return buildResolved(github, 'github', local, github, false);
  }

  // Both origins have it — from here on neither is null.
  const localIssue = local as Issue;
  const githubIssue = github as Issue;
  const preferred = config.preferredProvider;
  const pick = (source: IssueSource, divergent: boolean): ResolvedIssue =>
    buildResolved(
      source === 'local' ? localIssue : githubIssue,
      source,
      localIssue,
      githubIssue,
      divergent,
    );

  if (localIssue.contentHash === githubIssue.contentHash) {
    info(
      `Issue '${id}' has identical content in local and GitHub; using ${SOURCE_LABELS[preferred]}.`,
    );
    return pick(preferred, false);
  }

  info(`Issue '${id}' differs between origins:`);
  info(describeCandidate('local', localIssue));
  info(describeCandidate('github', githubIssue));

  if (config.conflictPolicy === 'prefer-local') {
    info(`Conflict policy 'prefer-local': using the local version.`);
    return pick('local', true);
  }
  if (config.conflictPolicy === 'prefer-github') {
    info(`Conflict policy 'prefer-github': using the GitHub version.`);
    return pick('github', true);
  }

  const interactive = opts.interactive ?? isInteractiveByDefault();
  if (!interactive) {
    warn(
      `Divergent Issue '${id}' and conflict policy 'ask' in a non-interactive environment; ` +
        `using the preferred provider (${SOURCE_LABELS[preferred]}).`,
    );
    return pick(preferred, true);
  }

  const choice = await promptChoice(
    opts.stdin ?? process.stdin,
    opts.stdout ?? process.stdout,
    warn,
  );
  if (choice === 'cancel') {
    throw new IssueResolutionError(`Cancelled: Issue '${id}' diverges between local and GitHub.`);
  }
  return pick(choice, true);
}
