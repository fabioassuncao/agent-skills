// biome-ignore-all lint/suspicious/noTemplateCurlyInString: placeholders are user data.
import type { CustomAgentsConfig } from '../config/custom-agents.js';
import {
  type CustomAgentDefinition,
  customAgentCapabilities,
  isCanonicalCustomAgentId,
  parseCustomAgentCommand,
} from './custom.js';
import { AGENT_PROVIDER_IDS, type AgentProviderId, isAgentProviderId } from './types.js';

export interface AgentCapabilities {
  terminal: true;
  inAppChat: boolean;
  conversationHistory: boolean;
  interrupt: boolean;
  resume: boolean;
}

export type RegisteredAgent =
  | { id: AgentProviderId; label: string; kind: 'builtin' }
  | ({ kind: 'custom' } & CustomAgentDefinition);

export interface AgentSummary {
  id: string;
  label: string;
  kind: 'builtin' | 'custom';
  capabilities: AgentCapabilities;
}

export interface AgentDetails extends AgentSummary {
  startCommand: string | null;
  resumeCommand: string | null;
}

const LABELS: Record<AgentProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
};

const BUILTINS: readonly RegisteredAgent[] = AGENT_PROVIDER_IDS.map((id) => ({
  id,
  label: LABELS[id],
  kind: 'builtin',
}));

export function normalizeCustomAgentId(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const prefixed = slug === '' ? 'agent' : /^[a-z]/.test(slug) ? slug : `agent-${slug}`;
  return prefixed.slice(0, 64).replace(/-+$/g, '') || 'agent';
}

export function isBuiltInAgentId(id: string): boolean {
  return isAgentProviderId(id);
}

export function listRegisteredAgents(custom: CustomAgentsConfig): RegisteredAgent[] {
  const customAgents = Object.entries(custom)
    .filter(([id]) => isCanonicalCustomAgentId(id) && !isBuiltInAgentId(id))
    .sort(([leftId, left], [rightId, right]) => {
      const label = left.label.localeCompare(right.label);
      return label === 0 ? leftId.localeCompare(rightId) : label;
    })
    .map(([id, value]) => ({ ...value, id, kind: 'custom' as const }));
  return [...BUILTINS.map((agent) => ({ ...agent })), ...customAgents];
}

export function findRegisteredAgent(
  custom: CustomAgentsConfig,
  id: string,
): RegisteredAgent | null {
  if (isBuiltInAgentId(id)) return BUILTINS.find((agent) => agent.id === id) ?? null;
  if (!isCanonicalCustomAgentId(id) || !Object.hasOwn(custom, id)) return null;
  const definition = custom[id];
  return definition === undefined ? null : { ...definition, id, kind: 'custom' };
}

function capabilities(agent: RegisteredAgent): AgentCapabilities {
  if (agent.kind === 'custom') {
    const custom = customAgentCapabilities(agent);
    return {
      terminal: custom.terminal,
      inAppChat: custom.structuredChat,
      conversationHistory: custom.conversationHistory,
      interrupt: custom.interrupt,
      resume: custom.resume,
    };
  }
  const inAppChat = agent.id === 'claude' || agent.id === 'codex';
  return {
    terminal: true,
    inAppChat,
    conversationHistory: inAppChat,
    interrupt: true,
    resume: true,
  };
}

export function listAgentSummaries(custom: CustomAgentsConfig): AgentSummary[] {
  return listRegisteredAgents(custom).map((agent) => ({
    id: agent.id,
    label: agent.label,
    kind: agent.kind,
    capabilities: capabilities(agent),
  }));
}

export function listAgentDetails(custom: CustomAgentsConfig): AgentDetails[] {
  return listRegisteredAgents(custom).map((agent) => ({
    id: agent.id,
    label: agent.label,
    kind: agent.kind,
    capabilities: capabilities(agent),
    startCommand: agent.kind === 'custom' ? agent.startCommand : null,
    resumeCommand: agent.kind === 'custom' ? (agent.resumeCommand ?? null) : null,
  }));
}

export function validateCustomAgentInput(input: {
  label: string;
  startCommand: string;
  resumeCommand?: string;
}): { normalizedId: string; warnings: string[] } {
  parseCustomAgentCommand(input.startCommand);
  if (input.resumeCommand?.trim()) parseCustomAgentCommand(input.resumeCommand);
  const warnings: string[] = [];
  if (
    !input.startCommand.includes('${PROMPT}') &&
    !input.startCommand.includes('${SYSTEM_PROMPT}')
  ) {
    warnings.push(
      'Start command does not reference ${PROMPT} or ${SYSTEM_PROMPT}; initial prompts will not be passed automatically',
    );
  }
  if (!input.resumeCommand?.trim()) {
    warnings.push(
      'Resume command is not configured; reopening the worktree will restart the agent',
    );
  }
  return { normalizedId: normalizeCustomAgentId(input.label), warnings };
}
