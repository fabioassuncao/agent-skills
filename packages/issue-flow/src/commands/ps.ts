import { z } from 'zod';
import { loadGlobalConfig } from '../config/sources.js';
import { type LiveRun, listLiveRuns } from '../execution/registry.js';
import { resolveProjectPaths } from '../storage/resolve.js';
import { formatDuration, printInfo } from '../ui/logger.js';

export const liveRunJsonSchema = z.object({
  schemaVersion: z.literal(1),
  runs: z.array(
    z.object({
      projectId: z.string(),
      projectName: z.string().nullable(),
      target: z.string(),
      pid: z.number(),
      host: z.string(),
      detached: z.boolean(),
      status: z.enum(['running', 'unsignaled', 'orphan']),
      startedAt: z.string(),
      lastHeartbeatAt: z.string(),
      issue: z.number().nullable(),
      phase: z.string().nullable(),
      storiesCompleted: z.number().nullable(),
      storiesTotal: z.number().nullable(),
      elapsedSeconds: z.number().nullable(),
    }),
  ),
});

export interface PsOptions {
  json?: boolean;
  watch?: boolean;
}

export function formatPsTable(runs: readonly LiveRun[]): string[] {
  if (runs.length === 0) return ['No issue-flow run is active on this machine.'];

  const header = pad(['STATUS', 'ISSUE', 'PHASE', 'PROGRESS', 'ELAPSED', 'PID', 'PROJECT']);
  const rows = runs.map((run) =>
    pad([
      run.status,
      run.issue !== null ? `#${run.issue}` : run.target,
      run.phase ?? '—',
      run.storiesTotal !== null ? `${run.storiesCompleted ?? 0}/${run.storiesTotal}` : '—',
      run.elapsedSeconds !== null ? formatDuration(run.elapsedSeconds) : '—',
      String(run.pid),
      // The registry's label when there is one: a slug plus a twelve-character
      // hash identifies a project precisely and reads like nothing at all.
      `${run.projectName ?? run.projectId}${run.detached ? ' (bg)' : ''}`,
    ]),
  );
  return [header, ...rows];
}

function pad(cells: string[]): string {
  const widths = [12, 10, 12, 10, 10, 8, 24];
  return cells.map((cell, i) => cell.padEnd(widths[i] ?? 12)).join(' ');
}

export async function runPs(options: PsOptions = {}): Promise<number> {
  let storageDriver = (await loadGlobalConfig()).storage?.driver ?? 'sqlite';
  try {
    storageDriver = (await resolveProjectPaths()).storageDriver;
  } catch {
    // `ps` is machine-wide and remains usable outside a repository.
  }
  const render = async () => {
    const runs = await listLiveRuns({ storageDriver });
    if (options.json === true) {
      const payload = liveRunJsonSchema.parse({
        schemaVersion: 1,
        runs: runs.map(({ lockFile: _lockFile, ...rest }) => rest),
      });
      printInfo(JSON.stringify(payload, null, 2));
      return runs.length;
    }
    for (const line of formatPsTable(runs)) {
      printInfo(line);
    }
    return runs.length;
  };

  if (options.watch === true) {
    for (;;) {
      await render();
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  await render();
  return 0;
}
