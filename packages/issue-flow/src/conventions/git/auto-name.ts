import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isValidBranchName } from './slug.js';
import type { AutoNameConvention } from './types.js';

/**
 * The generated branch-name path, ported from WebMux's `AutoNameService`
 * (`backend/src/services/auto-name-service.ts` @ d8c9d5f).
 *
 * It answers the one case the `{type}/{N}-{slug}` convention never served: work
 * that has no issue, where the slug came out of an arbitrary document title and
 * usually came out badly.
 *
 * Two adaptations, both deliberate:
 *
 * - **No provider anywhere.** Upstream builds `claude -p …` / `codex exec …`
 *   argv in this module. This directory accepts no provider, agent or model
 *   (`src/conventions/AGENTS.md`), so the model call is an injected
 *   {@link BranchNameGenerator}. The prompt, the normalization and the fallback
 *   — everything that actually decides the name — stay here.
 * - **Failure degrades instead of throwing.** Upstream falls back only on
 *   timeout and throws when the CLI is missing or exits non-zero. Issue Flow
 *   must keep working with no model reachable at all, so every failure yields
 *   the deterministic fallback. G3 pins both halves.
 */

/** Upstream's ceiling. Short on purpose: the name is read in `git branch --list`. */
export const AUTO_NAME_MAX_LENGTH = 40;

/** Upstream's deadline for the whole call. */
export const AUTO_NAME_TIMEOUT_MS = 15_000;

/**
 * The instruction handed to the generator, kept literal from upstream.
 *
 * The last sentence is the load-bearing one: without "no prefixes like
 * feature/ or fix/" a model reliably produces `feature/foo`, which then
 * collides with the convention path's own prefix.
 */
export const DEFAULT_AUTO_NAME_SYSTEM_PROMPT = [
  'Generate a concise git branch name from the task description.',
  'Return only the branch name.',
  'Use lowercase kebab-case.',
  `Maximum ${AUTO_NAME_MAX_LENGTH} characters.`,
  'Do not include quotes, code fences, or prefixes like feature/ or fix/.',
].join(' ');

export interface AutoNameRequest {
  system: string;
  user: string;
  /** The generator should honour this; the caller enforces it regardless. */
  timeoutMs: number;
  /** Aborted when the deadline passes, so a spawned process can be killed. */
  signal: AbortSignal;
}

/** The seam a caller fills with whatever agent layer it has in hand. */
export type BranchNameGenerator = (request: AutoNameRequest) => Promise<string>;

export type AutoNameBranchOptions = AutoNameConvention;

export interface AutoNameResult {
  branch: string;
  source: 'generated' | 'fallback';
}

/** `system` prompt in force: the repository's override, else upstream's. */
export function autoNameSystemPrompt(config: AutoNameBranchOptions = {}): string {
  const declared = config.systemPrompt?.trim();
  return declared === undefined || declared === '' ? DEFAULT_AUTO_NAME_SYSTEM_PROMPT : declared;
}

/** `user` prompt in force, kept literal from upstream. */
export function autoNameUserPrompt(task: string): string {
  return `Here is the task description: ${task}. You MUST return the branch name only, no other text or comments. Be fast, make it simple, and concise.`;
}

/**
 * Turn whatever the generator produced into one legal branch name.
 *
 * Eleven steps, in this order, each defending against output seen in practice:
 * a fenced block, a leading `Branch name:`, surrounding quotes, uppercase, any
 * character git or the convention rejects, `/` and `.` that would reintroduce a
 * prefix, runs of hyphens, edges, the length ceiling, and the hyphen the
 * truncation itself can leave behind.
 *
 * Returns null instead of throwing when nothing usable remains: the caller's
 * answer to "no name" is the deterministic fallback, not an exception.
 */
export function normalizeGeneratedBranchName(
  raw: string,
  maxLength: number = AUTO_NAME_MAX_LENGTH,
): string | null {
  let branch = raw.trim();
  branch = branch.replace(/^```[\w-]*\s*/, '').replace(/\s*```$/, '');
  branch = branch.split(/\r?\n/)[0]?.trim() ?? '';
  branch = branch.replace(/^branch(?:\s+name)?\s*:\s*/i, '');
  branch = branch.replace(/^["'`]+|["'`]+$/g, '');
  branch = branch.toLowerCase();
  branch = branch.replace(/[^a-z0-9._/-]+/g, '-');
  branch = branch.replace(/[/.]+/g, '-');
  branch = branch.replace(/-+/g, '-');
  branch = branch.replace(/^-+|-+$/g, '');
  branch = branch.slice(0, maxLength).replace(/-+$/, '');

  if (branch === '' || !isValidBranchName(branch)) return null;
  return branch;
}

/** The deterministic third path: always legal, never colliding in practice. */
export function generateFallbackBranchName(): string {
  return `change-${randomUUID().slice(0, 8)}`;
}

/**
 * Generate a branch name from a free-form task description.
 *
 * The deadline is enforced here rather than trusted to the generator, so a
 * generator that ignores `timeoutMs` — or hangs on a process that never exits —
 * still cannot stall a run past `timeoutMs`.
 */
export async function autoNameBranch(
  task: string,
  generate: BranchNameGenerator,
  config: AutoNameBranchOptions = {},
): Promise<AutoNameResult> {
  const prompt = task.trim();
  if (prompt === '') {
    return { branch: generateFallbackBranchName(), source: 'fallback' };
  }

  const timeoutMs = config.timeoutMs ?? AUTO_NAME_TIMEOUT_MS;
  const maxLength = config.maxLength ?? AUTO_NAME_MAX_LENGTH;
  const controller = new AbortController();
  const deadline = new AbortController();

  const timer = delay(timeoutMs, 'timeout', { signal: deadline.signal, ref: false }).catch(
    () => 'cancelled' as const,
  );

  let raw: string | null = null;
  try {
    const outcome = await Promise.race([
      generate({
        system: autoNameSystemPrompt(config),
        user: autoNameUserPrompt(prompt),
        timeoutMs,
        signal: controller.signal,
      }),
      timer,
    ]);
    raw = outcome === 'timeout' || outcome === 'cancelled' ? null : outcome;
  } catch {
    // A missing CLI, a non-zero exit, an unparseable answer: all mean the same
    // thing here, and none of them may stop a run that can name itself.
    raw = null;
  } finally {
    deadline.abort();
    // Lets a generator that is still running observe the deadline and stop.
    if (raw === null) controller.abort();
  }

  if (raw === null) {
    return { branch: generateFallbackBranchName(), source: 'fallback' };
  }

  const normalized = normalizeGeneratedBranchName(raw, maxLength);
  if (normalized === null) {
    return { branch: generateFallbackBranchName(), source: 'fallback' };
  }
  return { branch: normalized, source: 'generated' };
}
