import { spawnSync } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import { findRegisteredAgent } from '../agents/custom-registry.js';
import {
  type ResolvedAgentSessionContext,
  resolveAgentSessionDeps,
} from '../agents/session/context.js';
import {
  AgentSessionError,
  listAgentSessions,
  openAgentSession,
  sendToAgentSession,
  stopAgentSession,
} from '../agents/session/open.js';
import { linkSessionToRun, loadSession } from '../agents/session/store.js';
import { type AgentSession, describeSession, isFreeSession } from '../agents/session/types.js';
import type { AgentPermission } from '../agents/types.js';
import { loadCustomAgentsConfig } from '../config/custom-agents.js';
import { TMUX_SOCKET_NAME } from '../runtime/tmux/gateway.js';
import { buildProjectSessionName, buildWorktreeWindowName } from '../runtime/tmux/names.js';
import { findLatestRunIdForIssue } from '../storage/db/repository.js';
import { printError, printInfo, printWarning } from '../ui/logger.js';

/**
 * `issue-flow session new | ls | attach | send | stop | link`.
 *
 * The CLI half of §49: an agent, on a branch, in a worktree, with **no issue,
 * no plan and no workflow behind it**. It is the command that makes ADR-16 a
 * feature rather than a nullable column — everything else in this project
 * starts from an Issue, and this is the one entry point that does not.
 *
 * ADAPT of `bin/src/worktree-commands.ts` @ d8c9d5f (`add` / `open` / `send` /
 * `close`), with the same adaptation `project` needed and for the same reason
 * (§47.5): **the upstream CLI is an HTTP client and this one is not.** `webmux
 * worktree add` prints a connection error with no server running; here the
 * database is the authority and the server is a consumer of it, so every
 * subcommand except `attach` works on a laptop with nothing listening.
 *
 * `link` has no upstream counterpart. It is the promotion §49.2 describes: the
 * session that was opened to poke at something turns out to be the work on
 * issue 42, and pointing its `run_id` at that run is the whole of it. It never
 * creates the run — see `linkSessionToRun`.
 */

export interface SessionCommandOptions {
  json?: boolean;
}

/** Seams. Production passes none of these. */
export interface SessionCommandDeps {
  /** Assemble the launch wiring. Injected so tests never touch git or tmux. */
  resolveContext?: (options: {
    projectRoot?: string;
    profile?: string;
  }) => Promise<ResolvedAgentSessionContext>;
  /** Attach the caller's terminal to a tmux window. */
  attach?: (input: { sessionName: string; windowName: string }) => number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

interface ResolvedDeps {
  resolveContext: (options: {
    projectRoot?: string;
    profile?: string;
  }) => Promise<ResolvedAgentSessionContext>;
  attach: (input: { sessionName: string; windowName: string }) => number;
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/**
 * Hand the caller's terminal to tmux.
 *
 * `stdio: 'inherit'` and a synchronous spawn, because attaching *is* giving the
 * terminal away: anything asynchronous would leave two readers on the same tty.
 * The socket is the project's own (`-L issue-flow`, ADR-09), never the user's
 * default server.
 */
function attachToTmux(input: { sessionName: string; windowName: string }): number {
  const result = spawnSync(
    'tmux',
    ['-L', TMUX_SOCKET_NAME, 'attach-session', '-t', `${input.sessionName}:${input.windowName}`],
    { stdio: 'inherit' },
  );
  return result.status ?? 1;
}

function resolveDeps(deps: SessionCommandDeps): ResolvedDeps {
  return {
    resolveContext: deps.resolveContext ?? ((options) => resolveAgentSessionDeps(options)),
    attach: deps.attach ?? attachToTmux,
    log: deps.log ?? printInfo,
    warn: deps.warn ?? printWarning,
    error: deps.error ?? printError,
  };
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ── new ─────────────────────────────────────────────────────────────────── */

export interface SessionNewOptions extends SessionCommandOptions {
  agent?: string;
  branch?: string;
  profile?: string;
  prompt?: string;
  label?: string;
  permission?: string;
  model?: string;
  project?: string;
}

const PERMISSIONS: readonly AgentPermission[] = ['read-only', 'workspace', 'autonomous'];

function parsePermission(raw: string | undefined): AgentPermission | null {
  if (raw === undefined) return 'workspace';
  return PERMISSIONS.includes(raw as AgentPermission) ? (raw as AgentPermission) : null;
}

/**
 * `issue-flow session new`.
 *
 * The default permission is `workspace`, not `autonomous`: a session opened by
 * a person is a person's session, and the three semantic levels (§45.2-L) are
 * exactly what this project has instead of the upstream's `yolo` boolean.
 */
export async function runSessionNew(
  options: SessionNewOptions = {},
  deps: SessionCommandDeps = {},
): Promise<number> {
  const resolved = resolveDeps(deps);

  const provider = options.agent ?? 'claude';
  const permission = parsePermission(options.permission);
  if (permission === null) {
    resolved.error(
      `Unknown permission '${options.permission}'. Use one of: ${PERMISSIONS.join(', ')}.`,
    );
    return 1;
  }

  let context: ResolvedAgentSessionContext;
  try {
    context = await resolved.resolveContext({
      ...(options.project === undefined ? {} : { projectRoot: options.project }),
      ...(options.profile === undefined ? {} : { profile: options.profile }),
    });
  } catch (error) {
    resolved.error(failureMessage(error));
    return 1;
  }

  const registered = findRegisteredAgent(
    await loadCustomAgentsConfig({ projectRoot: context.projectRoot }),
    provider,
  );
  if (registered === null) {
    resolved.error(`Unknown agent '${provider}'.`);
    return 1;
  }

  try {
    const opened = await openAgentSession(context.deps, {
      provider,
      ...(registered.kind === 'custom' ? { customAgent: registered } : {}),
      permission,
      ...(options.branch === undefined ? {} : { branch: options.branch }),
      ...(options.label === undefined ? {} : { label: options.label }),
      ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
      ...(options.model === undefined ? {} : { model: options.model }),
    });

    if (options.json === true) {
      resolved.log(
        JSON.stringify(
          {
            schemaVersion: 1,
            session: opened.session,
            branch: opened.branch,
            worktreePath: opened.worktreePath,
            paneTarget: opened.paneTarget,
            layout: opened.layout,
            launchMode: opened.launchMode,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    resolved.log(`Session ${opened.session.id} — ${provider} on ${opened.branch}`);
    resolved.log(`  worktree  ${opened.worktreePath}`);
    resolved.log(`  pane      ${opened.paneTarget} (${opened.layout.mode})`);
    resolved.log(`  attach    issue-flow session attach ${opened.session.id}`);
    return 0;
  } catch (error) {
    resolved.error(failureMessage(error));
    return error instanceof AgentSessionError && error.status === 412 ? 2 : 1;
  }
}

/* ── ls ──────────────────────────────────────────────────────────────────── */

export interface SessionLsOptions extends SessionCommandOptions {
  /** Include workflow sessions. By default only free ones are listed. */
  all?: boolean;
  project?: string;
}

const COLUMN_WIDTHS = [38, 10, 10, 28];

function pad(cells: string[]): string {
  return cells
    .map((cell, index) =>
      index === cells.length - 1 ? cell : cell.padEnd(COLUMN_WIDTHS[index] ?? 12),
    )
    .join(' ');
}

/** `MODE` says which of the two a row is, because nothing else on it would. */
export function formatSessionTable(sessions: readonly AgentSession[]): string[] {
  if (sessions.length === 0) {
    return ['No session. Open one with: issue-flow session new'];
  }
  const header = pad(['ID', 'AGENT', 'STATUS', 'MODE', 'BRANCH / LABEL']);
  const rows = sessions.map((session) =>
    pad([
      session.id,
      session.provider,
      session.status,
      isFreeSession(session) ? 'free' : `run ${session.runId ?? '?'}`,
      describeSession(session),
    ]),
  );
  return [header, ...rows];
}

/** `issue-flow session ls`. Reads SQLite directly — no server required. */
export async function runSessionLs(
  options: SessionLsOptions = {},
  deps: SessionCommandDeps = {},
): Promise<number> {
  const resolved = resolveDeps(deps);

  let context: ResolvedAgentSessionContext;
  try {
    context = await resolved.resolveContext(
      options.project === undefined ? {} : { projectRoot: options.project },
    );
  } catch (error) {
    resolved.error(failureMessage(error));
    return 1;
  }

  const sessions = (await listAgentSessions(context.storage)).filter(
    (session) => options.all === true || isFreeSession(session),
  );

  if (options.json === true) {
    resolved.log(
      JSON.stringify({ schemaVersion: 1, projectId: context.projectId, sessions }, null, 2),
    );
    return 0;
  }

  for (const line of formatSessionTable(sessions)) resolved.log(line);
  return 0;
}

/* ── attach / send / stop / link ─────────────────────────────────────────── */

async function findSession(
  id: string,
  resolved: ResolvedDeps,
  projectRoot?: string,
): Promise<{ context: ResolvedAgentSessionContext; session: AgentSession } | null> {
  const context = await resolved.resolveContext(projectRoot === undefined ? {} : { projectRoot });
  const session = await loadSession(context.storage, id);
  return session === null ? null : { context, session };
}

export interface SessionTargetOptions extends SessionCommandOptions {
  project?: string;
}

/** `issue-flow session attach <id>`. Hands the terminal to tmux. */
export async function runSessionAttach(
  id: string,
  options: SessionTargetOptions = {},
  deps: SessionCommandDeps = {},
): Promise<number> {
  const resolved = resolveDeps(deps);
  let found: Awaited<ReturnType<typeof findSession>>;
  try {
    found = await findSession(id, resolved, options.project);
  } catch (error) {
    resolved.error(failureMessage(error));
    return 1;
  }
  if (found === null) {
    resolved.error(`No session with id '${id}' in this project.`);
    return 1;
  }

  return resolved.attach({
    sessionName: buildProjectSessionName(found.context.projectId),
    windowName: buildWorktreeWindowName(found.session.branch),
  });
}

/** `issue-flow session send <id> <text>`. A subsequent turn, pasted as one block. */
export async function runSessionSend(
  id: string,
  text: string,
  options: SessionTargetOptions = {},
  deps: SessionCommandDeps = {},
): Promise<number> {
  const resolved = resolveDeps(deps);
  let found: Awaited<ReturnType<typeof findSession>>;
  try {
    found = await findSession(id, resolved, options.project);
  } catch (error) {
    resolved.error(failureMessage(error));
    return 1;
  }
  if (found === null) {
    resolved.error(`No session with id '${id}' in this project.`);
    return 1;
  }

  try {
    await sendToAgentSession(found.context.deps, found.session, text);
  } catch (error) {
    resolved.error(failureMessage(error));
    return 1;
  }
  resolved.log(`Sent ${text.length} characters to session ${id}.`);
  return 0;
}

export interface SessionStopOptions extends SessionTargetOptions {
  /** Also remove the worktree and its branch. Off by default: work survives. */
  removeWorktree?: boolean;
}

/** `issue-flow session stop <id>`. */
export async function runSessionStop(
  id: string,
  options: SessionStopOptions = {},
  deps: SessionCommandDeps = {},
): Promise<number> {
  const resolved = resolveDeps(deps);
  let found: Awaited<ReturnType<typeof findSession>>;
  try {
    found = await findSession(id, resolved, options.project);
  } catch (error) {
    resolved.error(failureMessage(error));
    return 1;
  }
  if (found === null) {
    resolved.error(`No session with id '${id}' in this project.`);
    return 1;
  }

  try {
    await stopAgentSession(found.context.deps, found.session, {
      ...(options.removeWorktree === undefined ? {} : { removeWorktree: options.removeWorktree }),
    });
  } catch (error) {
    resolved.error(failureMessage(error));
    return 1;
  }

  resolved.log(
    options.removeWorktree === true
      ? `Stopped session ${id} and removed its worktree.`
      : `Stopped session ${id}. Its worktree and branch are untouched.`,
  );
  return 0;
}

export interface SessionLinkOptions extends SessionTargetOptions {
  issue?: string;
  /** Point at a specific run instead of the issue's most recent one. */
  run?: string;
}

/**
 * `issue-flow session link <id> --issue 42`.
 *
 * The promotion of §49.2: a session that started with nothing behind it becomes
 * the session of a run. Everything that carries its history stays — the same
 * row, the same conversation, the same branch and the same pane — so the agent
 * does not lose a word of what it already knows.
 *
 * It refuses when the issue has no run rather than creating one. A free session
 * that could conjure an execution into being would be a free session starting
 * the pipeline, which §49.2 forbids in as many words, and the error names the
 * command that does start one.
 */
export async function runSessionLink(
  id: string,
  options: SessionLinkOptions = {},
  deps: SessionCommandDeps = {},
): Promise<number> {
  const resolved = resolveDeps(deps);
  const issue = options.issue?.trim();
  if ((issue === undefined || issue === '') && options.run === undefined) {
    resolved.error('Pass --issue <number> (or --run <id>) to say what to link the session to.');
    return 1;
  }

  let found: Awaited<ReturnType<typeof findSession>>;
  try {
    found = await findSession(id, resolved, options.project);
  } catch (error) {
    resolved.error(failureMessage(error));
    return 1;
  }
  if (found === null) {
    resolved.error(`No session with id '${id}' in this project.`);
    return 1;
  }

  if (!isFreeSession(found.session)) {
    resolved.error(
      `Session ${id} already belongs to run ${found.session.runId ?? '?'}; linking it again would rewrite that binding.`,
    );
    return 1;
  }

  let runId = options.run ?? null;
  if (runId === null && issue !== undefined) {
    runId = await findLatestRunIdForIssue({ ...found.context.storage, issueId: issue });
  }
  if (runId === null) {
    resolved.error(
      `Issue ${issue} has no run to link to yet. Start one with \`issue-flow run ${issue}\`, then link the session.`,
    );
    return 1;
  }

  const linked = await linkSessionToRun(found.context.storage, found.session, runId);
  resolved.log(`Linked session ${linked.id} to run ${runId}. Its conversation is unchanged.`);
  return 0;
}

/** Exported for the CLI layer, which resolves `--project` against a path. */
export function resolveProjectOption(raw: string | undefined): string | undefined {
  return raw === undefined ? undefined : resolvePath(process.cwd(), raw);
}
