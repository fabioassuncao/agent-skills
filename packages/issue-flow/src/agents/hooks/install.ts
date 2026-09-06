import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { writeFileAtomic } from '../../utils/fs.js';
import { AGENTCTL_FILENAME, buildAgentCtlScript, shellQuote } from './agentctl.js';

/**
 * Install (and remove) the hooks through which an agent reports its own
 * lifecycle.
 *
 * Ported from WebMux `backend/src/adapters/agent-runtime.ts` @ d8c9d5f. The two
 * details this port exists to preserve, both named in §45.2-D of the absorption
 * plan as "must not lose":
 *
 * - **The merge keeps hook groups that are not ours.** A naive install
 *   overwrites the user's own `settings.local.json`, which is their
 *   configuration, not ours.
 * - **`resolveGitCommonDir()`.** Inside a worktree, `<gitDir>` is the
 *   worktree's own directory and `info/exclude` lives in the *common* one. A
 *   port that skips this writes the exclude where git will never read it.
 *
 * Everything here is idempotent: installing twice leaves exactly one generated
 * group per event.
 */

/** Path written to `info/exclude` so the generated Codex hooks never enter the repo. */
const GENERATED_CODEX_HOOKS_EXCLUDE = '.codex/hooks.json';

/** Directory, inside the git dir, holding every generated runtime artifact. */
export const RUNTIME_ARTIFACTS_DIRNAME = 'issue-flow';

interface CommandHookConfig {
  type: 'command';
  command: string;
  async?: boolean;
  timeout?: number;
}

interface HookMatcherConfig {
  matcher?: string;
  hooks: CommandHookConfig[];
}

interface HookConfigFile {
  hooks: Record<string, HookMatcherConfig[]>;
}

export interface AgentRuntimeArtifacts {
  agentCtlPath: string;
  claudeSettingsPath: string;
  codexHooksPath: string;
  /** Credentials of the run in flight. Absent means "no run"; the helper then no-ops. */
  controlEnvPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildClaudeHookSettings(input: AgentRuntimeArtifacts): HookConfigFile {
  const agentCtl = shellQuote(input.agentCtlPath);
  return {
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            { type: 'command', command: `${agentCtl} claude-user-prompt-submit`, async: true },
          ],
        },
      ],
      // The one hook that answers "is the agent waiting for me?". Both matchers
      // are needed: a permission prompt and an elicitation dialog are different
      // events in Claude Code and only the pair covers being blocked on a human.
      Notification: [
        {
          matcher: 'permission_prompt|elicitation_dialog',
          hooks: [
            {
              type: 'command',
              command: `${agentCtl} status-changed --lifecycle idle`,
              async: true,
            },
          ],
        },
      ],
      Stop: [{ hooks: [{ type: 'command', command: `${agentCtl} agent-stopped`, async: true }] }],
      PostToolUse: [
        {
          hooks: [
            {
              type: 'command',
              command: `${agentCtl} status-changed --lifecycle running`,
              async: true,
            },
          ],
        },
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `${agentCtl} claude-post-tool-use`, async: true }],
        },
      ],
    },
  };
}

function buildCodexHookSettings(input: AgentRuntimeArtifacts): HookConfigFile {
  const agentCtl = shellQuote(input.agentCtlPath);
  // `--best-effort` on PreToolUse: this hook fires on the hot path of every
  // tool call, and a reporting failure there may not cost the turn.
  const statusCommand = `${agentCtl} status-changed --lifecycle running --best-effort`;
  return {
    hooks: {
      SessionStart: [
        {
          matcher: 'startup|resume|clear',
          hooks: [{ type: 'command', command: `${agentCtl} codex-session-start`, timeout: 30 }],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            { type: 'command', command: `${agentCtl} codex-user-prompt-submit`, timeout: 30 },
          ],
        },
      ],
      PermissionRequest: [
        {
          hooks: [
            { type: 'command', command: `${agentCtl} codex-permission-request`, timeout: 30 },
          ],
        },
      ],
      PreToolUse: [{ hooks: [{ type: 'command', command: statusCommand, timeout: 30 }] }],
      PostToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `${agentCtl} codex-post-tool-use`, timeout: 30 }],
        },
      ],
      Stop: [{ hooks: [{ type: 'command', command: `${agentCtl} codex-stop`, timeout: 30 }] }],
    },
  };
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'));
    return isRecord(parsed) ? parsed : {};
  } catch {
    // Missing, unreadable or malformed. Treated the same on purpose: this file
    // belongs to the user's harness, and refusing to run because it cannot be
    // parsed would make a broken settings file break the pipeline.
    return {};
  }
}

function commandStartsWithAgentCtl(command: string, agentCtlPath: string): boolean {
  const trimmed = command.trimStart();
  const quoted = shellQuote(agentCtlPath);
  return (
    trimmed === agentCtlPath ||
    trimmed.startsWith(`${agentCtlPath} `) ||
    trimmed === quoted ||
    trimmed.startsWith(`${quoted} `)
  );
}

/**
 * Whether a hook group is one we generated.
 *
 * Identity is the *command prefix*, not a marker key: the file is the user's
 * and a marker we add can be stripped by any editor, while a group whose
 * command is our helper is unambiguously ours. A group that merely mentions the
 * helper somewhere inside a wrapper command is not ours — hence
 * `commandStartsWithAgentCtl` rather than a substring match.
 */
function isGeneratedHookGroup(group: unknown, agentCtlPath: string): boolean {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return false;
  return group.hooks.some(
    (hook) =>
      isRecord(hook) &&
      typeof hook.command === 'string' &&
      commandStartsWithAgentCtl(hook.command, agentCtlPath),
  );
}

/**
 * Merge generated groups into a hook file, keeping every group that is not
 * ours.
 *
 * The upstream applies this to `.codex/hooks.json` only and replaces whole
 * event arrays in `settings.local.json`. Applying it to both is a deliberate
 * divergence: §45.2-D names "the merge that preserves foreign groups in the
 * user's `settings.local.json`" as the behaviour that must not be lost, and
 * replacing an event array there deletes the user's own hooks.
 */
function mergeHooks(
  existing: Record<string, unknown>,
  generated: HookConfigFile['hooks'],
  agentCtlPath: string,
): Record<string, unknown> {
  const existingHooks = isRecord(existing.hooks) ? existing.hooks : {};
  const mergedHooks: Record<string, unknown> = { ...existingHooks };
  for (const [eventName, groups] of Object.entries(generated)) {
    const eventGroups = existingHooks[eventName];
    const preserved = Array.isArray(eventGroups)
      ? eventGroups.filter((group) => !isGeneratedHookGroup(group, agentCtlPath))
      : [];
    mergedHooks[eventName] = [...preserved, ...groups];
  }
  return { ...existing, hooks: mergedHooks };
}

/** Drop our groups, and any event key left with none, restoring the user's file. */
function stripHooks(
  existing: Record<string, unknown>,
  agentCtlPath: string,
): Record<string, unknown> {
  const existingHooks = isRecord(existing.hooks) ? existing.hooks : {};
  const remaining: Record<string, unknown> = {};
  for (const [eventName, groups] of Object.entries(existingHooks)) {
    if (!Array.isArray(groups)) {
      remaining[eventName] = groups;
      continue;
    }
    const preserved = groups.filter((group) => !isGeneratedHookGroup(group, agentCtlPath));
    if (preserved.length > 0) remaining[eventName] = preserved;
  }
  return { ...existing, hooks: remaining };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Resolve the *common* git directory.
 *
 * Inside a linked worktree, `<gitDir>` is `…/.git/worktrees/<name>` and holds a
 * `commondir` file pointing at the real one. `info/exclude` lives only in the
 * common directory, so a port that ignores this writes the exclude somewhere
 * git never reads.
 */
export async function resolveGitCommonDir(gitDir: string): Promise<string> {
  try {
    const commonDir = (await readFile(join(gitDir, 'commondir'), 'utf-8')).trim();
    if (commonDir === '') return gitDir;
    return commonDir.startsWith('/') ? commonDir : resolve(gitDir, commonDir);
  } catch {
    return gitDir;
  }
}

async function ensureGeneratedCodexHooksIgnored(gitDir: string): Promise<void> {
  const commonDir = await resolveGitCommonDir(gitDir);
  const excludePath = join(commonDir, 'info', 'exclude');
  let existing = '';
  try {
    existing = await readFile(excludePath, 'utf-8');
  } catch {
    existing = '';
  }

  const lines = existing.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(GENERATED_CODEX_HOOKS_EXCLUDE)) return;

  await mkdir(dirname(excludePath), { recursive: true });
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await writeFileAtomic(excludePath, `${existing}${separator}${GENERATED_CODEX_HOOKS_EXCLUDE}\n`);
}

/** Where every generated artifact lives, given a git directory and a worktree. */
export function agentRuntimeArtifactPaths(input: {
  gitDir: string;
  worktreePath: string;
}): AgentRuntimeArtifacts {
  const runtimeDir = join(input.gitDir, RUNTIME_ARTIFACTS_DIRNAME);
  return {
    agentCtlPath: join(runtimeDir, AGENTCTL_FILENAME),
    claudeSettingsPath: join(input.worktreePath, '.claude', 'settings.local.json'),
    codexHooksPath: join(input.worktreePath, '.codex', 'hooks.json'),
    controlEnvPath: join(runtimeDir, 'control.env'),
  };
}

/**
 * Write the helper and install the hooks for both harnesses.
 *
 * Artifacts live under the **git directory**, never in the working tree: they
 * are execution state, and execution state is never committed.
 */
export async function ensureAgentRuntimeArtifacts(input: {
  gitDir: string;
  worktreePath: string;
}): Promise<AgentRuntimeArtifacts> {
  const artifacts = agentRuntimeArtifactPaths(input);

  await mkdir(dirname(artifacts.agentCtlPath), { recursive: true });
  await mkdir(dirname(artifacts.claudeSettingsPath), { recursive: true });
  await mkdir(dirname(artifacts.codexHooksPath), { recursive: true });

  await writeFileAtomic(artifacts.agentCtlPath, buildAgentCtlScript());
  await chmod(artifacts.agentCtlPath, 0o755);

  await writeJson(
    artifacts.claudeSettingsPath,
    mergeHooks(
      await readJsonObject(artifacts.claudeSettingsPath),
      buildClaudeHookSettings(artifacts).hooks,
      artifacts.agentCtlPath,
    ),
  );
  await ensureGeneratedCodexHooksIgnored(input.gitDir);
  await writeJson(
    artifacts.codexHooksPath,
    mergeHooks(
      await readJsonObject(artifacts.codexHooksPath),
      buildCodexHookSettings(artifacts).hooks,
      artifacts.agentCtlPath,
    ),
  );

  return artifacts;
}

/**
 * Remove the generated hooks, leaving the user's own untouched.
 *
 * The helper and the exclude line stay: the first is inert without
 * `control.env`, and removing the second would make a leftover
 * `.codex/hooks.json` suddenly visible to `git status`.
 */
export async function removeAgentRuntimeArtifacts(artifacts: AgentRuntimeArtifacts): Promise<void> {
  for (const path of [artifacts.claudeSettingsPath, artifacts.codexHooksPath]) {
    const existing = await readJsonObject(path);
    if (!isRecord(existing.hooks)) continue;
    await writeJson(path, stripHooks(existing, artifacts.agentCtlPath));
  }
  await clearControlEnv(artifacts);
}

/** Escape a value for the shell-style `key='value'` format the helper parses. */
function envQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Publish the credentials of the run in flight.
 *
 * Written `0600`: it carries the bearer token of a loopback endpoint that
 * accepts writes about a live run.
 */
export async function writeControlEnv(
  artifacts: AgentRuntimeArtifacts,
  input: { controlUrl: string; token: string; runId: string; phase: string },
): Promise<void> {
  const body = [
    `ISSUE_FLOW_CONTROL_URL=${envQuote(input.controlUrl)}`,
    `ISSUE_FLOW_CONTROL_TOKEN=${envQuote(input.token)}`,
    `ISSUE_FLOW_RUN_ID=${envQuote(input.runId)}`,
    `ISSUE_FLOW_PHASE=${envQuote(input.phase)}`,
    '',
  ].join('\n');
  await mkdir(dirname(artifacts.controlEnvPath), { recursive: true });
  await writeFileAtomic(artifacts.controlEnvPath, body);
  await chmod(artifacts.controlEnvPath, 0o600);
}

/**
 * Retract those credentials.
 *
 * This is what makes a leftover hook harmless: with no `control.env` the helper
 * exits immediately instead of waiting two seconds for an endpoint that is gone.
 */
export async function clearControlEnv(artifacts: AgentRuntimeArtifacts): Promise<void> {
  await rm(artifacts.controlEnvPath, { force: true });
}
