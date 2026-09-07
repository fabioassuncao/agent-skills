import { describe, expect, it } from 'vitest';
import type { TmuxGateway } from '../tmux/gateway.js';
import { interruptPrompt, PROMPT_BUFFER_PREFIX, sendPrompt, sendRawKeys } from './input.js';

/**
 * **C5** of §34: sending a prompt uses `load-buffer` + `paste-buffer -rp -d`
 * followed by `Enter`, and the buffer is gone afterwards.
 *
 * Ported from `sendPrompt` in WebMux `backend/src/adapters/terminal.ts`
 * @ d8c9d5f — the single best isolated artefact in the upstream (§2.4).
 */

interface FakeTmux extends TmuxGateway {
  calls: string[];
  buffers: Map<string, string>;
}

function fakeTmux(): FakeTmux {
  const calls: string[] = [];
  const buffers = new Map<string, string>();
  return {
    calls,
    buffers,
    isAvailable: async () => true,
    ensureServer: async () => {},
    ensureSession: async () => {},
    hasWindow: async () => true,
    killWindow: async () => {},
    createWindow: async () => {},
    splitWindow: async () => {},
    setWindowOption: async () => {},
    runCommand: async () => {},
    sendLiteral: async (target, text) => {
      calls.push(`literal:${target}:${text}`);
    },
    sendKeys: async (target, keys) => {
      calls.push(`keys:${target}:${keys.join(',')}`);
    },
    sendHexKeys: async (target, hexBytes) => {
      calls.push(`hex:${target}:${hexBytes.join(',')}`);
    },
    loadBuffer: async (bufferName, content) => {
      buffers.set(bufferName, content);
      calls.push(`load:${bufferName}:${content.length}`);
    },
    pasteBuffer: async ({ bufferName, target, raw, bracketed, deleteAfter }) => {
      calls.push(
        `paste:${bufferName}:${target}:raw=${raw !== false}:bracketed=${bracketed !== false}:delete=${deleteAfter !== false}`,
      );
      if (deleteAfter !== false) buffers.delete(bufferName);
    },
    hasBuffer: async (bufferName) => buffers.has(bufferName),
    selectPane: async () => {},
    listWindows: async () => [],
    getPaneId: async () => '%1',
    countPanes: async () => 1,
    killPane: async () => {},
  };
}

describe('sendPrompt', () => {
  // `send-keys -l` of a long text arrives character by character, and a TUI with
  // autocomplete, slash commands or paste detection reacts halfway through. A
  // buffer paste arrives as one event the TUI already knows how to handle.
  it('C5: loads a buffer, pastes it raw and bracketed, then submits', async () => {
    const tmux = fakeTmux();
    await sendPrompt(tmux, 'if-proj:if-feature.0', 'keep going');

    const [load, paste, enter] = tmux.calls;
    expect(load).toMatch(new RegExp(`^load:${PROMPT_BUFFER_PREFIX}-\\d+-[0-9a-f]{6}:10$`));
    expect(paste).toMatch(
      /^paste:if-prompt-.*:if-proj:if-feature\.0:raw=true:bracketed=true:delete=true$/,
    );
    expect(enter).toBe('keys:if-proj:if-feature.0:Enter');
  });

  // A prompt left in tmux's paste buffers could be produced again by the user's
  // own `prefix ]`, in a pane that may not be theirs.
  it('leaves no buffer behind', async () => {
    const tmux = fakeTmux();
    await sendPrompt(tmux, 'target', 'keep going');
    expect(tmux.buffers.size).toBe(0);
  });

  it('gives every prompt its own buffer name', async () => {
    const tmux = fakeTmux();
    await sendPrompt(tmux, 'target', 'one');
    await sendPrompt(tmux, 'target', 'two');
    const names = tmux.calls
      .filter((call) => call.startsWith('load:'))
      .map((call) => call.split(':')[1]);
    expect(new Set(names).size).toBe(2);
  });

  // tmux buffers cannot carry NUL, and a prompt assembled from file content
  // occasionally has one.
  it('strips NUL bytes, which a tmux buffer cannot carry', async () => {
    const tmux = fakeTmux();
    await sendPrompt(tmux, 'target', 'a\0b');
    expect([...tmux.buffers.values()]).toEqual([]);
    expect(tmux.calls[0]).toContain(':2');
  });

  it('types a preamble literally before the paste', async () => {
    const tmux = fakeTmux();
    await sendPrompt(tmux, 'target', 'body', { preamble: '/compact ' });
    expect(tmux.calls[0]).toBe('literal:target:/compact ');
    expect(tmux.calls[1]).toMatch(/^load:/);
  });

  it('can leave the text in the input instead of submitting it', async () => {
    const tmux = fakeTmux();
    await sendPrompt(tmux, 'target', 'draft', { submit: false });
    expect(tmux.calls.some((call) => call.startsWith('keys:'))).toBe(false);
  });

  // Some TUIs finish processing a bracketed paste asynchronously; submitting in
  // the same tick can land before the input buffer has the text.
  it('waits before submitting when a delay was asked for', async () => {
    const tmux = fakeTmux();
    const startedAt = Date.now();
    await sendPrompt(tmux, 'target', 'body', { submitDelayMs: 40 });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(35);
    expect(tmux.calls.at(-1)).toBe('keys:target:Enter');
  });

  it('carries a prompt far larger than a command line would accept', async () => {
    const tmux = fakeTmux();
    const large = 'x'.repeat(200_000);
    await sendPrompt(tmux, 'target', large);
    expect(tmux.calls[0]).toContain(':200000');
  });
});

describe('interruptPrompt', () => {
  it('sends exactly what a person pressing Ctrl-C would', async () => {
    const tmux = fakeTmux();
    await interruptPrompt(tmux, 'target');
    expect(tmux.calls).toEqual(['keys:target:C-c']);
  });
});

describe('sendRawKeys', () => {
  // Hex rather than key names: a modern TUI expects CSI u encodings tmux has no
  // name for, and translating them would lose the distinctions they exist for.
  it('forwards raw bytes as hex', async () => {
    const tmux = fakeTmux();
    await sendRawKeys(tmux, 'target', ['0x1b', '0x5b', '0x41']);
    expect(tmux.calls).toEqual(['hex:target:0x1b,0x5b,0x41']);
  });

  it('does nothing for an empty burst', async () => {
    const tmux = fakeTmux();
    await sendRawKeys(tmux, 'target', []);
    expect(tmux.calls).toEqual([]);
  });
});
