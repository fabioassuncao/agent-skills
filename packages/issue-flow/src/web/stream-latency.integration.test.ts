import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanRepositoryContext } from '../storage/db/repository.js';
import { SqliteSessionPublisher } from '../storage/db/session-publisher.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import { startWebServer, type WebServerHandle } from './server.js';
import { type SessionDirectoryHandle, watchSessionDirectory } from './session-directory.js';

/**
 * Phase 1 of the WebMux absorption replaced two stacked polling hops — the
 * monitor re-reading SQLite every 3 s, the browser re-reading the monitor every
 * 5 s — with a push path. §35 of the absorption plan makes the resulting
 * output-to-screen latency a **hard ceiling**: 250 ms at p95, with no
 * acceptable justification for going back to an interval on the interactive
 * path.
 *
 * This measures the whole server-side path a real viewer depends on: a write by
 * a pipeline process, through the storage watch, through the session scan, out
 * of `/api/stream` and into a socket a browser could be holding. The client's
 * own render is the only step left out, and it is the one step that does not
 * involve waiting for anybody.
 *
 * It lives in the integration suite because it needs a real SQLite database, a
 * real filesystem watch and a real bound socket, and because a timing assertion
 * belongs where a loaded machine cannot turn a budget into a flake in the
 * default suite.
 */
describe('web/stream latency budget (§35: output → screen ≤ 250 ms p95)', () => {
  let home: string;
  const directories: SessionDirectoryHandle[] = [];
  const servers: WebServerHandle[] = [];
  const publishers: SqliteSessionPublisher[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'issue-flow-stream-latency-'));
  });

  afterEach(async () => {
    for (const publisher of publishers.splice(0)) await publisher.close();
    for (const server of servers.splice(0)) await server.close();
    for (const directory of directories.splice(0)) directory.close();
    await rm(home, { recursive: true, force: true });
  });

  function context(issueId: string): PlanRepositoryContext {
    return {
      tasksPath: join(home, 'projects', 'proj', 'issues', issueId, 'tasks.json'),
      projectId: 'proj',
      issueId,
      projectRoot: '/projects/proj',
      databaseOptions: { env: { [GLOBAL_ROOT_ENV]: home } },
    };
  }

  it('delivers a pipeline write to a connected viewer within budget', async () => {
    // The interval is pushed out of reach: if the push path regressed, this
    // measures nothing at all instead of quietly measuring the fallback.
    const directory = watchSessionDirectory({
      env: { [GLOBAL_ROOT_ENV]: home },
      pollIntervalMs: 600_000,
    });
    directories.push(directory);

    const server = await startWebServer({
      sessions: directory,
      port: 0,
      host: '127.0.0.1',
      info: () => {},
      warn: () => {},
    });
    if (server === null) throw new Error('server failed to start');
    servers.push(server);

    const controller = new AbortController();
    const response = await fetch(`${server.url}/api/stream`, {
      signal: controller.signal,
      headers: { accept: 'text/event-stream' },
    });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('no stream body');
    const decoder = new TextDecoder();

    /** Resolve as soon as the next `sessions` frame lands on the socket. */
    async function nextSessionsFrame(): Promise<void> {
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) throw new Error('stream ended');
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes('event: sessions')) return;
      }
    }

    await nextSessionsFrame(); // the opening frame, not a measurement

    const samples: number[] = [];
    for (let round = 0; round < 10; round += 1) {
      const publisher = new SqliteSessionPublisher(context(String(round)), { onWarn: () => {} });
      publishers.push(publisher);
      const at = new Date().toISOString();
      publisher.publish({
        type: 'session:start',
        at,
        sessionId: `sess-${round}`,
        issueNumber: round,
        phases: ['execute'],
      });
      const startedAt = Date.now();
      const delivered = nextSessionsFrame();
      await publisher.flush();
      await delivered;
      samples.push(Date.now() - startedAt);
    }

    controller.abort();

    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    // Recorded for docs/absorption-trace.md; the assertion is the gate.
    console.log(`output→screen: median ${median} ms, p95 ${p95} ms over ${samples.length} samples`);
    expect(p95).toBeLessThanOrEqual(250);
  });
});
