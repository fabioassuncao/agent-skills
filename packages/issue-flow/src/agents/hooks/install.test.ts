import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AgentRuntimeArtifacts,
  clearControlEnv,
  ensureAgentRuntimeArtifacts,
  removeAgentRuntimeArtifacts,
  resolveGitCommonDir,
  writeControlEnv,
} from './install.js';

/**
 * Ported from WebMux `backend/src/__tests__/agent-runtime.test.ts` @ d8c9d5f
 * (the 2 cases that do not spawn a process; the other 2 need a real subprocess
 * and live in `agentctl.integration.test.ts`), plus the cases §23 of the
 * absorption plan adds: merge idempotency and clean removal.
 */
describe('ensureAgentRuntimeArtifacts', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function fixture(): Promise<{ gitDir: string; worktreePath: string }> {
    const gitDir = await mkdtemp(join(tmpdir(), 'issue-flow-hooks-gitdir-'));
    const worktreePath = await mkdtemp(join(tmpdir(), 'issue-flow-hooks-worktree-'));
    tempDirs.push(gitDir, worktreePath);
    return { gitDir, worktreePath };
  }

  async function readJson(path: string): Promise<Record<string, never>> {
    return JSON.parse(await readFile(path, 'utf-8'));
  }

  it('writes the helper and both hook files into paths the repository never commits', async () => {
    const paths = await fixture();
    const artifacts = await ensureAgentRuntimeArtifacts(paths);

    const helper = await readFile(artifacts.agentCtlPath, 'utf-8');
    expect(helper).toContain('claude-user-prompt-submit');
    expect(helper).toContain('codex-user-prompt-submit');
    expect(helper).toContain('agent_status_changed');
    expect(artifacts.agentCtlPath.startsWith(paths.gitDir)).toBe(true);
    // 0o755: the harness executes it directly through the hook command.
    expect((await stat(artifacts.agentCtlPath)).mode & 0o777).toBe(0o755);

    const settings = await readJson(artifacts.claudeSettingsPath);
    const claude = (settings as Record<string, Record<string, unknown[]>>).hooks;
    const command = (event: string, index = 0, hook = 0): string =>
      (claude[event]?.[index] as { hooks: { command: string }[] } | undefined)?.hooks?.[hook]
        ?.command ?? '';
    expect(command('UserPromptSubmit')).toContain('claude-user-prompt-submit');
    expect((claude.Notification?.[0] as { matcher?: string })?.matcher).toBe(
      'permission_prompt|elicitation_dialog',
    );
    expect(command('Notification')).toContain('status-changed --lifecycle idle');
    expect(command('Stop')).toContain('agent-stopped');
    expect(command('PostToolUse', 0)).toContain('status-changed --lifecycle running');
    expect(command('PostToolUse', 1)).toContain('claude-post-tool-use');
    expect((claude.PostToolUse?.[1] as { matcher?: string })?.matcher).toBe('Bash');

    const codexFile = await readJson(artifacts.codexHooksPath);
    const codex = (codexFile as Record<string, Record<string, unknown[]>>).hooks;
    const codexHook = (event: string, index = 0): { command: string; timeout?: number } =>
      (codex[event]?.[index] as { hooks: { command: string; timeout?: number }[] } | undefined)
        ?.hooks?.[0] ?? { command: '' };
    expect((codex.SessionStart?.[0] as { matcher?: string })?.matcher).toBe('startup|resume|clear');
    expect(codexHook('SessionStart').command).toContain('codex-session-start');
    expect(codexHook('UserPromptSubmit').command).toContain('codex-user-prompt-submit');
    expect(codexHook('PermissionRequest').command).toContain('codex-permission-request');
    expect(codexHook('PreToolUse').command).toContain('status-changed --lifecycle running');
    // Without --best-effort a reporting failure on the hot path of every tool
    // call could cost the turn.
    expect(codexHook('PreToolUse').command).toContain('--best-effort');
    expect(codexHook('Stop').command).toContain('codex-stop');
    expect(codex.PostToolUse).toHaveLength(1);
    expect((codex.PostToolUse?.[0] as { matcher?: string })?.matcher).toBe('Bash');
    expect(codexHook('PostToolUse').command).toContain('codex-post-tool-use');
    expect(codexHook('PostToolUse').timeout).toBe(30);

    expect(await readFile(join(paths.gitDir, 'info', 'exclude'), 'utf-8')).toContain(
      '.codex/hooks.json',
    );
  });

  it('preserves Codex hook groups that are not ours, and replaces only stale ones of ours', async () => {
    const paths = await fixture();
    const staleGeneratedCommand = `${join(
      paths.gitDir,
      'issue-flow',
      'issue-flow-agentctl.mjs',
    )} codex-user-prompt-submit`;
    await mkdir(join(paths.worktreePath, '.codex'), { recursive: true });
    await writeFile(
      join(paths.worktreePath, '.codex', 'hooks.json'),
      `${JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: 'command', command: 'echo keep-me' }] },
              // Mentions the helper inside a wrapper: not ours, because the
              // command does not *start* with it.
              {
                hooks: [{ type: 'command', command: "sh -lc 'echo issue-flow-agentctl wrapper'" }],
              },
              { hooks: [{ type: 'command', command: staleGeneratedCommand }] },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    const artifacts = await ensureAgentRuntimeArtifacts(paths);
    await ensureAgentRuntimeArtifacts(paths);

    const file = await readJson(artifacts.codexHooksPath);
    const groups = (file as Record<string, Record<string, unknown[]>>).hooks.UserPromptSubmit as {
      hooks?: { command?: string }[];
    }[];
    const commands = groups.flatMap(
      (group) => group.hooks?.map((hook) => hook.command ?? '') ?? [],
    );

    expect(commands.filter((command) => command.includes('keep-me'))).toHaveLength(1);
    expect(
      commands.filter((command) => command.includes('issue-flow-agentctl wrapper')),
    ).toHaveLength(1);
    expect(commands.filter((command) => command.includes('codex-user-prompt-submit'))).toHaveLength(
      1,
    );
    expect(commands.some((command) => command === staleGeneratedCommand)).toBe(false);
  });

  // The upstream replaces whole event arrays in settings.local.json, which
  // deletes the user's own Claude hooks. §45.2-D names preserving them as the
  // behaviour that must not be lost, so the group-preserving merge is applied
  // to both files here.
  it("preserves the user's own Claude hooks instead of replacing the event", async () => {
    const paths = await fixture();
    await mkdir(join(paths.worktreePath, '.claude'), { recursive: true });
    await writeFile(
      join(paths.worktreePath, '.claude', 'settings.local.json'),
      JSON.stringify({
        permissions: { allow: ['Bash(npm test)'] },
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }],
          SessionEnd: [{ hooks: [{ type: 'command', command: 'echo bye' }] }],
        },
      }),
    );

    const artifacts = await ensureAgentRuntimeArtifacts(paths);
    const file = (await readJson(artifacts.claudeSettingsPath)) as unknown as {
      permissions: { allow: string[] };
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };

    expect(file.permissions.allow).toEqual(['Bash(npm test)']);
    expect(file.hooks.SessionEnd?.[0]?.hooks[0]?.command).toBe('echo bye');
    const submitted = file.hooks.UserPromptSubmit?.map((group) => group.hooks[0]?.command) ?? [];
    expect(submitted[0]).toBe('echo mine');
    expect(submitted[1]).toContain('claude-user-prompt-submit');
  });

  it('is idempotent: installing twice leaves exactly one generated group per event', async () => {
    const paths = await fixture();
    const artifacts = await ensureAgentRuntimeArtifacts(paths);
    const first = await readFile(artifacts.claudeSettingsPath, 'utf-8');
    await ensureAgentRuntimeArtifacts(paths);
    await ensureAgentRuntimeArtifacts(paths);

    expect(await readFile(artifacts.claudeSettingsPath, 'utf-8')).toBe(first);
    // And the exclude line is not appended again.
    const exclude = await readFile(join(paths.gitDir, 'info', 'exclude'), 'utf-8');
    expect(exclude.split('\n').filter((line) => line.trim() === '.codex/hooks.json')).toHaveLength(
      1,
    );
  });

  it('removes only its own hooks, restoring the file the user had', async () => {
    const paths = await fixture();
    await mkdir(join(paths.worktreePath, '.claude'), { recursive: true });
    await writeFile(
      join(paths.worktreePath, '.claude', 'settings.local.json'),
      JSON.stringify({
        hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
      }),
    );

    const artifacts = await ensureAgentRuntimeArtifacts(paths);
    await removeAgentRuntimeArtifacts(artifacts);

    const claude = (await readJson(artifacts.claudeSettingsPath)) as unknown as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    expect(claude.hooks.UserPromptSubmit?.map((group) => group.hooks[0]?.command)).toEqual([
      'echo mine',
    ]);
    // Events that held only our groups disappear entirely rather than being
    // left as empty arrays the harness would still have to read.
    expect(claude.hooks.Notification).toBeUndefined();
    expect(claude.hooks.Stop).toBeUndefined();

    const codex = (await readJson(artifacts.codexHooksPath)) as unknown as {
      hooks: Record<string, unknown>;
    };
    expect(Object.keys(codex.hooks)).toEqual([]);
  });

  it('publishes and retracts the control credentials, restricted to the owner', async () => {
    const paths = await fixture();
    const artifacts = await ensureAgentRuntimeArtifacts(paths);

    await writeControlEnv(artifacts, {
      controlUrl: 'http://127.0.0.1:5999/',
      token: "tok'en",
      runId: 'run-1',
      phase: 'execute',
    });
    const body = await readFile(artifacts.controlEnvPath, 'utf-8');
    expect(body).toContain("ISSUE_FLOW_CONTROL_URL='http://127.0.0.1:5999/'");
    expect(body).toContain("ISSUE_FLOW_RUN_ID='run-1'");
    // A token containing a quote must survive the shell-style quoting.
    expect(body).toContain(String.raw`ISSUE_FLOW_CONTROL_TOKEN='tok'\''en'`);
    expect((await stat(artifacts.controlEnvPath)).mode & 0o777).toBe(0o600);

    await clearControlEnv(artifacts);
    await expect(stat(artifacts.controlEnvPath)).rejects.toThrow();
    // Retracting twice is not an error: close() may run after a crash path.
    await expect(clearControlEnv(artifacts)).resolves.toBeUndefined();
  });

  it('survives a settings file the user left unparseable', async () => {
    const paths = await fixture();
    await mkdir(join(paths.worktreePath, '.claude'), { recursive: true });
    await writeFile(join(paths.worktreePath, '.claude', 'settings.local.json'), '{ not json');

    const artifacts: AgentRuntimeArtifacts = await ensureAgentRuntimeArtifacts(paths);
    const claude = (await readJson(artifacts.claudeSettingsPath)) as unknown as {
      hooks: Record<string, unknown>;
    };
    expect(Object.keys(claude.hooks)).toContain('Notification');
  });
});

describe('resolveGitCommonDir', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('returns the git dir itself when there is no commondir file', async () => {
    const gitDir = await mkdtemp(join(tmpdir(), 'issue-flow-commondir-'));
    tempDirs.push(gitDir);
    expect(await resolveGitCommonDir(gitDir)).toBe(gitDir);
  });

  // Inside a linked worktree the git dir is `…/.git/worktrees/<name>` and
  // info/exclude lives in the common one. Without this, the exclude is written
  // where git never reads it and the generated Codex hooks show up as an
  // untracked file in the user's repository.
  it('follows a relative commondir out of a worktree git dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'issue-flow-commondir-'));
    tempDirs.push(root);
    const common = join(root, '.git');
    const worktreeGitDir = join(common, 'worktrees', 'feature');
    await mkdir(worktreeGitDir, { recursive: true });
    await writeFile(join(worktreeGitDir, 'commondir'), '../..\n');

    expect(await resolveGitCommonDir(worktreeGitDir)).toBe(common);
  });

  it('honours an absolute commondir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'issue-flow-commondir-'));
    tempDirs.push(root);
    const worktreeGitDir = join(root, 'wt');
    await mkdir(worktreeGitDir, { recursive: true });
    await writeFile(join(worktreeGitDir, 'commondir'), `${root}/main.git\n`);

    expect(await resolveGitCommonDir(worktreeGitDir)).toBe(`${root}/main.git`);
  });
});
