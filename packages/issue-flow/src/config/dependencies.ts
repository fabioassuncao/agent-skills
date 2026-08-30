import { platform } from 'node:os';
import { installHint } from '../agents/availability.js';
import { runnerFor } from '../agents/registry.js';
import type { AgentProviderId } from '../agents/types.js';
import { AGENT_PHASES } from '../agents/types.js';
import { run } from '../utils/shell.js';
import { loadAgentConfig } from './agent.js';

/**
 * Return a platform-appropriate install hint for a given package.
 */
export function getInstallHint(pkg: string): string {
  const os = platform();

  if (os === 'darwin') {
    return `brew install ${pkg}`;
  }
  if (os === 'linux') {
    return `apt install ${pkg}  (or your distro's package manager)`;
  }
  if (os === 'win32') {
    return `winget install ${pkg}  (or choco install ${pkg})`;
  }

  return `install ${pkg} using your system package manager`;
}

/**
 * Validate that required external dependencies are available.
 * Returns an array of error messages (empty if all deps are found).
 */
export async function validateDependencies(): Promise<string[]> {
  const errors: string[] = [];

  // Check git
  const gitResult = await run('git', ['--version']);
  if (gitResult.exitCode !== 0) {
    errors.push(`  - git  (install with: ${getInstallHint('git')})`);
  }

  // Check the agents this run actually selected — never every binary on the
  // machine. An unconfigured run still only needs `claude`, which is the
  // behaviour every release before the agent layer had.
  const agent = await loadAgentConfig();
  const needed = new Set<AgentProviderId>([agent.provider]);
  for (const phase of AGENT_PHASES) {
    const provider = agent.phases[phase]?.provider;
    if (provider !== undefined) needed.add(provider);
  }
  for (const id of needed) {
    // The binary is the runner's, never a guess. Mapping every non-Codex
    // provider to `claude` made preflight demand the wrong CLI for Cursor and
    // pass without `agy` installed for Antigravity.
    const { command, args } = runnerFor(id).versionCommand();
    const result = await run(command, args);
    if (result.exitCode !== 0) {
      errors.push(`  - ${command}  (${installHint(id)})`);
    }
  }

  // Note: jq is NOT required — the TypeScript CLI handles JSON natively

  return errors;
}
