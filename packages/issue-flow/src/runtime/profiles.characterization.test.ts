import { describe, expect, it } from 'vitest';
import { buildPaneCommand, buildTtyAgentArgv } from '../agents/tty.js';
import { parseRuntimeProfiles, type RuntimeProfile } from './profiles.js';
import type { TmuxGateway } from './tmux/gateway.js';
import {
  ensureSessionLayout,
  planSessionLayout,
  type SessionLayoutContext,
} from './tmux/layout.js';

/**
 * Characterization test **C8** (§34): *switch profile → window recreated, new
 * layout, `--resume <same id>`*.
 *
 * The upstream behaviour this pins down is `PUT /api/worktrees/:name/profile`
 * (§16): it writes the new profile into the worktree's metadata, destroys the
 * window, rebuilds it with the new layout and relaunches the agent with
 * `launchMode: "resume"` and the conversation id already stored. The
 * conversation survives a layout change — that is the whole claim, and it is
 * what makes profiles switchable rather than a decision taken once at creation.
 *
 * Here the three pieces meet for the first time: the profile provides the pane
 * templates, `planSessionLayout` turns them into a plan, and `ensureSessionLayout`
 * applies it with `force: true`. `force` is not an optimisation — without it the
 * intact window reattaches and the person sees the layout they just replaced.
 * The last case in this file asserts exactly that, so the flag can never be
 * dropped as redundant.
 */

const PROJECT_ID = 'proj-a1b2c3';
const BRANCH = 'feat/63-thing';
const CONVERSATION_ID = 'conv-9f3d1e';
const RUNTIME_ENV = '/repo/.git/issue-flow/runtime.env';

const context: SessionLayoutContext = {
  repoRoot: '/repo',
  worktreePath: '/worktrees/feat/63-thing',
  paneCommands: { agent: '', shell: '/bin/zsh' },
};

/** The two profiles the switch happens between, read through the real parser. */
const profiles = parseRuntimeProfiles(
  {
    default: {
      panes: [
        { id: 'agent', kind: 'agent', focus: true },
        { id: 'shell', kind: 'shell', split: 'right', sizePct: 25 },
      ],
    },
    sandbox: {
      image: 'issue-flow-sandbox',
      yolo: true,
      panes: [
        { id: 'agent', kind: 'agent', focus: true },
        { id: 'shell', kind: 'shell', split: 'bottom', sizePct: 30 },
        { id: 'app', kind: 'command', cwd: 'worktree', workingDir: 'web', command: 'npm run dev' },
      ],
    },
  },
  true,
);

interface FakeTmux extends TmuxGateway {
  calls: string[];
  state: { windowExists: boolean; paneCount: number };
}

function fakeTmux(initial: { windowExists?: boolean; paneCount?: number } = {}): FakeTmux {
  const calls: string[] = [];
  const state = { windowExists: initial.windowExists ?? false, paneCount: initial.paneCount ?? 0 };
  return {
    calls,
    state,
    isAvailable: async () => true,
    ensureServer: async () => {
      calls.push('ensureServer');
    },
    ensureSession: async (session, cwd) => {
      calls.push(`ensureSession:${session}:${cwd}`);
    },
    hasWindow: async () => state.windowExists,
    killWindow: async (session, window) => {
      calls.push(`killWindow:${session}:${window}`);
      state.windowExists = false;
      state.paneCount = 0;
    },
    createWindow: async ({ windowName, cwd, command }) => {
      calls.push(`createWindow:${windowName}:${cwd}:${command ?? ''}`);
      state.windowExists = true;
      state.paneCount = 1;
    },
    splitWindow: async ({ target, split, sizePct, cwd }) => {
      calls.push(`split:${target}:${split}:${sizePct ?? '-'}:${cwd}`);
      state.paneCount += 1;
    },
    setWindowOption: async (_session, _window, option, value) => {
      calls.push(`option:${option}=${value}`);
    },
    runCommand: async (target, command) => {
      calls.push(`run:${target}:${command}`);
    },
    sendLiteral: async (target, text) => {
      calls.push(`literal:${target}:${text}`);
    },
    sendKeys: async (target, keys) => {
      calls.push(`keys:${target}:${keys.join(',')}`);
    },
    sendHexKeys: async (target, hexBytes) => {
      calls.push(`hex:${target}:${hexBytes.join(',')}`);
    },
    loadBuffer: async (bufferName) => {
      calls.push(`loadBuffer:${bufferName}`);
    },
    pasteBuffer: async ({ bufferName, target }) => {
      calls.push(`pasteBuffer:${bufferName}:${target}`);
    },
    hasBuffer: async () => false,
    selectPane: async (target) => {
      calls.push(`select:${target}`);
    },
    listWindows: async () => [],
    getPaneId: async () => '%1',
    countPanes: async () => state.paneCount,
    killPane: async (target) => {
      calls.push(`killPane:${target}`);
    },
  };
}

/** The pane command a profile's agent pane runs, as the launcher builds it. */
function agentCommand(profile: RuntimeProfile, resume: boolean): string {
  return buildPaneCommand({
    argv: buildTtyAgentArgv({
      provider: 'claude',
      permission: profile.permission ?? 'workspace',
      ...(resume
        ? { launchMode: 'resume' as const, resumeConversationId: CONVERSATION_ID }
        : { launchMode: 'fresh' as const, prompt: 'implement #63' }),
    }),
    runtimeEnvPath: RUNTIME_ENV,
  });
}

function planFor(profile: RuntimeProfile, resume: boolean) {
  return planSessionLayout({
    projectId: PROJECT_ID,
    branch: BRANCH,
    templates: profile.panes,
    context: {
      ...context,
      paneCommands: { ...context.paneCommands, agent: agentCommand(profile, resume) },
    },
  });
}

function requireProfile(name: string): RuntimeProfile {
  const profile = profiles[name];
  if (profile === undefined) throw new Error(`fixture profile "${name}" is missing`);
  return profile;
}

describe('C8 — switching profile', () => {
  it('builds the first window from the profile in force at creation', async () => {
    const tmux = fakeTmux();
    const result = await ensureSessionLayout(tmux, planFor(requireProfile('default'), false));

    expect(result.mode).toBe('fresh');
    expect(result.windowName).toBe('if-feat-63-thing');
    // Two panes: the window itself plus one split to the right, at 25%.
    expect(tmux.calls.filter((call) => call.startsWith('split:'))).toEqual([
      'split:if-proj-a1b2c3:if-feat-63-thing.0:right:25:/worktrees/feat/63-thing',
    ]);
    expect(tmux.calls.some((call) => call.startsWith('killWindow:'))).toBe(false);
  });

  it('recreates the window with the new layout and resumes the same conversation', async () => {
    // The worktree is open on `default`: its window exists, with its two panes.
    const tmux = fakeTmux({ windowExists: true, paneCount: 2 });

    const result = await ensureSessionLayout(tmux, planFor(requireProfile('sandbox'), true), {
      force: true,
    });

    // 1. The window was destroyed and rebuilt — not reattached.
    expect(result.mode).toBe('resume');
    expect(tmux.calls).toContain('killWindow:if-proj-a1b2c3:if-feat-63-thing');
    expect(tmux.calls.some((call) => call.startsWith('createWindow:if-feat-63-thing:'))).toBe(true);

    // 2. The layout is the new profile's: a bottom split at 30% and a third
    //    pane for the command the sandbox profile adds.
    expect(tmux.calls.filter((call) => call.startsWith('split:'))).toEqual([
      'split:if-proj-a1b2c3:if-feat-63-thing.0:bottom:30:/worktrees/feat/63-thing',
      'split:if-proj-a1b2c3:if-feat-63-thing.1:right:-:/worktrees/feat/63-thing',
    ]);
    const commandPane = tmux.calls.find((call) => call.includes('npm run dev'));
    expect(commandPane).toBe(
      "run:if-proj-a1b2c3:if-feat-63-thing.2:cd -- '/worktrees/feat/63-thing/web' && npm run dev",
    );

    // 3. The agent came back on the same conversation, with the new profile's
    //    permission applied.
    const agentPane = tmux.calls.find((call) =>
      call.startsWith('run:if-proj-a1b2c3:if-feat-63-thing.0:'),
    );
    // Every argv element is quoted on its own at the tmux boundary (ADR-04),
    // which is why the pair reads `'--resume' '<id>'` rather than a bare flag.
    expect(agentPane).toContain(`'--resume' '${CONVERSATION_ID}'`);
    expect(agentPane).toContain("'--dangerously-skip-permissions'");
    // Resuming must not re-inject the first prompt: the conversation has it.
    expect(agentPane).not.toContain('implement #63');
    expect(agentPane).toContain(`. '${RUNTIME_ENV}'`);
  });

  it('keeps the window name, so every target built from it survives the switch', async () => {
    const before = planFor(requireProfile('default'), false);
    const after = planFor(requireProfile('sandbox'), true);

    expect(after.windowName).toBe(before.windowName);
    expect(after.sessionName).toBe(before.sessionName);
  });

  // The guard for the flag itself, in the direction where nothing else catches
  // the mistake: switching *down* from the three-pane sandbox to the two-pane
  // default leaves a window that still satisfies the pane count, so a switch
  // that forgets `force` silently shows the layout it just replaced.
  it('would reattach to the old layout without force', async () => {
    const tmux = fakeTmux({ windowExists: true, paneCount: 3 });
    const result = await ensureSessionLayout(tmux, planFor(requireProfile('default'), true));

    expect(result.mode).toBe('reattach');
    expect(tmux.calls.some((call) => call.startsWith('split:'))).toBe(false);
    expect(tmux.calls.some((call) => call.startsWith('killWindow:'))).toBe(false);
  });

  it('rebuilds that same switch when force is passed', async () => {
    const tmux = fakeTmux({ windowExists: true, paneCount: 3 });
    const result = await ensureSessionLayout(tmux, planFor(requireProfile('default'), true), {
      force: true,
    });

    expect(result.mode).toBe('resume');
    expect(tmux.calls).toContain('killWindow:if-proj-a1b2c3:if-feat-63-thing');
    expect(tmux.calls.filter((call) => call.startsWith('split:'))).toEqual([
      'split:if-proj-a1b2c3:if-feat-63-thing.0:right:25:/worktrees/feat/63-thing',
    ]);
  });

  // A window that lost panes is rebuilt even without `force` — that path is the
  // reattach heuristic, not the profile switch, and it must not be confused with
  // it: three panes are expected, two are alive, so the plan is applied again.
  it('still rebuilds a window whose panes died, regardless of the profile', async () => {
    const tmux = fakeTmux({ windowExists: true, paneCount: 2 });
    const result = await ensureSessionLayout(tmux, planFor(requireProfile('sandbox'), true), {
      force: false,
    });

    expect(result.mode).toBe('resume');
  });
});
