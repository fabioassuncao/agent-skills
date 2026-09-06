import { describe, expect, it } from 'vitest';
import type { LiveRun } from '../execution/registry.js';
import { formatPsTable, liveRunJsonSchema } from './ps.js';

function run(overrides: Partial<LiveRun> = {}): LiveRun {
  return {
    projectId: 'alpha',
    projectName: null,
    target: '63',
    pid: 11,
    host: 'mac',
    detached: false,
    status: 'running',
    startedAt: '2026-08-30T03:00:00.000Z',
    lastHeartbeatAt: '2026-08-30T03:00:10.000Z',
    issue: 63,
    phase: 'execute',
    storiesCompleted: 11,
    storiesTotal: 22,
    elapsedSeconds: 120,
    lockFile: '/tmp/run.lock',
    ...overrides,
  };
}

describe('formatPsTable', () => {
  it('lists issue, phase, progress, elapsed and pid', () => {
    const lines = formatPsTable([
      run(),
      run({ projectId: 'beta', target: '80', issue: 80, detached: true, pid: 22, phase: 'review' }),
    ]);
    expect(lines[0]).toContain('STATUS');
    expect(lines[1]).toContain('#63');
    expect(lines[1]).toContain('execute');
    expect(lines[1]).toContain('11/22');
    expect(lines[1]).toContain('11');
    expect(lines[2]).toContain('#80');
    expect(lines[2]).toContain('(bg)');
  });

  it('prefers the registry label over the raw project id', () => {
    const lines = formatPsTable([run({ projectId: 'alpha-9f2c1d4e5b6a', projectName: 'Alpha' })]);
    expect(lines[1]).toContain('Alpha');
    expect(lines[1]).not.toContain('alpha-9f2c1d4e5b6a');
  });

  it('falls back to the project id when the registry has no label', () => {
    expect(formatPsTable([run({ projectId: 'alpha', projectName: null })])[1]).toContain('alpha');
  });

  it('explains an empty machine', () => {
    expect(formatPsTable([])[0]).toMatch(/No issue-flow run/);
  });
});

describe('liveRunJsonSchema', () => {
  it('accepts the stable payload', () => {
    const parsed = liveRunJsonSchema.parse({
      schemaVersion: 1,
      runs: [
        {
          projectId: 'alpha',
          projectName: 'Alpha',
          target: '63',
          pid: 11,
          host: 'mac',
          detached: false,
          status: 'orphan',
          startedAt: 't',
          lastHeartbeatAt: 't',
          issue: 63,
          phase: null,
          storiesCompleted: null,
          storiesTotal: null,
          elapsedSeconds: null,
        },
      ],
    });
    expect(parsed.runs[0]?.status).toBe('orphan');
  });
});
