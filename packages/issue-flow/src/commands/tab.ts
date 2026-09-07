import type { Readable, Writable } from 'node:stream';
import {
  type ResolvedAgentSessionContext,
  resolveAgentSessionDeps,
} from '../agents/session/context.js';
import { listAgentSessions } from '../agents/session/open.js';
import {
  type AgentSessionTab,
  createAgentTab,
  deleteAgentTab,
  projectAgentSessionTabs,
  selectAgentTab,
} from '../agents/session/tabs.js';
import { printError, printInfo } from '../ui/logger.js';
import { isInteractive, promptConfirm } from '../ui/prompts.js';

export interface TabCommandOptions {
  project?: string;
  json?: boolean;
  yes?: boolean;
}

export interface TabCommandDeps {
  resolveContext?: (options: { projectRoot?: string }) => Promise<ResolvedAgentSessionContext>;
  create?: typeof createAgentTab;
  select?: typeof selectAgentTab;
  close?: typeof deleteAgentTab;
  list?: typeof listTabs;
  log?: (message: string) => void;
  raw?: (message: string) => void;
  error?: (message: string) => void;
  interactive?: boolean;
  stdin?: Readable;
  stdout?: Writable;
  confirm?: (message: string) => Promise<boolean>;
}

function resolved(deps: TabCommandDeps) {
  return {
    resolveContext:
      deps.resolveContext ??
      ((options: { projectRoot?: string }) => resolveAgentSessionDeps(options)),
    create: deps.create ?? createAgentTab,
    select: deps.select ?? selectAgentTab,
    close: deps.close ?? deleteAgentTab,
    list: deps.list ?? listTabs,
    log: deps.log ?? printInfo,
    raw: deps.raw ?? ((message: string) => process.stdout.write(`${message}\n`)),
    error: deps.error ?? printError,
    interactive: deps.interactive,
    stdin: deps.stdin,
    stdout: deps.stdout,
    confirm: deps.confirm,
  };
}

async function contextFor(project: string | undefined, deps: ReturnType<typeof resolved>) {
  return deps.resolveContext(project === undefined ? {} : { projectRoot: project });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function listTabs(
  context: ResolvedAgentSessionContext,
  branch: string,
): Promise<{ tabs: AgentSessionTab[]; activeTabId: string | null }> {
  const [sessions, worktrees] = await Promise.all([
    listAgentSessions(context.storage),
    context.worktrees.list(),
  ]);
  const binding = worktrees.find((candidate) => candidate.branch === branch)?.binding ?? null;
  if (binding === null) throw new Error(`Worktree not found: ${branch}`);
  const projection = projectAgentSessionTabs(
    sessions.filter(
      (session) => session.branch === branch && session.worktreeId === binding.worktreeId,
    ),
    binding,
  );
  if (projection.rootSession === null)
    throw new Error(`Worktree ${branch} has no root AgentSession.`);
  return { tabs: projection.tabs, activeTabId: projection.activeTabId };
}

export async function runTabList(
  branch: string,
  options: TabCommandOptions = {},
  deps: TabCommandDeps = {},
): Promise<number> {
  const use = resolved(deps);
  try {
    const context = await contextFor(options.project, use);
    const projection = await use.list(context, branch);
    if (options.json === true) {
      use.raw(JSON.stringify({ schemaVersion: 1, branch, ...projection }, null, 2));
    } else {
      for (const tab of projection.tabs) {
        use.log(`${tab.tabId === projection.activeTabId ? '*' : ' '} ${tab.label}  ${tab.tabId}`);
      }
    }
    return 0;
  } catch (error) {
    use.error(message(error));
    return 1;
  }
}

export async function runTabCreate(
  branch: string,
  options: TabCommandOptions = {},
  deps: TabCommandDeps = {},
): Promise<number> {
  const use = resolved(deps);
  try {
    const context = await contextFor(options.project, use);
    const tab = await use.create(context, branch);
    if (options.json === true) use.raw(JSON.stringify({ schemaVersion: 1, branch, tab }, null, 2));
    else use.log(`Created and selected ${tab.label} (${tab.tabId}).`);
    return 0;
  } catch (error) {
    use.error(message(error));
    return 1;
  }
}

export async function runTabSwitch(
  branch: string,
  tabId: string,
  options: TabCommandOptions = {},
  deps: TabCommandDeps = {},
): Promise<number> {
  const use = resolved(deps);
  try {
    const context = await contextFor(options.project, use);
    await use.select(context, branch, tabId);
    if (options.json === true) use.raw(JSON.stringify({ ok: true, branch, tabId }));
    else use.log(`Selected tab ${tabId} on ${branch}.`);
    return 0;
  } catch (error) {
    use.error(message(error));
    return 1;
  }
}

async function authorizeClose(
  branch: string,
  tabId: string,
  options: TabCommandOptions,
  deps: ReturnType<typeof resolved>,
): Promise<boolean> {
  if (options.yes === true) return true;
  const prompt = `Close tab ${tabId} on ${branch} and stop only that fork process?`;
  if (deps.confirm !== undefined) return deps.confirm(prompt);
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  if (!(deps.interactive ?? isInteractive({ stdin, stdout, ci: process.env.CI }))) {
    deps.error('Closing a tab stops its fork process. Re-run with --yes to confirm.');
    return false;
  }
  const answer = await promptConfirm({ message: prompt, initialValue: false, stdin, stdout });
  return answer.status !== 'cancelled' && answer.value === true;
}

export async function runTabClose(
  branch: string,
  tabId: string,
  options: TabCommandOptions = {},
  deps: TabCommandDeps = {},
): Promise<number> {
  const use = resolved(deps);
  if (!(await authorizeClose(branch, tabId, options, use))) return 1;
  try {
    const context = await contextFor(options.project, use);
    await use.close(context, branch, tabId);
    if (options.json === true) use.raw(JSON.stringify({ ok: true, branch, tabId }));
    else use.log(`Closed tab ${tabId} on ${branch}.`);
    return 0;
  } catch (error) {
    use.error(message(error));
    return 1;
  }
}
