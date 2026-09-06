import { describe, expect, it } from 'vitest';
import { buildAttachCommand, VIEWER_SESSION_PREFIX } from './attach.js';
import { buildPtyArgs } from './pty.js';

/**
 * Ported from WebMux `backend/src/adapters/terminal.ts` @ d8c9d5f
 * (`buildAttachCmd`, `buildPtyArgs`). Both are pure, and the attach command is
 * compared literally: every step in it is there for a reason the upstream
 * learned, and a port that quietly dropped one would look fine until the day it
 * mattered.
 */
describe('buildAttachCommand', () => {
  const base = {
    viewerSessionName: 'if-view-1234-abcd',
    ownerSessionName: 'if-proj-a1b2',
    windowName: 'if-feature',
    cols: 120,
    rows: 40,
    socketName: 'issue-flow',
  };

  it('builds the grouped-session attach, step by step', () => {
    expect(buildAttachCommand(base).split(' && ')).toEqual([
      // Grouped with the project's session: same windows, own client, own size.
      "tmux -L 'issue-flow' new-session -d -s 'if-view-1234-abcd' -t 'if-proj-a1b2'",
      // On the *owner*: the window follows the most recent client instead of
      // shrinking to the smallest one, so a phone cannot squeeze everyone else.
      "tmux -L 'issue-flow' set-option -t 'if-proj-a1b2' window-size latest",
      "tmux -L 'issue-flow' set-option -t 'if-view-1234-abcd' mouse on",
      "tmux -L 'issue-flow' set-option -t 'if-view-1234-abcd' set-clipboard on",
      "tmux -L 'issue-flow' select-window -t 'if-view-1234-abcd:if-feature'",
      // Defensive unzoom: zoom state is shared across grouped sessions, so a
      // viewer that left a pane zoomed leaves the next one looking at one pane.
      `if [ "$(tmux -L 'issue-flow' display-message -t 'if-view-1234-abcd:if-feature' -p '#{window_zoomed_flag}')" = "1" ]; then tmux -L 'issue-flow' resize-pane -Z -t 'if-view-1234-abcd:if-feature'; fi`,
      "tmux -L 'issue-flow' select-pane -t 'if-view-1234-abcd:if-feature.0'",
      // Size before attach, so the first frame is already the right shape.
      'stty rows 40 cols 120',
      "exec tmux -L 'issue-flow' attach-session -t 'if-view-1234-abcd'",
    ]);
  });

  // Zooming unasked would hide the other panes on a wide screen; it is what
  // makes a narrow one usable, so it happens only when a pane was named.
  it('zooms the pane only when one was named', () => {
    // The defensive unzoom targets the *window* and is always present; what is
    // conditional is the zoom of a specific pane.
    expect(buildAttachCommand(base)).not.toContain(
      "resize-pane -Z -t 'if-view-1234-abcd:if-feature.",
    );
    const zoomed = buildAttachCommand({ ...base, initialPane: 1 });
    expect(zoomed).toContain(
      "tmux -L 'issue-flow' resize-pane -Z -t 'if-view-1234-abcd:if-feature.1'",
    );
    expect(zoomed).toContain(
      "tmux -L 'issue-flow' select-pane -t 'if-view-1234-abcd:if-feature.1'",
    );
  });

  // The socket is never the user's default one (ADR-09).
  it('always names the dedicated socket', () => {
    const command = buildAttachCommand({ ...base, socketName: undefined });
    expect(
      command.split(' && ').every((step) => !step.startsWith('tmux ') || step.includes('-L')),
    ).toBe(true);
    expect(command).toContain("-L 'issue-flow'");
  });

  it('quotes every name, so a branch with a quote cannot break the command', () => {
    const command = buildAttachCommand({ ...base, windowName: "if-it's" });
    expect(command).toContain("'if-view-1234-abcd:if-it'\\''s'");
  });

  it('names viewer sessions distinguishably from worktree windows', () => {
    expect(VIEWER_SESSION_PREFIX).toBe('if-view');
  });
});

describe('buildPtyArgs', () => {
  // macOS ships an incompatible `script`, which is why python3 is used there
  // unconditionally rather than probed.
  it('wraps a command with python3', () => {
    expect(buildPtyArgs('python3', 'echo hi')).toEqual([
      'python3',
      '-c',
      'import pty,sys;pty.spawn(sys.argv[1:])',
      'bash',
      '-c',
      'echo hi',
    ]);
  });

  it('wraps a command with script, discarding the transcript it insists on', () => {
    expect(buildPtyArgs('script', 'echo hi')).toEqual([
      'script',
      '-q',
      '-c',
      'echo hi',
      '/dev/null',
    ]);
  });

  // The command reaches the wrapper as one argv element, so nothing in it is
  // re-parsed by an intermediate shell.
  it('keeps a command with quotes and semicolons as one argument', () => {
    const command = "tmux new-session -s 'a b' && echo done; true";
    expect(buildPtyArgs('python3', command).at(-1)).toBe(command);
    expect(buildPtyArgs('script', command)[3]).toBe(command);
  });
});
