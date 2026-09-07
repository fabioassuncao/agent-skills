import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sendPrompt } from '../runtime/terminal/input.js';
import { createTmuxGateway, type TmuxGateway } from '../runtime/tmux/gateway.js';
import { buildPaneCommand, buildTtyAgentArgv, renderShellCommand } from './tty.js';

/**
 * **C4** and **C5** of §34, against a real shell and a real tmux server.
 *
 * The unit tests assert on the argv this project builds. These assert the thing
 * that actually matters afterwards: that a real `/bin/sh` parses the rendered
 * command back into exactly that argv, and that a prompt pasted through a tmux
 * buffer arrives whole in a pane with no buffer left behind.
 */
const socketName = `issue-flow-tty-${randomUUID().slice(0, 8)}`;
const tmuxAvailable = spawnSync('tmux', ['-V']).status === 0;

async function killTestServer(): Promise<void> {
  await execa('tmux', ['-L', socketName, 'kill-server'], { reject: false });
}

/**
 * Parse a command line the way a POSIX shell does, and report the argv.
 *
 * `printf '%s\0'` on `"$@"` is the only way to read the arguments back without
 * a separator a value could itself contain — which is precisely the failure a
 * quoting bug would produce.
 */
async function shellArgv(commandLine: string): Promise<string[]> {
  const result = await execa('/bin/sh', ['-c', `set -- ${commandLine}; printf '%s\\0' "$@"`], {
    reject: false,
    encoding: 'utf8',
  });
  if (result.exitCode !== 0) throw new Error(`shell rejected the command: ${result.stderr}`);
  return result.stdout.split('\0').filter((entry) => entry !== '');
}

describe('C4: the rendered command parses back to the argv that was built', () => {
  it('round-trips an ordinary invocation', async () => {
    const argv = buildTtyAgentArgv({
      provider: 'claude',
      permission: 'autonomous',
      prompt: 'do the thing',
    });
    await expect(shellArgv(renderShellCommand(argv))).resolves.toEqual(argv);
  });

  // Each of these breaks a naive quoting scheme in a different way, and each
  // one is something a real prompt contains.
  it.each([
    ['a quote', "it's fine"],
    ['a command substitution', '$(rm -rf ~)'],
    ['backticks', '`whoami`'],
    ['a semicolon', 'first; second'],
    ['a newline', 'line one\nline two'],
    ['a glob', 'delete *'],
    ['a variable', 'cost is $HOME'],
    ['a backslash', 'a\\b'],
    ['an injection attempt', "'; rm -rf ~; echo '"],
  ])('round-trips a prompt containing %s', async (_label, prompt) => {
    const argv = buildTtyAgentArgv({ provider: 'claude', permission: 'autonomous', prompt });
    const parsed = await shellArgv(renderShellCommand(argv));
    expect(parsed).toEqual(argv);
    // And specifically: the prompt is one argument, not several.
    expect(parsed.at(-1)).toBe(prompt);
  });

  it('round-trips a full pane command, bootstrap included', async () => {
    const argv = buildTtyAgentArgv({
      provider: 'codex',
      permission: 'autonomous',
      prompt: "keep going; it's fine",
    });
    const command = buildPaneCommand({ argv, runtimeEnvPath: '/tmp/does-not-exist.env' });
    // The bootstrap sources a file that is not there, so the shell reports it —
    // what is being checked is that the agent command is still one argv after it.
    const [, agentPart] = command.split('; set +a; ');
    await expect(shellArgv(agentPart as string)).resolves.toEqual(argv);
  });
});

describe('C5: a prompt reaches a real pane as a single paste', () => {
  let tmux: TmuxGateway;
  let cwd: string;
  const dirs: string[] = [];

  beforeEach(async () => {
    tmux = createTmuxGateway({ socketName });
    cwd = await mkdtemp(join(tmpdir(), 'issue-flow-tty-'));
    dirs.push(cwd);
  });

  afterEach(async () => {
    if (tmuxAvailable) await killTestServer();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  afterAll(async () => {
    if (tmuxAvailable) await killTestServer();
  });

  async function capturePane(target: string): Promise<string> {
    const result = await execa('tmux', ['-L', socketName, 'capture-pane', '-p', '-t', target], {
      reject: false,
    });
    return result.stdout;
  }

  it.runIf(tmuxAvailable)('delivers the whole text and leaves no buffer behind', async () => {
    await tmux.ensureServer();
    await tmux.ensureSession('if-c5', cwd);
    // `cat` echoes whatever is pasted, which makes the delivery observable
    // without needing a real agent.
    await tmux.createWindow({ sessionName: 'if-c5', windowName: 'w', cwd, command: 'cat' });
    const target = 'if-c5:w.0';

    await sendPrompt(tmux, target, 'first line and a quote: it is fine');
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(await capturePane(target)).toContain('first line and a quote: it is fine');
    // The buffer is deleted by the paste itself, so the prompt cannot be
    // produced again by the user's own `prefix ]`.
    const buffers = await execa('tmux', ['-L', socketName, 'list-buffers'], { reject: false });
    expect(buffers.stdout).not.toContain('if-prompt');
  });

  // The reason the buffer exists at all: `send-keys -l` would deliver this
  // character by character, and a TUI reacts halfway through.
  it.runIf(tmuxAvailable)(
    'delivers a prompt far larger than a command line accepts',
    async () => {
      await tmux.ensureServer();
      await tmux.ensureSession('if-c5-large', cwd);
      // The pane writes whatever it receives to a file, so the assertion is on
      // the bytes that actually arrived rather than on what fits on screen —
      // `capture-pane` only shows the visible region.
      await tmux.createWindow({
        sessionName: 'if-c5-large',
        windowName: 'w',
        cwd,
        command: 'cat > out.txt',
      });
      const target = 'if-c5-large:w.0';

      // Newline-separated on purpose. A terminal in canonical mode buffers one
      // line at a time and discards whatever exceeds that buffer, so a single
      // 64 KB line would be measuring the line discipline rather than the
      // delivery. Real prompts have newlines, and a real agent TUI reads in raw
      // mode where the limit does not apply at all.
      const lines = Array.from({ length: 2400 }, (_, index) => `line ${index} ${'x'.repeat(20)}`);
      const large = `${lines.join('\n')}\n`;
      expect(large.length).toBeGreaterThan(64 * 1024);
      await sendPrompt(tmux, target, large, { submit: false });
      // Ctrl-D closes stdin so `cat` flushes and exits.
      await tmux.sendKeys(target, ['C-d']);

      const outPath = join(cwd, 'out.txt');
      const deadline = Date.now() + 5000;
      let size = 0;
      while (Date.now() < deadline) {
        size = await stat(outPath)
          .then((entry) => entry.size)
          .catch(() => 0);
        if (size >= large.length) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(size).toBeGreaterThanOrEqual(large.length);
    },
    15_000,
  );
});
