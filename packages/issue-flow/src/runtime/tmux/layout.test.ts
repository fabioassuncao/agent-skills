import { describe, expect, it } from 'vitest';
import type { TmuxGateway } from './gateway.js';
import {
  ensureSessionLayout,
  isWorktreeOpen,
  type PaneTemplate,
  planSessionLayout,
  type SessionLayoutContext,
} from './layout.js';

/**
 * Ported from WebMux `backend/src/__tests__/session-service.test.ts` @ d8c9d5f,
 * plus the cases for the one improvement §27 asks for: reopening a worktree must
 * not kill the agent working in it.
 */

const context: SessionLayoutContext = {
  repoRoot: '/repo',
  worktreePath: '/wt/feature',
  paneCommands: { agent: 'claude --resume abc', shell: '/bin/zsh' },
};

function plan(templates: PaneTemplate[]) {
  return planSessionLayout({ projectId: 'proj-a1b2c3', branch: 'feature', templates, context });
}

interface FakeTmux extends TmuxGateway {
  calls: string[];
}

function fakeTmux(state: { windowExists?: boolean; paneCount?: number } = {}): FakeTmux {
  const calls: string[] = [];
  return {
    calls,
    isAvailable: async () => true,
    ensureServer: async () => {
      calls.push('ensureServer');
    },
    ensureSession: async (session, cwd) => {
      calls.push(`ensureSession:${session}:${cwd}`);
    },
    hasWindow: async () => state.windowExists === true,
    killWindow: async (session, window) => {
      calls.push(`killWindow:${session}:${window}`);
    },
    createWindow: async ({ windowName, cwd, command }) => {
      calls.push(`createWindow:${windowName}:${cwd}:${command ?? ''}`);
    },
    splitWindow: async ({ target, split, sizePct, cwd }) => {
      calls.push(`split:${target}:${split}:${sizePct ?? '-'}:${cwd}`);
    },
    setWindowOption: async (_session, _window, option, value) => {
      calls.push(`option:${option}=${value}`);
    },
    runCommand: async (target, command) => {
      calls.push(`run:${target}:${command}`);
    },
    selectPane: async (target) => {
      calls.push(`select:${target}`);
    },
    listWindows: async () => [],
    getPaneId: async () => '%1',
    countPanes: async () => state.paneCount ?? 0,
    killPane: async () => {},
  };
}

describe('planSessionLayout', () => {
  it('plans the agent pane first, in the worktree, with the agent command', () => {
    const result = plan([{ id: 'agent', kind: 'agent', focus: true }]);

    expect(result.sessionName).toBe('if-proj-a1b2c3');
    expect(result.windowName).toBe('if-feature');
    expect(result.shellCommand).toBe('/bin/zsh');
    expect(result.panes).toEqual([
      {
        id: 'agent',
        index: 0,
        kind: 'agent',
        cwd: '/wt/feature',
        startupCommand: 'claude --resume abc',
        focus: true,
      },
    ]);
    expect(result.focusPaneIndex).toBe(0);
  });

  // The first pane is the window itself, so only the rest carry a split.
  it('gives every pane after the first a split, defaulting to the right', () => {
    const result = plan([
      { id: 'agent', kind: 'agent' },
      { id: 'shell', kind: 'shell' },
      { id: 'logs', kind: 'shell', split: 'bottom', sizePct: 30 },
    ]);

    expect(result.panes[0]?.split).toBeUndefined();
    expect(result.panes[1]).toMatchObject({ index: 1, split: 'right' });
    expect(result.panes[2]).toMatchObject({ index: 2, split: 'bottom', sizePct: 30 });
  });

  // A shell pane already opened its shell; typing anything into it would put a
  // stray command in the user's history.
  it('gives a shell pane no startup command', () => {
    const result = plan([{ id: 'shell', kind: 'shell' }]);
    expect(result.panes[0]?.startupCommand).toBeUndefined();
  });

  it('runs a repo pane in the repository rather than in the worktree', () => {
    const result = plan([{ id: 'watch', kind: 'shell', cwd: 'repo' }]);
    expect(result.panes[0]?.cwd).toBe('/repo');
  });

  it('prefixes a command pane with a cd when it declares a working directory', () => {
    const result = plan([
      { id: 'api', kind: 'command', command: 'npm run dev', workingDir: 'packages/api' },
    ]);
    expect(result.panes[0]?.startupCommand).toBe("cd -- '/wt/feature/packages/api' && npm run dev");
  });

  it('quotes a working directory that would break the shell command', () => {
    const result = plan([
      { id: 'api', kind: 'command', command: 'npm run dev', workingDir: "it's here" },
    ]);
    expect(result.panes[0]?.startupCommand).toBe(
      "cd -- '/wt/feature/it'\\''s here' && npm run dev",
    );
  });

  it('refuses a command pane with no command instead of opening an empty one', () => {
    expect(() => plan([{ id: 'api', kind: 'command' }])).toThrow('has no command');
  });

  it('refuses an empty layout', () => {
    expect(() => plan([])).toThrow('At least one pane template is required');
  });

  it('focuses the pane that asked for it, and the first one otherwise', () => {
    expect(
      plan([
        { id: 'agent', kind: 'agent' },
        { id: 'shell', kind: 'shell', focus: true },
      ]).focusPaneIndex,
    ).toBe(1);
    expect(plan([{ id: 'agent', kind: 'agent' }]).focusPaneIndex).toBe(0);
  });
});

describe('ensureSessionLayout', () => {
  const twoPanes: PaneTemplate[] = [
    { id: 'agent', kind: 'agent', focus: true },
    { id: 'shell', kind: 'shell' },
  ];

  it('builds the window from scratch when nothing exists', async () => {
    const tmux = fakeTmux();
    const result = await ensureSessionLayout(tmux, plan(twoPanes));

    expect(result.mode).toBe('fresh');
    expect(tmux.calls).toEqual([
      'ensureServer',
      'ensureSession:if-proj-a1b2c3:/wt/feature',
      'createWindow:if-feature:/wt/feature:/bin/zsh',
      'option:pane-base-index=0',
      'option:automatic-rename=off',
      'option:allow-rename=off',
      // Split from the previous pane, not from whichever tmux left active.
      'split:if-proj-a1b2c3:if-feature.0:right:-:/wt/feature',
      'run:if-proj-a1b2c3:if-feature.0:claude --resume abc',
      'select:if-proj-a1b2c3:if-feature.0',
    ]);
  });

  // The improvement over the upstream (§27): reopening a worktree whose window
  // is intact must not kill the agent that is working in it.
  it('reattaches to an intact window without killing anything', async () => {
    const tmux = fakeTmux({ windowExists: true, paneCount: 2 });
    const result = await ensureSessionLayout(tmux, plan(twoPanes));

    expect(result.mode).toBe('reattach');
    expect(tmux.calls).toEqual([
      'ensureServer',
      'ensureSession:if-proj-a1b2c3:/wt/feature',
      'select:if-proj-a1b2c3:if-feature.0',
    ]);
    expect(tmux.calls.some((call) => call.startsWith('killWindow'))).toBe(false);
    expect(tmux.calls.some((call) => call.startsWith('createWindow'))).toBe(false);
  });

  // tmux removes a pane as soon as its command exits, so a window short of
  // panes is a window something died in — rebuilding is then correct.
  it('rebuilds a window that lost panes, and calls it a resume', async () => {
    const tmux = fakeTmux({ windowExists: true, paneCount: 1 });
    const result = await ensureSessionLayout(tmux, plan(twoPanes));

    expect(result.mode).toBe('resume');
    expect(tmux.calls).toContain('killWindow:if-proj-a1b2c3:if-feature');
    expect(tmux.calls).toContain('createWindow:if-feature:/wt/feature:/bin/zsh');
  });

  // The escape hatch for a profile change: the layout itself is what changed,
  // so reattaching would show the old one.
  it('rebuilds an intact window when forced', async () => {
    const tmux = fakeTmux({ windowExists: true, paneCount: 2 });
    const result = await ensureSessionLayout(tmux, plan(twoPanes), { force: true });

    expect(result.mode).toBe('resume');
    expect(tmux.calls).toContain('killWindow:if-proj-a1b2c3:if-feature');
  });

  it('creates the session in the first pane cwd, which is where the agent runs', async () => {
    const tmux = fakeTmux();
    await ensureSessionLayout(
      tmux,
      plan([
        { id: 'watch', kind: 'shell', cwd: 'repo' },
        { id: 'agent', kind: 'agent' },
      ]),
    );
    expect(tmux.calls).toContain('ensureSession:if-proj-a1b2c3:/repo');
  });

  it('passes a pane size through to the split', async () => {
    const tmux = fakeTmux();
    await ensureSessionLayout(
      tmux,
      plan([
        { id: 'agent', kind: 'agent' },
        { id: 'logs', kind: 'shell', split: 'bottom', sizePct: 25 },
      ]),
    );
    expect(tmux.calls).toContain('split:if-proj-a1b2c3:if-feature.0:bottom:25:/wt/feature');
  });
});

describe('isWorktreeOpen', () => {
  it('asks about the branch window in the project session', async () => {
    await expect(isWorktreeOpen(fakeTmux({ windowExists: true }), 'proj', 'feature')).resolves.toBe(
      true,
    );
    await expect(isWorktreeOpen(fakeTmux(), 'proj', 'feature')).resolves.toBe(false);
  });
});
