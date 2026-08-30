import { appendFile, mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { redactSecrets } from '../telemetry/redact.js';
import { getDiagnosticsDir } from './paths.js';

export type DiagnosticLevel = 'debug' | 'info' | 'warning' | 'error';

export interface DiagnosticContext {
  project?: string | null;
  projectRoot?: string | null;
  sessionId?: string | null;
  executionId?: string | null;
  issue?: string | number | null;
  phase?: string | null;
  story?: string | null;
  harness?: string | null;
  model?: string | null;
}

export interface DiagnosticRecord extends DiagnosticContext {
  timestamp: string;
  level: DiagnosticLevel;
  message: string;
  context: unknown | null;
  exception: { name: string; message: string; stack: string | null } | null;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_GENERATIONS = 5;
const RETENTION_DAYS = 30;
let bound: DiagnosticContext = {};
let pending: Promise<void> = Promise.resolve();
let retentionChecked = false;
const SENSITIVE_KEY =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization)/i;

export function bindDiagnosticContext(context: DiagnosticContext): void {
  bound = { ...bound, ...context };
}

function sanitize(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? '[redacted]' : sanitize(item),
      ]),
    );
  }
  return value;
}

function diagnosticFile(timestamp: string): string {
  return join(getDiagnosticsDir(), `issue-flow-${timestamp.slice(0, 10)}.jsonl`);
}

async function rotate(file: string, incomingBytes: number): Promise<void> {
  let size = 0;
  try {
    size = (await stat(file)).size;
  } catch {
    return;
  }
  if (size + incomingBytes < MAX_FILE_BYTES) return;
  try {
    await unlink(`${file}.${MAX_GENERATIONS}`);
  } catch {}
  for (let generation = MAX_GENERATIONS - 1; generation >= 1; generation--) {
    try {
      await rename(`${file}.${generation}`, `${file}.${generation + 1}`);
    } catch {}
  }
  try {
    await rename(file, `${file}.1`);
  } catch {}
}

async function enforceRetention(directory: string): Promise<void> {
  if (retentionChecked) return;
  retentionChecked = true;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1_000;
  await Promise.all(
    names
      .filter((name) => /^issue-flow-\d{4}-\d{2}-\d{2}\.jsonl(?:\.\d+)?$/.test(name))
      .map(async (name) => {
        const path = join(directory, name);
        try {
          if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
        } catch {}
      }),
  );
}

export function writeDiagnostic(input: {
  level: DiagnosticLevel;
  message: string;
  context?: unknown;
  exception?: unknown;
  fields?: DiagnosticContext;
}): void {
  const timestamp = new Date().toISOString();
  const error = input.exception instanceof Error ? input.exception : null;
  const record: DiagnosticRecord = {
    ...bound,
    ...input.fields,
    timestamp,
    level: input.level,
    message: redactSecrets(input.message),
    context: input.context === undefined ? null : sanitize(input.context),
    exception:
      error === null
        ? null
        : {
            name: error.name,
            message: redactSecrets(error.message),
            stack: error.stack ? redactSecrets(error.stack) : null,
          },
  };
  const line = `${JSON.stringify(record)}\n`;
  pending = pending
    .then(async () => {
      const directory = getDiagnosticsDir();
      await mkdir(directory, { recursive: true });
      await enforceRetention(directory);
      const file = diagnosticFile(timestamp);
      await rotate(file, Buffer.byteLength(line));
      await appendFile(file, line, 'utf-8');
    })
    .catch(() => {});
}

export async function flushDiagnostics(): Promise<void> {
  await pending;
}

/** Test seam: diagnostics are process-global like the terminal/session publishers. */
export async function resetDiagnosticsState(): Promise<void> {
  await pending;
  bound = {};
  pending = Promise.resolve();
  retentionChecked = false;
}

export async function readDiagnostics(
  options: { sessionId?: string; project?: string; limit?: number } = {},
): Promise<DiagnosticRecord[]> {
  const directory = getDiagnosticsDir();
  let names: string[];
  try {
    names = (await readdir(directory))
      .filter((name) => /^issue-flow-\d{4}-\d{2}-\d{2}\.jsonl(?:\.\d+)?$/.test(name))
      .sort((left, right) => {
        const leftDate = left.slice(11, 21);
        const rightDate = right.slice(11, 21);
        if (leftDate !== rightDate) return rightDate.localeCompare(leftDate);
        const generation = (name: string): number =>
          Number(name.match(/\.jsonl\.(\d+)$/)?.[1] ?? 0);
        return generation(left) - generation(right);
      });
  } catch {
    return [];
  }
  const limit = Math.max(1, Math.min(options.limit ?? 500, 2_000));
  const records: DiagnosticRecord[] = [];
  for (const name of names) {
    let raw: string;
    try {
      raw = await readFile(join(directory, name), 'utf-8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n').reverse()) {
      if (line.trim() === '') continue;
      try {
        const record = JSON.parse(line) as DiagnosticRecord;
        if (options.sessionId && record.sessionId !== options.sessionId) continue;
        if (options.project && record.project !== options.project) continue;
        records.push(record);
        if (records.length >= limit) return records;
      } catch {}
    }
  }
  return records;
}
