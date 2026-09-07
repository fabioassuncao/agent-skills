// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the `${...}` forms
// below are the placeholder syntax of a user-written command template, matched
// as data. They are not template literals missing their backticks.

import type { AgentPermission } from './types.js';

/**
 * Agents this project does not know how to invoke, described by the user.
 *
 * Ported from the custom-agent path of WebMux
 * `backend/src/services/agent-service.ts` @ d8c9d5f. §45.2-L keeps Issue Flow's
 * whole agent layer and absorbs **only** this: a command template plus the
 * variables it can reference. It is what lets someone run a harness this project
 * has never heard of without waiting for a runner to be written for it.
 *
 * Context is exposed only through environment variables. Known placeholders
 * become references to those variables after the editable field has been
 * parsed into argv; their values never become part of the argv or pane command.
 * The tmux boundary expands only this closed set of references, inside double
 * quotes, so a hostile value stays one argument and can never become syntax.
 */

/** The placeholders a template may use, and the variable each becomes. */
export const CUSTOM_AGENT_TEMPLATE_VARIABLES = {
  PROMPT: 'ISSUE_FLOW_AGENT_PROMPT',
  SYSTEM_PROMPT: 'ISSUE_FLOW_AGENT_SYSTEM_PROMPT',
  WORKTREE_PATH: 'ISSUE_FLOW_AGENT_WORKTREE_PATH',
  REPO_PATH: 'ISSUE_FLOW_AGENT_REPO_PATH',
  BRANCH: 'ISSUE_FLOW_AGENT_BRANCH',
  PROFILE: 'ISSUE_FLOW_AGENT_PROFILE',
  PERMISSION: 'ISSUE_FLOW_AGENT_PERMISSION',
} as const;

export type CustomAgentPlaceholder = keyof typeof CUSTOM_AGENT_TEMPLATE_VARIABLES;

/** Stable slug grammar shared by config, HTTP paths and the registry. */
export const CUSTOM_AGENT_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export function isCanonicalCustomAgentId(id: string): boolean {
  return id.length <= 64 && CUSTOM_AGENT_ID_PATTERN.test(id);
}

export interface CustomAgentDefinition {
  id: string;
  label: string;
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
  permission: AgentPermission;
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
 * Replace `${PLACEHOLDER}` inside one already-parsed argv element.
 *
 * An unknown placeholder is left untouched: the template belongs to the user
 * and may legitimately reference a variable of their own that this project
 * knows nothing about.
 */
export function renderCustomCommandTemplate(template: string): string {
  let rendered = template;
  for (const [placeholder, variable] of Object.entries(CUSTOM_AGENT_TEMPLATE_VARIABLES)) {
    rendered = rendered.replaceAll(`\${${placeholder}}`, `\${${variable}}`);
  }
  return rendered;
}

/** Environment passed out-of-band to the pane that expands the references. */
export function buildCustomAgentEnvironment(context: CustomAgentContext): Record<string, string> {
  return Object.assign(Object.create(null) as Record<string, string>, {
    [CUSTOM_AGENT_TEMPLATE_VARIABLES.PROMPT]: context.prompt ?? '',
    [CUSTOM_AGENT_TEMPLATE_VARIABLES.SYSTEM_PROMPT]: context.systemPrompt ?? '',
    [CUSTOM_AGENT_TEMPLATE_VARIABLES.WORKTREE_PATH]: context.worktreePath,
    [CUSTOM_AGENT_TEMPLATE_VARIABLES.REPO_PATH]: context.repoRoot,
    [CUSTOM_AGENT_TEMPLATE_VARIABLES.BRANCH]: context.branch,
    [CUSTOM_AGENT_TEMPLATE_VARIABLES.PROFILE]: context.profileName,
    [CUSTOM_AGENT_TEMPLATE_VARIABLES.PERMISSION]: context.permission,
  });
}

export interface BuildCustomAgentCommandInput {
  definition: CustomAgentDefinition;
  /** `resume` uses `resumeCommand`; anything else uses `startCommand`. */
  launchMode?: 'fresh' | 'resume';
}

/**
 * Split the editable command field into argv without invoking a shell.
 *
 * Quotes and backslashes group data exactly as a command field needs. Shell
 * operators have no special meaning: `&&`, `$(...)`, redirects and semicolons
 * become ordinary arguments, so the field can never smuggle a second process
 * into the pane command.
 */
export function parseCustomAgentCommand(command: string): string[] {
  const argv: string[] = [];
  let value = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;

  const push = (): void => {
    if (!started) return;
    argv.push(value);
    value = '';
    started = false;
  };

  for (const character of command) {
    if (escaped) {
      value += character;
      started = true;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else value += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/.test(character)) {
      push();
      continue;
    }
    value += character;
    started = true;
  }

  if (escaped) throw new Error('Custom agent command ends with an incomplete escape.');
  if (quote !== null) throw new Error('Custom agent command has an unclosed quote.');
  push();
  if (argv.length === 0) throw new Error('Custom agent command cannot be empty.');
  return argv;
}

/**
 * The argv a custom agent's pane runs. It contains environment references,
 * never their potentially sensitive values; serialization happens in tty.ts.
 */
export function buildCustomAgentArgv(input: BuildCustomAgentCommandInput): string[] {
  const useResume = input.launchMode === 'resume' && input.definition.resumeCommand !== undefined;
  const template = useResume
    ? (input.definition.resumeCommand as string)
    : input.definition.startCommand;
  return parseCustomAgentCommand(template).map(renderCustomCommandTemplate);
}
