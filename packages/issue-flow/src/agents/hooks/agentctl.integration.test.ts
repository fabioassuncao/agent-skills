import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import { setSessionPublisher } from '../../core/session-publisher.js';
import { MemoryPublisher } from '../../core/session-state.js';
import { ensureAgentRuntimeArtifacts, writeControlEnv } from './install.js';
import { startAgentHookSession } from './runtime.js';

/**
 * The generated helper, run as a real process.
 *
 * Ported from the two WebMux `agent-runtime.test.ts` cases that spawn
 * `webmux-agentctl`, plus the end-to-end check for phase 2's completion
 * criterion: `awaiting_input` visible during a headless invocation.
 *
 * Integration, not unit: it spawns Node and binds a socket, and the point of
 * the test is precisely that the generated file works when executed rather than
 * that its text contains the right substrings.
 */
describe('issue-flow-agentctl', () => {
  const tempDirs: string[] = [];
  const closers: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    setSessionPublisher(undefined);
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function fixture(): Promise<{ gitDir: string; worktreePath: string }> {
    const gitDir = await mkdtemp(join(tmpdir(), 'issue-flow-agentctl-gitdir-'));
    const worktreePath = await mkdtemp(join(tmpdir(), 'issue-flow-agentctl-worktree-'));
    tempDirs.push(gitDir, worktreePath);
    return { gitDir, worktreePath };
  }

  /** A control endpoint that records what it is sent. */
  async function controlEndpoint(): Promise<{ url: string; received: unknown[] }> {
    const received: unknown[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        res.statusCode = 204;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, received };
  }

  function runHelper(
    path: string,
    args: string[],
    stdin?: string,
  ): Promise<{ exitCode: number; stdout: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [path, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.resume();
      if (stdin !== undefined) child.stdin.write(stdin);
      child.stdin.end();
      child.on('close', (code) => resolve({ exitCode: code ?? 0, stdout }));
    });
  }

  it('exits cleanly and posts nothing when no run is in flight', async () => {
    const artifacts = await ensureAgentRuntimeArtifacts(await fixture());
    // No control.env was written: this is a hook left over from an invocation
    // that already ended, which must cost the harness nothing.
    const result = await runHelper(artifacts.agentCtlPath, [
      'status-changed',
      '--lifecycle',
      'idle',
    ]);
    expect(result.exitCode).toBe(0);
  });

  it('lets a Codex stop continue naturally when the control endpoint is unreachable', async () => {
    const artifacts = await ensureAgentRuntimeArtifacts(await fixture());
    await writeControlEnv(artifacts, {
      // Port 1 is never listening; the helper must give up, not hang.
      controlUrl: 'http://127.0.0.1:1/',
      token: 'test-token',
      runId: 'run-1',
      phase: 'execute',
    });

    const result = await runHelper(artifacts.agentCtlPath, ['codex-stop']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({});
  });

  it('detects a Bash PR creation payload and reports the URL', async () => {
    const artifacts = await ensureAgentRuntimeArtifacts(await fixture());
    const endpoint = await controlEndpoint();
    await writeControlEnv(artifacts, {
      controlUrl: endpoint.url,
      token: 'test-token',
      runId: 'run-1',
      phase: 'pr',
    });

    const result = await runHelper(
      artifacts.agentCtlPath,
      ['codex-post-tool-use'],
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'gh pr create --fill' },
        tool_response: {
          stdout: 'Created pull request: https://github.com/acme/repo/pull/123',
        },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(endpoint.received).toHaveLength(1);
    expect(endpoint.received[0]).toMatchObject({
      type: 'pr_opened',
      runId: 'run-1',
      phase: 'pr',
      url: 'https://github.com/acme/repo/pull/123',
    });
  });

  it('stays quiet for a Bash tool call that did not create a pull request', async () => {
    const artifacts = await ensureAgentRuntimeArtifacts(await fixture());
    const endpoint = await controlEndpoint();
    await writeControlEnv(artifacts, {
      controlUrl: endpoint.url,
      token: 'test-token',
      runId: 'run-1',
      phase: 'execute',
    });

    await runHelper(
      artifacts.agentCtlPath,
      ['claude-post-tool-use'],
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' } }),
    );
    expect(endpoint.received).toEqual([]);
  });

  // Phase 2's completion criterion, end to end and without a monitor, a
  // worktree or tmux: a hook fires in a plain repository and the run's snapshot
  // says the agent is waiting for a human.
  it('makes awaiting_input visible during a headless invocation', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'issue-flow-agentctl-repo-'));
    tempDirs.push(repository);
    await execa('git', ['init', '--quiet'], { cwd: repository });

    const publisher = new MemoryPublisher({ onWarn: () => {} });
    publisher.publish({
      type: 'session:start',
      at: new Date().toISOString(),
      sessionId: 'run-headless',
      issueNumber: 42,
      phases: ['execute'],
    });
    setSessionPublisher(publisher);

    const session = await startAgentHookSession({
      phase: 'execute',
      runId: 'run-headless',
      workingDirectory: repository,
    });
    if (session === null) throw new Error('hook session did not start');
    closers.push(() => session.close());

    const helper = join(repository, '.git', 'issue-flow', 'issue-flow-agentctl.mjs');
    const result = await runHelper(helper, ['status-changed', '--lifecycle', 'idle']);

    expect(result.exitCode).toBe(0);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && publisher.snapshot().agent.lifecycle === null) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(publisher.snapshot().agent).toMatchObject({
      lifecycle: 'awaiting-input',
      phase: 'execute',
      awaitingInputCount: 1,
    });
    expect(session.accepted()).toBe(1);

    // And closing the session puts the repository back the way it was found.
    await session.close();
    const afterClose = await runHelper(helper, ['status-changed', '--lifecycle', 'running']);
    expect(afterClose.exitCode).toBe(0);
    expect(publisher.snapshot().agent.lifecycle).toBe('awaiting-input');
  });
});
