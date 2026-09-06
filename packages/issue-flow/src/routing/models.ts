import type { AgentCapabilities } from '../agents/types.js';

export const MODEL_CATALOG_VERSION = '3';

export type ModelTier = 'fast' | 'mid' | 'strong';

export interface ModelEntry {
  id: string | null;
  tier: ModelTier;
  relativeCost: number;
  relativeLatency: number;
}

/**
 * Deliberately hand-maintained. Harnesses do not expose a stable price/tier API,
 * so relative values are more durable than USD prices and keep the router pure.
 */
export const MODEL_CATALOG: Record<string, readonly ModelEntry[]> = {
  'claude-code': [
    { id: 'haiku', tier: 'fast', relativeCost: 1, relativeLatency: 1 },
    { id: 'sonnet', tier: 'mid', relativeCost: 3.5, relativeLatency: 1.5 },
    { id: 'opus', tier: 'strong', relativeCost: 8, relativeLatency: 2.2 },
  ],
  'codex-cli': [
    { id: 'gpt-5.6-luna', tier: 'fast', relativeCost: 1, relativeLatency: 1 },
    { id: 'gpt-5.6-terra', tier: 'mid', relativeCost: 3, relativeLatency: 1.45 },
    { id: 'gpt-5.6-sol', tier: 'strong', relativeCost: 7, relativeLatency: 2.1 },
  ],
  'cursor-cli': [
    { id: 'auto-fast', tier: 'fast', relativeCost: 1, relativeLatency: 1 },
    { id: 'auto', tier: 'mid', relativeCost: 3, relativeLatency: 1.5 },
    { id: 'auto-strong', tier: 'strong', relativeCost: 7, relativeLatency: 2.1 },
  ],
  'antigravity-cli': [
    { id: 'gemini-3.5-flash-low', tier: 'fast', relativeCost: 1, relativeLatency: 1 },
    { id: 'gemini-3.5-flash-medium', tier: 'mid', relativeCost: 2.5, relativeLatency: 1.4 },
    { id: 'gemini-3.5-pro-high', tier: 'strong', relativeCost: 6, relativeLatency: 2 },
  ],
  // OpenCode Go: relative cost tracks 5h quota intensity, kept in the 1–8
  // band so preferredTier still wins over raw request-count ratios.
  'opencode-cli': [
    { id: 'opencode-go/mimo-v2.5', tier: 'fast', relativeCost: 1, relativeLatency: 1 },
    { id: 'opencode-go/qwen3.8-flash', tier: 'mid', relativeCost: 2.5, relativeLatency: 1.3 },
    { id: 'opencode-go/gpt-5.6-luna', tier: 'strong', relativeCost: 5, relativeLatency: 1.8 },
  ],
};

const DEFAULT_ONLY: readonly ModelEntry[] = [
  { id: null, tier: 'mid', relativeCost: 1, relativeLatency: 1 },
];

export function modelsFor(harness: string, capabilities: AgentCapabilities): readonly ModelEntry[] {
  if (!capabilities.modelSelection) return DEFAULT_ONLY;
  return MODEL_CATALOG[harness] ?? DEFAULT_ONLY;
}

export function modelForTier(harness: string, tier: ModelTier): ModelEntry | null {
  return MODEL_CATALOG[harness]?.find((entry) => entry.tier === tier) ?? null;
}
