import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GLOBAL_ROOT_ENV } from '../paths.js';
import { importProjectArtifacts } from './import.js';
import { getDatabasePath, openIssueFlowDatabase } from './index.js';

const directories: string[] = [];

async function temporary(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  directories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function plan() {
  return {
    project: 'imported',
    issueNumber: 91,
    issueUrl: '',
    branchName: 'develop',
    noBranch: true,
    description: 'Import this state',
    issueStatus: 'in_progress',
    completedAt: null,
    lastAttemptAt: '2026-08-30T20:00:00Z',
    lastError: null,
    correctionCycle: 0,
    maxCorrectionCycles: 3,
    lastReviewFindings: null,
    pipeline: {
      prdCompleted: true,
      jsonCompleted: true,
      executionCompleted: false,
      reviewCompleted: false,
      prCreated: false,
    },
    userStories: [
      {
        id: 'US-002',
        title: 'Later',
        description: '',
        acceptanceCriteria: [],
        priority: 2,
        passes: false,
        notes: '',
        dependencies: ['US-001'],
      },
      {
        id: 'US-001',
        title: 'First',
        description: '',
        acceptanceCriteria: [],
        priority: 1,
        passes: true,
        notes: '',
      },
    ],
    executions: [
      {
        id: 'execution-1',
        sessionId: null,
        purpose: 'execute',
        attempt: 1,
        trigger: 'initial',
        triggerReason: null,
        agent: {
          harness: 'codex',
          provider: 'openai',
          model: { requested: null, resolved: null, source: 'provider' },
          providerSessionId: null,
        },
        startedAt: '2026-08-30T20:00:00Z',
        finishedAt: null,
        durationMs: null,
        usage: null,
        cost: { status: 'unknown', reason: 'not_reported' },
        status: 'running',
        failure: null,
      },
    ],
  };
}

describe('legacy JSON importer', () => {
  it('imports a complete project transactionally, preserves sources, and skips matching hashes', async () => {
    const home = await temporary('issue-flow-import-home-');
    const projectDir = join(home, 'projects', 'imported-project');
    const issueDir = join(projectDir, 'issues', '91');
    await mkdir(issueDir, { recursive: true });
    const taskFile = join(issueDir, 'tasks.json');
    const journalFile = join(issueDir, 'events.jsonl');
    await writeFile(taskFile, `${JSON.stringify(plan())}\n`);
    await writeFile(
      journalFile,
      `${JSON.stringify({ seq: 1, event: { type: 'phase:start', at: '2026-08-30T20:00:00Z' } })}\n`,
    );
    await writeFile(
      join(projectDir, 'providers.json'),
      JSON.stringify({ providers: { codex: {} } }),
    );
    const taskBefore = await readFile(taskFile, 'utf-8');
    const journalBefore = await readFile(journalFile, 'utf-8');
    const env = { [GLOBAL_ROOT_ENV]: home };
    const options = {
      env,
      projectId: 'imported-project',
      projectDir,
      projectRoot: '/repo',
      remoteUrl: null,
    };

    const first = await importProjectArtifacts(options);
    expect(first.failed).toBe(false);
    expect(first.imported).toBe(3);
    const second = await importProjectArtifacts(options);
    expect(second).toMatchObject({ failed: false, imported: 0, skipped: 0 });
    await expect(readFile(taskFile, 'utf-8')).resolves.toBe(taskBefore);
    await expect(readFile(journalFile, 'utf-8')).resolves.toBe(journalBefore);

    const database = await openIssueFlowDatabase({ env });
    try {
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM stories').get<{ count: number }>()?.count,
      ).toBe(2);
      expect(
        database
          .prepare('SELECT COUNT(*) AS count FROM story_dependencies')
          .get<{ count: number }>()?.count,
      ).toBe(1);
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM executions').get<{ count: number }>()
          ?.count,
      ).toBe(1);
      expect(
        database.prepare('SELECT COUNT(*) AS count FROM events').get<{ count: number }>()?.count,
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it('marks a project as adopted so changed compatibility projections are never reimported', async () => {
    const home = await temporary('issue-flow-import-marker-');
    const projectDir = join(home, 'projects', 'marker-project');
    const issueDir = join(projectDir, 'issues', '91');
    await mkdir(issueDir, { recursive: true });
    const taskFile = join(issueDir, 'tasks.json');
    await writeFile(taskFile, JSON.stringify(plan()));
    const options = {
      env: { [GLOBAL_ROOT_ENV]: home },
      projectId: 'marker-project',
      projectDir,
      projectRoot: '/repo',
      remoteUrl: null,
    };
    await importProjectArtifacts(options);
    const changed = plan();
    changed.description = 'projection must not replace canonical state';
    await writeFile(taskFile, JSON.stringify(changed));

    await expect(importProjectArtifacts(options)).resolves.toMatchObject({
      imported: 0,
      skipped: 0,
    });
    const database = await openIssueFlowDatabase({ env: options.env });
    try {
      expect(
        database
          .prepare('SELECT description FROM pipelines WHERE project_id = ? AND issue_id = ?')
          .get<{ description: string }>('marker-project', '91')?.description,
      ).toBe('Import this state');
    } finally {
      database.close();
    }
  });

  it('quarantines an existing database when an artifact cannot be imported', async () => {
    const home = await temporary('issue-flow-import-failure-');
    const projectDir = join(home, 'projects', 'broken-project');
    await mkdir(join(projectDir, 'issues', '91'), { recursive: true });
    await writeFile(join(projectDir, 'issues', '91', 'tasks.json'), '{not json');
    const env = { [GLOBAL_ROOT_ENV]: home };
    const database = await openIssueFlowDatabase({ env });
    database.close();

    const result = await importProjectArtifacts({
      env,
      projectId: 'broken-project',
      projectDir,
      projectRoot: '/repo',
      remoteUrl: null,
    });
    expect(result.failed).toBe(true);
    expect(existsSync(getDatabasePath({ env }))).toBe(false);
    expect((await readdir(home)).some((name) => name.startsWith('issue-flow.db.failed-'))).toBe(
      true,
    );
    await expect(readFile(join(projectDir, 'issues', '91', 'tasks.json'), 'utf-8')).resolves.toBe(
      '{not json',
    );
  });
});
