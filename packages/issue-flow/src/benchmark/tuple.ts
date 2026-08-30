import { ensureHarnessVersion } from '../agents/registry.js';
import type { AgentProviderId } from '../agents/types.js';
import type { TaskClass } from './corpus.js';

export interface ComparabilityTuple {
  task: TaskClass;
  harness: string;
  harnessVersion: string;
  model: string;
  modelVersion: string | null;
  effort: string;
  verification: string;
  strategy: 'direct' | 'pipeline';
  settingSourcesPinned: boolean;
  strictMcpConfig: boolean;
  fallbackModelPassed: boolean;
}

export type TupleField = keyof ComparabilityTuple;

export const TUPLE_FIELDS: readonly TupleField[] = [
  'task',
  'harness',
  'harnessVersion',
  'model',
  'modelVersion',
  'effort',
  'verification',
  'strategy',
  'settingSourcesPinned',
  'strictMcpConfig',
  'fallbackModelPassed',
] as const;

export class ComparabilityError extends Error {
  readonly field: TupleField;
  readonly left: unknown;
  readonly right: unknown;

  constructor(field: TupleField, left: unknown, right: unknown) {
    super(`ComparabilityTuple.${field} differs: ${String(left)} vs ${String(right)}`);
    this.name = 'ComparabilityError';
    this.field = field;
    this.left = left;
    this.right = right;
  }
}

/**
 * Two cells may be compared only when every field matches, except axes the
 * experiment declared (the arm). A silent mismatch is a bug.
 */
export function assertComparable(
  left: ComparabilityTuple,
  right: ComparabilityTuple,
  options: { ignore?: readonly TupleField[] } = {},
): void {
  const ignored = new Set(options.ignore ?? []);
  for (const field of TUPLE_FIELDS) {
    if (ignored.has(field)) continue;
    if (left[field] !== right[field]) {
      throw new ComparabilityError(field, left[field], right[field]);
    }
  }
}

/** `--fallback-model` present means the measured model is not the one that ran. */
export function isRowInvalid(tuple: ComparabilityTuple): boolean {
  return tuple.fallbackModelPassed || !tuple.settingSourcesPinned;
}

/** Collect at campaign time. Never assume a version from a document. */
export async function collectHarnessVersion(provider: AgentProviderId): Promise<string> {
  const version = await ensureHarnessVersion(provider);
  return version ?? 'unknown';
}

export function tupleAxisForArm(arm: string): TupleField | null {
  if (arm === 'strict-mcp') return 'strictMcpConfig';
  return null;
}
