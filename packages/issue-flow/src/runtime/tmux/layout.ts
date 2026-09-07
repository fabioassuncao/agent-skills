import { resolve } from 'node:path';
import type { PaneSplit, TmuxGateway } from './gateway.js';
import { buildPaneTarget, buildProjectSessionName, buildWorktreeWindowName } from './names.js';

/**
 * Laying a worktree's window out, and — the part that is not the upstream's —
 * deciding whether to lay it out at all.
 *
 * Ported from WebMux `backend/src/services/session-service.ts` @ d8c9d5f.
 * `planSessionLayout` is a pure function and is ported as one, so the
 * characterization test compares a plan rather than a tmux server.
 *
 * `ensureSessionLayout` carries the one improvement §27 of the absorption plan
 * asks for. The upstream kills the existing window unconditionally and rebuilds
 * it, which means reopening a worktree kills the agent that was working in it —
 * its conversation survives through `--resume`, but the running process does
 * not. Distinguishing the three cases is what turns "persistent session" from a
 * promise into a fact:
 *
 * ```text
 * reattach → the window exists and its panes are alive → do not touch it
 * resume   → the window is gone, the conversation is not → rebuild + --resume
 * fresh    → nothing exists                             → build from scratch
 * ```
 */

export type PaneKind = 'agent' | 'shell' | 'command';

export interface PaneTemplate {
  id: string;
  kind: PaneKind;
  /** `repo` runs in the repository; anything else in the worktree. */
  cwd?: 'repo' | 'worktree';
  /** Required for `kind: 'command'`. */
  command?: string;
  /** Directory, relative to the pane's cwd, the command runs in. */
  workingDir?: string;
  split?: PaneSplit;
  sizePct?: number;
  focus?: boolean;
}

export interface PaneCommandSet {
  /** Command that starts the agent in its pane. */
  agent: string;
  /** Shell every pane opens with. */
  shell: string;
}

export interface SessionLayoutContext {
  repoRoot: string;
  worktreePath: string;
  paneCommands: PaneCommandSet;
}

export interface PlannedPane {
  id: string;
  index: number;
  kind: PaneKind;
  cwd: string;
  startupCommand?: string;
  focus: boolean;
  split?: PaneSplit;
  sizePct?: number;
}

export interface SessionLayoutPlan {
  sessionName: string;
  windowName: string;
  shellCommand: string;
  panes: PlannedPane[];
  focusPaneIndex: number;
}

/** Quote a path for a shell command string. Only for `cd`, never for agent argv (ADR-04). */
function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function resolvePaneCwd(template: PaneTemplate, context: SessionLayoutContext): string {
  return template.cwd === 'repo' ? context.repoRoot : context.worktreePath;
}

function buildCommandPaneStartupCommand(
  template: PaneTemplate,
  context: SessionLayoutContext,
): string {
  if (!template.command) {
    throw new Error(`Pane "${template.id}" is kind=command but has no command`);
  }
  if (!template.workingDir) return template.command;
  const workingDir = resolve(resolvePaneCwd(template, context), template.workingDir);
  return `cd -- ${quoteShell(workingDir)} && ${template.command}`;
}

function resolvePaneStartupCommand(
  template: PaneTemplate,
  context: SessionLayoutContext,
): string | undefined {
  switch (template.kind) {
    case 'agent':
      return context.paneCommands.agent;
    case 'shell':
      // Nothing to type: the pane already opened the shell.
      return undefined;
    case 'command':
      return buildCommandPaneStartupCommand(template, context);
  }
}

export function planSessionLayout(input: {
  projectId: string;
  branch: string;
  templates: PaneTemplate[];
  context: SessionLayoutContext;
}): SessionLayoutPlan {
  if (input.templates.length === 0) {
    throw new Error('At least one pane template is required');
  }

  const panes: PlannedPane[] = input.templates.map((template, index) => {
    const startupCommand = resolvePaneStartupCommand(template, input.context);
    return {
      id: template.id,
      index,
      kind: template.kind,
      cwd: resolvePaneCwd(template, input.context),
      ...(startupCommand ? { startupCommand } : {}),
      focus: template.focus === true,
      // The first pane is the window itself; only the rest are splits.
      ...(index > 0
        ? {
            split: template.split ?? 'right',
            ...(template.sizePct === undefined ? {} : { sizePct: template.sizePct }),
          }
        : {}),
    };
  });

  return {
    sessionName: buildProjectSessionName(input.projectId),
    windowName: buildWorktreeWindowName(input.branch),
    shellCommand: input.context.paneCommands.shell,
    panes,
    focusPaneIndex: panes.find((pane) => pane.focus)?.index ?? 0,
  };
}

export type SessionLayoutMode = 'reattach' | 'resume' | 'fresh';

export interface EnsureSessionLayoutOptions {
  /**
   * Rebuild even when the window is intact.
   *
   * The escape hatch for a profile change, where the layout itself is what
   * changed and reattaching would show the old one.
   */
  force?: boolean;
}

export interface EnsureSessionLayoutResult {
  mode: SessionLayoutMode;
  sessionName: string;
  windowName: string;
  focusTarget: string;
}

/** Whether the branch already has a live window in this project's session. */
export async function isWorktreeOpen(
  tmux: TmuxGateway,
  projectId: string,
  branch: string,
): Promise<boolean> {
  return tmux.hasWindow(buildProjectSessionName(projectId), buildWorktreeWindowName(branch));
}

/**
 * Make the window match the plan, without destroying a session that is working.
 *
 * The reattach decision reads the pane count rather than probing for a process:
 * tmux removes a pane as soon as its command exits (`remain-on-exit` is off by
 * default), so a window that still has every pane the plan expects is a window
 * whose agent is still running. A window that lost panes had something die in
 * it, and rebuilding is then the correct answer rather than a destructive one.
 */
export async function ensureSessionLayout(
  tmux: TmuxGateway,
  plan: SessionLayoutPlan,
  options: EnsureSessionLayoutOptions = {},
): Promise<EnsureSessionLayoutResult> {
  const rootPane = plan.panes[0];
  if (rootPane === undefined) throw new Error('A session layout plan needs at least one pane');

  const focusTarget = buildPaneTarget(plan.sessionName, plan.windowName, plan.focusPaneIndex);
  await tmux.ensureServer();
  await tmux.ensureSession(plan.sessionName, rootPane.cwd);

  const windowExists = await tmux.hasWindow(plan.sessionName, plan.windowName);
  if (windowExists && options.force !== true) {
    const paneCount = await tmux.countPanes(plan.sessionName, plan.windowName);
    if (paneCount >= plan.panes.length) {
      // Everything the plan asks for is already running. Selecting the focus
      // pane is the whole of a reattach — no window is killed, so the agent
      // inside it never notices anyone reconnected.
      await tmux.selectPane(focusTarget);
      return {
        mode: 'reattach',
        sessionName: plan.sessionName,
        windowName: plan.windowName,
        focusTarget,
      };
    }
  }

  if (windowExists) await tmux.killWindow(plan.sessionName, plan.windowName);

  await tmux.createWindow({
    sessionName: plan.sessionName,
    windowName: plan.windowName,
    cwd: rootPane.cwd,
    command: plan.shellCommand,
  });
  // pane-base-index 0 so a pane's index matches its position in the plan; the
  // rename options so a shell prompt cannot retitle the window and break every
  // target built from its name.
  await tmux.setWindowOption(plan.sessionName, plan.windowName, 'pane-base-index', '0');
  await tmux.setWindowOption(plan.sessionName, plan.windowName, 'automatic-rename', 'off');
  await tmux.setWindowOption(plan.sessionName, plan.windowName, 'allow-rename', 'off');

  for (const pane of plan.panes.slice(1)) {
    await tmux.splitWindow({
      // Split from the previous pane, so a `right` split lands beside it rather
      // than beside whichever pane tmux happened to leave active.
      target: buildPaneTarget(plan.sessionName, plan.windowName, pane.index - 1),
      split: pane.split ?? 'right',
      ...(pane.sizePct === undefined ? {} : { sizePct: pane.sizePct }),
      cwd: pane.cwd,
      command: plan.shellCommand,
    });
  }

  for (const pane of plan.panes) {
    if (pane.startupCommand === undefined) continue;
    await tmux.runCommand(
      buildPaneTarget(plan.sessionName, plan.windowName, pane.index),
      pane.startupCommand,
    );
  }

  await tmux.selectPane(focusTarget);
  return {
    mode: windowExists ? 'resume' : 'fresh',
    sessionName: plan.sessionName,
    windowName: plan.windowName,
    focusTarget,
  };
}
