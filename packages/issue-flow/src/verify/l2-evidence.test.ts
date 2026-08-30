import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractRun } from './types.js';

const reviewStatus = { value: 'passed' as 'passed' | 'failed' | 'unverified' };

vi.mock('../config.js', () => ({
  loadVerifyConfig: async () => ({
    level: 'L2',
    triggers: {},
    contract: null,
    pairings: {},
    crossVerify: true,
  }),
}));

vi.mock('./contract.js', () => ({
  resolveContract: async () => ({
    source: 'discovered',
    checks: [{ id: 'test', run: 'npm test' }],
  }),
}));

vi.mock('./runner.js', () => ({
  runContract: async (): Promise<ContractRun> => ({
    verdict: 'passed',
    level: 'L1',
    results: [
      {
        id: 'test',
        command: 'npm test',
        status: 'passed',
        fatal: true,
        durationMs: 1,
        exitCode: 0,
        output: '',
      },
    ],
  }),
}));

vi.mock('./reviewer.js', () => ({
  runIndependentReview: async () => ({
    status: reviewStatus.value,
    findings: [],
    independence: 'vendor',
  }),
}));

vi.mock('../telemetry/recorder.js', () => ({ attachVerdict: async () => undefined }));
vi.mock('../agents/resolve.js', () => ({
  resolveAgentFor: async () => ({ provider: 'claude', model: null }),
}));
vi.mock('../utils/git.js', () => ({ getProjectRoot: async () => process.cwd() }));

import { VERIFY_FILENAME } from '../storage/paths.js';
import { runAcceptance } from './run-issue.js';

async function readEvidence(dir: string) {
  return JSON.parse(await readFile(join(dir, VERIFY_FILENAME), 'utf-8'));
}

let issueDir: string;

beforeEach(async () => {
  issueDir = await mkdtemp(join(tmpdir(), 'issue-flow-verify-'));
  reviewStatus.value = 'passed';
});

describe('L2 evidence', () => {
  it('records the verdict the pipeline acted on, not the L1 run it superseded', async () => {
    reviewStatus.value = 'failed';

    const outcome = await runAcceptance({ issueDir, executionId: 'exec-1' });

    expect(outcome.verdict).toBe('failed');
    // The bundle is the audit artifact. Writing it before the reviewer and
    // never rewriting it left `passed` on disk for a run that failed.
    const evidence = await readEvidence(issueDir);
    expect(evidence.verdict).toBe('failed');
    expect(evidence.level).toBe('L2');
    expect(evidence.executionId).toBe('exec-1');
  });

  it('records L2 even when the reviewer agrees with the contract', async () => {
    const outcome = await runAcceptance({ issueDir, executionId: 'exec-2' });

    expect(outcome.verdict).toBe('passed');
    expect(await readEvidence(issueDir)).toMatchObject({ verdict: 'passed', level: 'L2' });
  });

  it('leaves the L1 bundle on disk when the reviewer is skipped', async () => {
    const outcome = await runAcceptance({ issueDir, skipReviewer: true });

    expect(outcome.verdict).toBe('passed');
    expect(await readEvidence(issueDir)).toMatchObject({ verdict: 'passed', level: 'L1' });
  });
});
