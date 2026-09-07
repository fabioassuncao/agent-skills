import { beforeEach, describe, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => vi.fn());
vi.mock('../../utils/shell.js', () => ({ run }));

import { createTmuxGateway } from './gateway.js';
import { resetUtf8LocaleCache } from './locale.js';

function result(exitCode: number, stdout = '', stderr = '') {
  return { exitCode, stdout, stderr };
}

describe('strict tmux window shutdown', () => {
  beforeEach(() => {
    run.mockReset();
    resetUtf8LocaleCache();
    // detectUtf8Locale() is the first shell call of each fresh case.
    run.mockResolvedValueOnce(result(0, 'C.UTF-8'));
  });

  it('propagates a real kill-window failure without checking it away', async () => {
    run.mockResolvedValueOnce(result(1, '', 'permission denied'));
    const tmux = createTmuxGateway({ socketName: 'test' });

    await expect(tmux.killWindowStrict?.('session', 'window')).rejects.toThrow('permission denied');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('fails when tmux cannot prove the window is absent', async () => {
    run.mockResolvedValueOnce(result(0));
    run.mockResolvedValueOnce(result(1, '', 'server returned an invalid response'));
    const tmux = createTmuxGateway({ socketName: 'test' });

    await expect(tmux.killWindowStrict?.('session', 'window')).rejects.toThrow(
      'confirm tmux window session:window stopped failed',
    );
  });

  it('fails when the post-kill listing still contains the window', async () => {
    run.mockResolvedValueOnce(result(0));
    run.mockResolvedValueOnce(result(0, 'other\nwindow\n'));
    const tmux = createTmuxGateway({ socketName: 'test' });

    await expect(tmux.killWindowStrict?.('session', 'window')).rejects.toThrow('is still running');
  });

  it('accepts an absent tmux session as a proved absence', async () => {
    run.mockResolvedValueOnce(result(1, '', "can't find session: session"));
    run.mockResolvedValueOnce(result(1, '', "can't find session: session"));
    const tmux = createTmuxGateway({ socketName: 'test' });

    await expect(tmux.killWindowStrict?.('session', 'window')).resolves.toBeUndefined();
  });

  it('uses the signed owner tag instead of a grouped viewer alias', async () => {
    const ownerTag = Buffer.from(
      JSON.stringify({
        v: 1,
        ownerSessionName: 'if-project-owner',
        ownerToken: 'durable-pane-token',
      }),
      'utf8',
    ).toString('base64url');
    run.mockResolvedValueOnce(result(0, `%7\tif-view-browser\tif-feature\t${ownerTag}`));
    const tmux = createTmuxGateway({ socketName: 'test' });

    await expect(tmux.getPaneIdentity?.('%7')).resolves.toEqual({
      paneId: '%7',
      sessionName: 'if-project-owner',
      windowName: 'if-feature',
      ownerToken: 'durable-pane-token',
    });
  });

  it('encodes both project owner and nonce in the pane option', async () => {
    run.mockResolvedValueOnce(result(0));
    const tmux = createTmuxGateway({ socketName: 'test' });

    await tmux.tagPaneOwner?.('%8', 'nonce', 'if-project-owner');

    const args = run.mock.calls[1]?.[1] as string[];
    const encoded = args.at(-1) as string;
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toEqual({
      v: 1,
      ownerSessionName: 'if-project-owner',
      ownerToken: 'nonce',
    });
  });
});
