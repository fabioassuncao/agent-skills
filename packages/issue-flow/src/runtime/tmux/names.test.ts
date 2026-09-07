import { describe, expect, it } from 'vitest';
import { leakedProjectEnvKeys, PROJECT_ENV_KEYS_VARIABLE, stripProjectEnv } from './env.js';
import { chooseUtf8Locale, pickTmuxLocale } from './locale.js';
import {
  buildPaneTarget,
  buildProjectSessionName,
  buildWorktreeParkingWindowName,
  buildWorktreeWindowName,
  parseWindowSummaries,
  sanitizeTmuxNameSegment,
} from './names.js';

/**
 * Ported from WebMux `backend/src/__tests__/tmux-adapter.test.ts` @ d8c9d5f —
 * the pure half. What needs a tmux server is in `gateway.integration.test.ts`.
 */
describe('tmux names', () => {
  it('reduces a value to what tmux accepts in a name', () => {
    expect(sanitizeTmuxNameSegment('Feature/63 Thing!')).toBe('feature-63-thing');
    expect(sanitizeTmuxNameSegment('a___b')).toBe('a___b');
    expect(sanitizeTmuxNameSegment('--leading-and-trailing--')).toBe('leading-and-trailing');
    expect(sanitizeTmuxNameSegment('a very long value indeed', 6)).toBe('a-very');
  });

  // tmux reads `:` and `.` as target separators, so a name carrying either
  // turns `session:window.pane` into something that resolves somewhere else.
  it('removes the characters tmux treats as target separators', () => {
    expect(sanitizeTmuxNameSegment('a:b.c')).toBe('a-b-c');
  });

  // An empty segment would produce `if--<hash>`, which is a different name that
  // several different inputs would share.
  it('never produces an empty segment', () => {
    expect(sanitizeTmuxNameSegment('!!!')).toBe('x');
    expect(sanitizeTmuxNameSegment('')).toBe('x');
  });

  // Keyed by the project id, not by a hash of the path: the id comes from the
  // git remote, so it survives moving the directory and matches across clones.
  it('names one session per project, from the project id', () => {
    expect(buildProjectSessionName('issue-flow-a1b2c3d4e5f6')).toBe('if-issue-flow-a1b2c3d4e5f6');
    expect(buildProjectSessionName('issue-flow-a1b2c3d4e5f6')).toBe(
      buildProjectSessionName('issue-flow-a1b2c3d4e5f6'),
    );
    expect(buildProjectSessionName('other-999999999999')).not.toBe(
      buildProjectSessionName('issue-flow-a1b2c3d4e5f6'),
    );
  });

  it('names one window per worktree and a parking window beside it', () => {
    expect(buildWorktreeWindowName('feat/63-thing')).toBe('if-feat-63-thing');
    expect(buildWorktreeParkingWindowName('wt-feat-63-thing')).toMatch(
      /^ifp-wt-feat-63-thing-[a-f0-9]{12}$/,
    );
    expect(buildWorktreeParkingWindowName('wt-foo')).not.toBe(buildWorktreeWindowName('p-wt-foo'));
    expect(buildWorktreeParkingWindowName(`${'same-prefix-'.repeat(4)}a`)).not.toBe(
      buildWorktreeParkingWindowName(`${'same-prefix-'.repeat(4)}b`),
    );
  });

  it('builds pane targets in the only form tmux understands', () => {
    expect(buildPaneTarget('if-proj', 'if-feature', 2)).toBe('if-proj:if-feature.2');
  });
});

describe('parseWindowSummaries', () => {
  it('parses the tab-separated listing of every window', () => {
    const output = ['if-a\tif-feature\t2', 'if-a\tif-other\t1'].join('\n');
    expect(parseWindowSummaries(output)).toEqual([
      { sessionName: 'if-a', windowName: 'if-feature', paneCount: 2 },
      { sessionName: 'if-a', windowName: 'if-other', paneCount: 1 },
    ]);
  });

  it('drops blank and malformed lines rather than inventing entries', () => {
    expect(parseWindowSummaries('\n\n')).toEqual([]);
    expect(parseWindowSummaries('no-tabs-here')).toEqual([]);
    expect(parseWindowSummaries('if-a\tif-feature')).toEqual([
      { sessionName: 'if-a', windowName: 'if-feature', paneCount: 0 },
    ]);
  });

  // This is the failure `locale.ts` exists to prevent: under a non-UTF-8 locale
  // tmux rewrites the TAB as `_`, every line fails to split, and every window
  // silently disappears.
  it('produces nothing when the separator was rewritten, which is what makes the locale matter', () => {
    expect(parseWindowSummaries('if-a_if-feature_2')).toEqual([]);
  });
});

describe('chooseUtf8Locale', () => {
  it('prefers a neutral C.UTF-8 so no collation leaks into panes', () => {
    expect(chooseUtf8Locale(['en_US.UTF-8', 'C.UTF-8', 'pt_BR.UTF-8'])).toBe('C.UTF-8');
  });

  it('returns the exact listed spelling, so setlocale accepts it', () => {
    expect(chooseUtf8Locale(['C.utf8'])).toBe('C.utf8');
    expect(chooseUtf8Locale(['en_US.utf8'])).toBe('en_US.utf8');
  });

  // Older macOS has no C.UTF-8 but has en_US.UTF-8; minimal Linux images are
  // often the other way round. Both have to work.
  it('falls back through en_US and then to any UTF-8 the host lists', () => {
    expect(chooseUtf8Locale(['POSIX', 'en_US.UTF-8'])).toBe('en_US.UTF-8');
    expect(chooseUtf8Locale(['POSIX', 'pt_BR.UTF-8'])).toBe('pt_BR.UTF-8');
  });

  it('uses the literal only when the host lists nothing usable', () => {
    expect(chooseUtf8Locale([])).toBe('C.UTF-8');
    expect(chooseUtf8Locale(['POSIX', 'C'])).toBe('C.UTF-8');
  });
});

describe('pickTmuxLocale', () => {
  // A user who set LANG=pt_BR.UTF-8 meant it, and it is already UTF-8.
  it('keeps a UTF-8 locale the environment already carries', () => {
    expect(pickTmuxLocale({ LANG: 'pt_BR.UTF-8' }, 'C.UTF-8')).toBe('pt_BR.UTF-8');
    expect(pickTmuxLocale({ LC_ALL: 'en_US.utf8' }, 'C.UTF-8')).toBe('en_US.utf8');
    expect(pickTmuxLocale({ LC_CTYPE: 'C.UTF-8' }, 'x')).toBe('C.UTF-8');
  });

  it('respects the precedence LC_ALL > LC_CTYPE > LANG', () => {
    expect(pickTmuxLocale({ LC_ALL: 'a.UTF-8', LC_CTYPE: 'b.UTF-8', LANG: 'c.UTF-8' }, 'x')).toBe(
      'a.UTF-8',
    );
    expect(pickTmuxLocale({ LC_CTYPE: 'b.UTF-8', LANG: 'c.UTF-8' }, 'x')).toBe('b.UTF-8');
  });

  // The launchd case: an agent that inherits no LANG at all.
  it('substitutes the fallback when the environment carries no UTF-8 locale', () => {
    expect(pickTmuxLocale({}, 'C.UTF-8')).toBe('C.UTF-8');
    expect(pickTmuxLocale({ LANG: 'C' }, 'C.UTF-8')).toBe('C.UTF-8');
    expect(pickTmuxLocale({ LANG: 'en_US.ISO8859-1' }, 'C.UTF-8')).toBe('C.UTF-8');
  });
});

describe('project environment stripping', () => {
  // Whichever tmux command first starts the server fixes the global environment
  // for the server's whole life; a project's .env captured there reaches every
  // pane of every project afterwards.
  it('removes the keys a project loaded, and the marker itself', () => {
    const env = {
      [PROJECT_ENV_KEYS_VARIABLE]: 'DATABASE_URL, STRIPE_KEY',
      DATABASE_URL: 'postgres://secret',
      STRIPE_KEY: 'sk_live',
      PATH: '/usr/bin',
    };
    expect(leakedProjectEnvKeys(env)).toEqual(
      new Set([PROJECT_ENV_KEYS_VARIABLE, 'DATABASE_URL', 'STRIPE_KEY']),
    );
    expect(stripProjectEnv(env)).toEqual({ PATH: '/usr/bin' });
  });

  it('keeps everything when no project keys were declared', () => {
    expect(leakedProjectEnvKeys({ PATH: '/usr/bin' }).size).toBe(0);
    expect(stripProjectEnv({ PATH: '/usr/bin' })).toEqual({ PATH: '/usr/bin' });
  });

  it('drops undefined values instead of passing them to a child process', () => {
    expect(stripProjectEnv({ PATH: '/usr/bin', EMPTY: undefined })).toEqual({ PATH: '/usr/bin' });
  });
});
