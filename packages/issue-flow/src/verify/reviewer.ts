import { probeAgent } from '../agents/availability.js';
import { getRegisteredProviders } from '../agents/registry.js';
import type { AgentProviderId } from '../agents/types.js';
import { DEFAULT_HEADLESS_TIMEOUT_MS, runHeadless } from '../core/headless.js';
import type { Independence, ReviewerSelection, VerdictStatus } from './types.js';

const VENDOR: Record<string, string> = {
  claude: 'anthropic',
  codex: 'openai',
  cursor: 'cursor',
  antigravity: 'google',
};

export interface ReviewFinding {
  file?: string;
  line?: number;
  severity: 'error' | 'warning' | 'info';
  category: string;
  claim: string;
}

export interface StructuredReview {
  status: VerdictStatus;
  findings: ReviewFinding[];
  independence: Independence;
  provider: string | null;
  degraded: boolean;
}

/**
 * Preference: configured pairing, then different harness and vendor, then
 * different harness, then different vendor. Never the producer. Always
 * conceptually read-only.
 */
export function selectReviewer(
  producer: AgentProviderId,
  available: readonly AgentProviderId[],
  pairings: Record<string, string> = {},
): ReviewerSelection {
  const others = available.filter((id) => id !== producer);
  const paired = pairings[producer];
  if (paired !== undefined && others.includes(paired as AgentProviderId)) {
    const independence = independenceOf(producer, paired as AgentProviderId);
    return {
      provider: paired,
      independence,
      degraded: independence !== 'harness-and-vendor',
      reason: `configured pairing ${producer} → ${paired}`,
    };
  }

  if (others.length === 0) {
    return {
      provider: producer,
      independence: 'none',
      degraded: true,
      reason: 'only one harness is available; L2 cannot claim independence',
    };
  }

  const producerVendor = VENDOR[producer] ?? producer;
  const both = others.find((id) => (VENDOR[id] ?? id) !== producerVendor);
  if (both !== undefined) {
    return {
      provider: both,
      independence: 'harness-and-vendor',
      degraded: false,
      reason: `${both} differs in harness and vendor from ${producer}`,
    };
  }

  return {
    provider: others[0] ?? null,
    independence: 'harness-only',
    degraded: true,
    reason: `no different vendor installed; using ${others[0]} (same vendor family)`,
  };
}

function independenceOf(producer: AgentProviderId, reviewer: AgentProviderId): Independence {
  if (producer === reviewer) return 'none';
  const sameVendor = (VENDOR[producer] ?? producer) === (VENDOR[reviewer] ?? reviewer);
  return sameVendor ? 'harness-only' : 'harness-and-vendor';
}

export function reviewerPermission(): 'read-only' {
  return 'read-only';
}

export function independenceLabel(value: Independence): string {
  switch (value) {
    case 'harness-and-vendor':
      return 'independent (harness and vendor)';
    case 'harness-only':
      return 'degraded: harness only';
    case 'vendor-only':
      return 'degraded: vendor only';
    case 'none':
      return 'degraded: no independent reviewer';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const SEVERITIES = new Set(['error', 'warning', 'info']);

/** Invalid structure is unverified — never green by omission. */
export function parseStructuredReview(text: string): {
  status: VerdictStatus;
  findings: ReviewFinding[];
} {
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return { status: 'unverified', findings: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return { status: 'unverified', findings: [] };
  }
  if (!isRecord(parsed)) return { status: 'unverified', findings: [] };
  const rawFindings = parsed.findings;
  if (!Array.isArray(rawFindings)) return { status: 'unverified', findings: [] };

  const findings: ReviewFinding[] = [];
  for (const item of rawFindings) {
    if (!isRecord(item) || typeof item.claim !== 'string' || typeof item.category !== 'string') {
      return { status: 'unverified', findings: [] };
    }
    if (typeof item.severity !== 'string' || !SEVERITIES.has(item.severity)) {
      return { status: 'unverified', findings: [] };
    }
    findings.push({
      severity: item.severity as ReviewFinding['severity'],
      category: item.category,
      claim: item.claim,
      ...(typeof item.file === 'string' ? { file: item.file } : {}),
      ...(typeof item.line === 'number' ? { line: item.line } : {}),
    });
  }

  if (parsed.status === 'passed' || parsed.status === 'failed') {
    return { status: parsed.status, findings };
  }
  return { status: 'unverified', findings };
}

export async function listInstalledProviders(): Promise<AgentProviderId[]> {
  const installed: AgentProviderId[] = [];
  for (const id of getRegisteredProviders()) {
    const probe = await probeAgent(id);
    if (probe.installed) installed.push(id);
  }
  return installed;
}

const REVIEW_SCHEMA = `{
  "status": "passed" | "failed",
  "findings": [
    { "file": "path", "line": 1, "severity": "error" | "warning" | "info", "category": "string", "claim": "string" }
  ]
}`;

export async function runIndependentReview(input: {
  producer: AgentProviderId;
  available?: readonly AgentProviderId[];
  pairings?: Record<string, string>;
  addDirs?: string[];
  promptContext: string;
}): Promise<StructuredReview> {
  const available = input.available ?? (await listInstalledProviders());
  const selection = selectReviewer(input.producer, available, input.pairings ?? {});
  if (selection.provider === null || selection.independence === 'none') {
    return {
      status: 'unverified',
      findings: [],
      independence: selection.independence,
      provider: selection.provider,
      degraded: true,
    };
  }

  const result = await runHeadless({
    prompt: [
      'Review the work as an independent reviewer. Do not edit files.',
      'Reply with a single JSON object and nothing else, matching this schema:',
      REVIEW_SCHEMA,
      '',
      input.promptContext,
    ].join('\n'),
    maxTurns: 15,
    timeout: getReviewTimeout(),
    outputFormat: 'json',
    allowedTools: ['Read', 'Glob', 'Grep'],
    addDirs: input.addDirs,
    statusMessage: `Independent review (${selection.provider})...`,
    phase: 'review',
    permission: 'read-only',
    forceProvider: selection.provider as AgentProviderId,
    purpose: 'verify',
  });

  const parsed = parseStructuredReview(result.result);
  return {
    ...parsed,
    independence: selection.independence,
    provider: selection.provider,
    degraded: selection.degraded,
  };
}

function getReviewTimeout(): number {
  return DEFAULT_HEADLESS_TIMEOUT_MS;
}
