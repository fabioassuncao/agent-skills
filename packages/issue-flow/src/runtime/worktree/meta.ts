import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from '../../utils/fs.js';
import { ensureWorktreeStorageDirs, getWorktreeStoragePaths } from './paths.js';

/**
 * Durable state of one managed worktree.
 *
 * Adapted from WebMux `backend/src/domain/model.ts` (`WorktreeMeta`) and
 * `backend/src/adapters/fs.ts` @ d8c9d5f. §45.2-G is explicit about the split:
 * the **model** is the upstream's — it is good — and the **vehicle** is Issue
 * Flow's. So the metadata goes to SQLite, where the rest of this project's
 * durable state already lives, and `runtime.env` stays a file because `bash`
 * and the lifecycle hooks read it and neither can query a database.
 *
 * The upstream writes both with `Bun.write`, which is not atomic. Every write
 * here goes through `writeFileAtomic`: a crash mid-write must leave the
 * previous content, not a truncated file (§45.3).
 */

export const WORKTREE_META_SCHEMA_VERSION = 1;

/** Which runtime mode the worktree was prepared for. */
export type WorktreeRuntimeKind = 'host' | 'docker';

export interface WorktreeMeta {
  schemaVersion: number;
  worktreeId: string;
  branch: string;
  label?: string | null;
  baseBranch?: string | null;
  createdAt: string;
  /** Profile name; meaningful once profiles exist (phase 10). */
  profile: string;
  /** Agent provider the worktree was opened for. */
  agent: string;
  runtime: WorktreeRuntimeKind;
  /** Values exported into every pane and hook of this worktree. */
  startupEnvValues: Record<string, string>;
  /** Service name → port. Allocated by the services layer (phase 10). */
  allocatedPorts: Record<string, number>;
  source?: string;
  /** Provider-native conversation id, so a reopened worktree can `--resume`. */
  conversationId?: string | null;
}

export interface CreateWorktreeMetaInput {
  branch: string;
  baseBranch?: string | null;
  profile?: string;
  agent: string;
  runtime?: WorktreeRuntimeKind;
  startupEnvValues?: Record<string, string>;
  allocatedPorts?: Record<string, number>;
  source?: string;
  worktreeId?: string;
  now?: () => Date;
}

export function createWorktreeMeta(input: CreateWorktreeMetaInput): WorktreeMeta {
  const now = input.now ?? (() => new Date());
  return {
    schemaVersion: WORKTREE_META_SCHEMA_VERSION,
    worktreeId: input.worktreeId ?? randomUUID(),
    branch: input.branch,
    baseBranch: input.baseBranch ?? null,
    createdAt: now().toISOString(),
    profile: input.profile ?? 'default',
    agent: input.agent,
    runtime: input.runtime ?? 'host',
    startupEnvValues: input.startupEnvValues ?? {},
    allocatedPorts: input.allocatedPorts ?? {},
    ...(input.source === undefined ? {} : { source: input.source }),
    conversationId: null,
  };
}

/**
 * Environment every pane, hook and agent of this worktree sees.
 *
 * Ported from `buildRuntimeEnvMap`. The allocated ports are exported under
 * their own service key so a `postCreate` hook can start a dev server on the
 * port the worktree owns without knowing how allocation works.
 */
export function buildRuntimeEnvMap(
  meta: WorktreeMeta,
  worktreePath: string,
  extras: Record<string, string> = {},
): Record<string, string> {
  return {
    ISSUE_FLOW_WORKTREE_ID: meta.worktreeId,
    ISSUE_FLOW_WORKTREE_PATH: worktreePath,
    ISSUE_FLOW_BRANCH: meta.branch,
    ...(meta.baseBranch ? { ISSUE_FLOW_BASE_BRANCH: meta.baseBranch } : {}),
    ISSUE_FLOW_PROFILE: meta.profile,
    ISSUE_FLOW_AGENT: meta.agent,
    ISSUE_FLOW_RUNTIME: meta.runtime,
    ...meta.startupEnvValues,
    ...Object.fromEntries(
      Object.entries(meta.allocatedPorts).map(([key, port]) => [key, String(port)]),
    ),
    ...extras,
  };
}

/** Escape a value for the shell-style `key='value'` format the runtime env uses. */
function envQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function renderRuntimeEnv(values: Record<string, string>): string {
  const lines = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${envQuote(value)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Write `runtime.env` for a worktree.
 *
 * Deterministic order on purpose: the file is diffed by people debugging a
 * worktree, and a set of variables that reshuffles on every write makes that
 * useless.
 */
export async function writeRuntimeEnv(
  gitDir: string,
  values: Record<string, string>,
): Promise<string> {
  const paths = await ensureWorktreeStorageDirs(gitDir);
  await writeFileAtomic(paths.runtimeEnvPath, renderRuntimeEnv(values));
  return paths.runtimeEnvPath;
}

export { getWorktreeStoragePaths };
