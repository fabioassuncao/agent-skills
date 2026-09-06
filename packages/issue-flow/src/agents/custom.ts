// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the `${...}` forms
// below are the placeholder syntax of a user-written command template, matched
// as data. They are not template literals missing their backticks.

import { quoteShellArgument } from './tty.js';

/**
 * Agents this project does not know how to invoke, described by the user.
 *
 * Ported from the custom-agent path of WebMux
 * `backend/src/services/agent-service.ts` @ d8c9d5f. §45.2-L keeps Issue Flow's
 * whole agent layer and absorbs **only** this: a command template plus the
 * variables it can reference. It is what lets someone run a harness this project
 * has never heard of without waiting for a runner to be written for it.
 *
 * The values reach the template through **exported environment variables**, not
 * through string substitution into the command. That is the difference that
 * matters: a prompt containing `'` , `$(…)` or a newline is a value the shell
 * expands as data, never a fragment of the command line. Substituting the text
 * itself would be the shell-string assembly ADR-04 exists to prevent.
 */

/** The placeholders a template may use, and the variable each becomes. */
export const CUSTOM_AGENT_TEMPLATE_VARIABLES = {
  PROMPT: 'ISSUE_FLOW_AGENT_PROMPT',
  SYSTEM_PROMPT: 'ISSUE_FLOW_AGENT_SYSTEM_PROMPT',
  WORKTREE_PATH: 'ISSUE_FLOW_AGENT_WORKTREE_PATH',
  REPO_PATH: 'ISSUE_FLOW_AGENT_REPO_PATH',
  BRANCH: 'ISSUE_FLOW_AGENT_BRANCH',
  PROFILE: 'ISSUE_FLOW_AGENT_PROFILE',
} as const;

export type CustomAgentPlaceholder = keyof typeof CUSTOM_AGENT_TEMPLATE_VARIABLES;

export interface CustomAgentDefinition {
  id: string;
  /** Command run for a fresh start. `${PROMPT}` and friends are substituted. */
  startCommand: string;
  /** Command run to resume. Absent means the agent cannot resume. */
  resumeCommand?: string;
}

export interface CustomAgentContext {
  prompt?: string;
  systemPrompt?: string;
  worktreePath: string;
  repoRoot: string;
  branch: string;
  profileName: string;
}

/**
 * What a custom agent can do.
 *
 * Restricted on purpose, and matching the upstream's: this project knows
 * nothing about the binary beyond the command line it was given, so it cannot
 * claim to read its conversation history or interrupt it meaningfully. `resume`
 * is true only when a resume command was actually provided.
 */
export interface CustomAgentCapabilities {
  terminal: true;
  structuredChat: false;
  conversationHistory: false;
  interrupt: false;
  resume: boolean;
}

export function customAgentCapabilities(
  definition: CustomAgentDefinition,
): CustomAgentCapabilities {
  return {
    terminal: true,
    structuredChat: false,
    conversationHistory: false,
    interrupt: false,
    resume: definition.resumeCommand !== undefined,
  };
}

/**
 * Replace `${PLACEHOLDER}` with a *variable reference*, not with the value.
 *
 * An unknown placeholder is left untouched: the template belongs to the user
 * and may legitimately reference a variable of their own that this project
 * knows nothing about.
 */
export function renderCustomCommandTemplate(template: string): string {
  let rendered = template;
  for (const [placeholder, variable] of Object.entries(CUSTOM_AGENT_TEMPLATE_VARIABLES)) {
    rendered = rendered.replaceAll(`\${${placeholder}}`, `$${variable}`);
  }
  return rendered;
}

/** The `export` prefix that puts the context into the template's environment. */
export function buildCustomAgentExports(context: CustomAgentContext): string {
  const entries: Array<[string, string]> = [
    [CUSTOM_AGENT_TEMPLATE_VARIABLES.PROMPT, context.prompt ?? ''],
    [CUSTOM_AGENT_TEMPLATE_VARIABLES.SYSTEM_PROMPT, context.systemPrompt ?? ''],
    [CUSTOM_AGENT_TEMPLATE_VARIABLES.WORKTREE_PATH, context.worktreePath],
    [CUSTOM_AGENT_TEMPLATE_VARIABLES.REPO_PATH, context.repoRoot],
    [CUSTOM_AGENT_TEMPLATE_VARIABLES.BRANCH, context.branch],
    [CUSTOM_AGENT_TEMPLATE_VARIABLES.PROFILE, context.profileName],
  ];
  return entries.map(([key, value]) => `export ${key}=${quoteShellArgument(value)}`).join('; ');
}

export interface BuildCustomAgentCommandInput {
  definition: CustomAgentDefinition;
  context: CustomAgentContext;
  /** `resume` uses `resumeCommand`; anything else uses `startCommand`. */
  launchMode?: 'fresh' | 'resume';
}

/** The shell command a custom agent's pane runs. */
export function buildCustomAgentCommand(input: BuildCustomAgentCommandInput): string {
  const useResume = input.launchMode === 'resume' && input.definition.resumeCommand !== undefined;
  const template = useResume
    ? (input.definition.resumeCommand as string)
    : input.definition.startCommand;
  return `${buildCustomAgentExports(input.context)}; ${renderCustomCommandTemplate(template)}`;
}
