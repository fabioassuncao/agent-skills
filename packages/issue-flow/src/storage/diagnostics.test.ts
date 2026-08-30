import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bindDiagnosticContext,
  flushDiagnostics,
  readDiagnostics,
  resetDiagnosticsState,
  writeDiagnostic,
} from './diagnostics.js';

describe('global diagnostics', () => {
  let previousHome: string | undefined;
  let home: string;

  beforeEach(async () => {
    previousHome = process.env.ISSUE_FLOW_HOME;
    home = await mkdtemp(join(tmpdir(), 'issue-flow-diagnostics-'));
    process.env.ISSUE_FLOW_HOME = home;
    await resetDiagnosticsState();
  });

  afterEach(async () => {
    await resetDiagnosticsState();
    if (previousHome === undefined) delete process.env.ISSUE_FLOW_HOME;
    else process.env.ISSUE_FLOW_HOME = previousHome;
  });

  it('persists correlated JSONL globally and redacts secrets recursively', async () => {
    bindDiagnosticContext({ project: 'repo-123', sessionId: 'session-1', phase: 'execute' });
    writeDiagnostic({
      level: 'error',
      message: 'failed with Bearer abc.def.ghi',
      context: {
        command: 'TOKEN=super-secret',
        nested: ['sk-1234567890abcdef'],
        apiKey: 'an-otherwise-unrecognizable-value',
      },
      exception: new Error('PASSWORD=hunter2'),
    });
    await flushDiagnostics();

    const records = await readDiagnostics({ sessionId: 'session-1' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ project: 'repo-123', phase: 'execute', level: 'error' });
    const raw = await readFile(
      join(home, 'logs', `issue-flow-${new Date().toISOString().slice(0, 10)}.jsonl`),
      'utf-8',
    );
    expect(raw).not.toContain('abc.def.ghi');
    expect(raw).not.toContain('super-secret');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('an-otherwise-unrecognizable-value');
    expect(raw).toContain('[redacted]');
  });
});
