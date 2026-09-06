import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { isInteractive, promptConfirm, promptSelect } from './prompts.js';

function streams(): {
  stdin: PassThrough;
  stdout: PassThrough;
  written: () => string;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = '';
  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  return { stdin, stdout, written: () => output };
}

describe('isInteractive', () => {
  it.each([
    { stdin: true, stdout: true, ci: undefined, expected: true },
    { stdin: true, stdout: true, ci: '', expected: true },
    { stdin: true, stdout: true, ci: '0', expected: true },
    { stdin: true, stdout: true, ci: 'false', expected: true },
    { stdin: true, stdout: true, ci: 'FALSE', expected: true },
    { stdin: false, stdout: true, ci: undefined, expected: false },
    { stdin: true, stdout: false, ci: undefined, expected: false },
    { stdin: true, stdout: true, ci: '1', expected: false },
    { stdin: true, stdout: true, ci: 'true', expected: false },
  ])('returns $expected for stdin=$stdin stdout=$stdout CI=$ci', ({
    stdin,
    stdout,
    ci,
    expected,
  }) => {
    expect(
      isInteractive({
        stdin: { isTTY: stdin },
        stdout: { isTTY: stdout },
        ci,
      }),
    ).toBe(expected);
  });
});

describe('prompt adapter', () => {
  const originalNoColor = process.env.NO_COLOR;
  const originalForceColor = process.env.FORCE_COLOR;

  afterEach(() => {
    if (originalNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = originalNoColor;
    if (originalForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = originalForceColor;
  });

  it('passes injected streams to select and returns the selected value', async () => {
    const { stdin, stdout, written } = streams();
    const answer = promptSelect({
      message: 'Pick one',
      options: [
        { value: 'first', label: 'First' },
        { value: 'second', label: 'Second' },
      ],
      stdin,
      stdout,
    });

    stdin.write('\r');

    await expect(answer).resolves.toEqual({ status: 'submitted', value: 'first' });
    expect(written()).toContain('Pick one');
  });

  it('passes injected streams to confirm and preserves a false answer', async () => {
    const { stdin, stdout } = streams();
    const answer = promptConfirm({ message: 'Continue?', stdin, stdout });

    stdin.write('n');

    await expect(answer).resolves.toEqual({ status: 'submitted', value: false });
  });

  it.each([
    ['Esc', '\u001b'],
    ['Ctrl+C', '\u0003'],
  ])('returns cancellation for %s instead of a default', async (_label, key) => {
    const { stdin, stdout } = streams();
    const answer = promptConfirm({
      message: 'Continue?',
      initialValue: true,
      stdin,
      stdout,
    });

    stdin.write(key);

    await expect(answer).resolves.toEqual({ status: 'cancelled' });
  });

  it('returns cancellation when the injected signal aborts', async () => {
    const { stdin, stdout } = streams();
    const controller = new AbortController();
    const answer = promptConfirm({
      message: 'Continue?',
      stdin,
      stdout,
      signal: controller.signal,
    });

    controller.abort();

    await expect(answer).resolves.toEqual({ status: 'cancelled' });
  });

  it('returns cancellation on EOF instead of hanging or accepting a default', async () => {
    const { stdin, stdout } = streams();
    const answer = promptConfirm({
      message: 'Continue?',
      initialValue: true,
      stdin,
      stdout,
    });

    stdin.end();

    await expect(answer).resolves.toEqual({ status: 'cancelled' });
  });

  it('removes SGR colors for NO_COLOR while retaining Clack Unicode glyphs', async () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    const { stdin, stdout, written } = streams();
    const answer = promptConfirm({
      message: 'Continue?',
      stdin,
      stdout,
      env: { NO_COLOR: '1' },
    });

    stdin.write('y');
    await answer;

    const sgrSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-9;:]*m`);
    expect(written()).not.toMatch(sgrSequence);
    expect(written()).toContain('◆');
  });
});
