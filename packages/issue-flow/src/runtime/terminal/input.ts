import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { TmuxGateway } from '../tmux/gateway.js';

/**
 * Delivering text to an agent that is running as a TUI in a tmux pane.
 *
 * Ported from `sendPrompt` / `interruptPrompt` / `sendKeys` in WebMux
 * `backend/src/adapters/terminal.ts` @ d8c9d5f. §2.4 of the absorption plan
 * calls this the best isolated artefact in the whole upstream, and the reason is
 * one line of difference:
 *
 * `send-keys -l` of a long text delivers it **character by character**. A TUI
 * with autocomplete, slash commands or paste detection reacts halfway through —
 * it opens a menu on `/`, it submits on an embedded newline, it debounces. Load
 * the text into a tmux buffer and paste it instead, and the whole block arrives
 * as one paste event the TUI already knows how to handle.
 *
 * The prompt of a *first* invocation does not come through here at all: it
 * travels in the agent's own argv (ADR-04, §2.4), which has no race to lose.
 * This is for the turns after that one.
 */

/** Prefix of the tmux buffers this module creates, so a stray one is identifiable. */
export const PROMPT_BUFFER_PREFIX = 'if-prompt';

export interface SendPromptOptions {
  /** Text typed literally before the paste — a slash command, for instance. */
  preamble?: string;
  /**
   * Pause between the paste and the Enter.
   *
   * Some TUIs finish processing a bracketed paste asynchronously; submitting in
   * the same tick can land before the input buffer has the text.
   */
  submitDelayMs?: number;
  /** Paste without submitting, leaving the text in the TUI's input. */
  submit?: boolean;
}

function buildBufferName(): string {
  return `${PROMPT_BUFFER_PREFIX}-${Date.now()}-${randomBytes(3).toString('hex')}`;
}

/**
 * Deliver a prompt to a pane as a single paste.
 *
 * NUL bytes are stripped because tmux buffers cannot carry them and a prompt
 * assembled from file content occasionally has one. The buffer is deleted by
 * the paste itself (`-d`), so a prompt never lingers in tmux's paste buffers
 * where the user's own `prefix ]` could produce it again.
 */
export async function sendPrompt(
  tmux: TmuxGateway,
  target: string,
  text: string,
  options: SendPromptOptions = {},
): Promise<void> {
  if (options.preamble !== undefined && options.preamble !== '') {
    await tmux.sendLiteral(target, options.preamble);
  }

  const bufferName = buildBufferName();
  await tmux.loadBuffer(bufferName, text.replaceAll('\0', ''));
  await tmux.pasteBuffer({
    bufferName,
    target,
    // `-r` so newlines inside the prompt stay newlines instead of becoming
    // submissions, and `-p` so the TUI receives it as a paste rather than as
    // very fast typing.
    raw: true,
    bracketed: true,
    deleteAfter: true,
  });

  if (options.submit === false) return;
  if (options.submitDelayMs !== undefined && options.submitDelayMs > 0) {
    await delay(options.submitDelayMs);
  }
  await tmux.sendKeys(target, ['Enter']);
}

/** Interrupt whatever the agent is doing, exactly as a person pressing Ctrl-C. */
export async function interruptPrompt(tmux: TmuxGateway, target: string): Promise<void> {
  await tmux.sendKeys(target, ['C-c']);
}

/**
 * Forward raw key bytes from a viewer's terminal.
 *
 * Hex rather than key names: a modern TUI expects CSI u encodings that tmux has
 * no name for, and translating them into names would lose the distinctions the
 * encoding exists to make.
 */
export async function sendRawKeys(
  tmux: TmuxGateway,
  target: string,
  hexBytes: string[],
): Promise<void> {
  if (hexBytes.length === 0) return;
  await tmux.sendHexKeys(target, hexBytes);
}
