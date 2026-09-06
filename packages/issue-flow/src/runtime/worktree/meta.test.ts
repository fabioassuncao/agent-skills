import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRuntimeEnvMap,
  createWorktreeMeta,
  renderRuntimeEnv,
  writeRuntimeEnv,
} from './meta.js';
import { getWorktreeStoragePaths, resolveWorktreePath } from './paths.js';
import { WorktreeCreationTracker } from './progress.js';

/**
 * Adapted from WebMux `backend/src/__tests__/worktree-storage.test.ts` @ d8c9d5f.
 * The upstream keeps this state in `meta.json` next to the worktree; here the
 * metadata lives in SQLite and only `runtime.env` stays a file, because `bash`
 * and the lifecycle hooks read it and neither can query a database (§45.2-G).
 */
describe('worktree metadata', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('stamps a fresh worktree with an id, a schema version and a creation time', () => {
    const meta = createWorktreeMeta({
      branch: 'feature',
      agent: 'claude',
      baseBranch: 'main',
      now: () => new Date('2026-09-06T10:00:00.000Z'),
    });

    expect(meta).toMatchObject({
      schemaVersion: 1,
      branch: 'feature',
      baseBranch: 'main',
      agent: 'claude',
      profile: 'default',
      runtime: 'host',
      startupEnvValues: {},
      allocatedPorts: {},
      createdAt: '2026-09-06T10:00:00.000Z',
      conversationId: null,
    });
    expect(meta.worktreeId).toMatch(/^[0-9a-f-]{36}$/);
  });

  // The ports are exported under the service's own key, so a postCreate hook
  // can start a dev server on the port this worktree owns without knowing
  // anything about how allocation works.
  it('exports identity, startup values and allocated ports into the runtime environment', () => {
    const meta = createWorktreeMeta({
      branch: 'feature',
      agent: 'codex',
      startupEnvValues: { NODE_ENV: 'development' },
      allocatedPorts: { PORT: 3101 },
    });

    const env = buildRuntimeEnvMap(meta, '/wt/feature', { EXTRA: 'yes' });
    expect(env).toMatchObject({
      ISSUE_FLOW_WORKTREE_ID: meta.worktreeId,
      ISSUE_FLOW_WORKTREE_PATH: '/wt/feature',
      ISSUE_FLOW_BRANCH: 'feature',
      ISSUE_FLOW_AGENT: 'codex',
      ISSUE_FLOW_RUNTIME: 'host',
      NODE_ENV: 'development',
      PORT: '3101',
      EXTRA: 'yes',
    });
    // No base branch was given, so the variable is absent rather than empty:
    // an exported empty string reads as "the base is nothing".
    expect(env.ISSUE_FLOW_BASE_BRANCH).toBeUndefined();
  });

  it('quotes shell-hostile values and keeps a deterministic order', () => {
    const rendered = renderRuntimeEnv({ B: 'two', A: "it's", C: 'a b' });
    expect(rendered).toBe(["A='it'\\''s'", "B='two'", "C='a b'", ''].join('\n'));
  });

  it('writes runtime.env under the git directory, never in the working tree', async () => {
    const gitDir = await mkdtemp(join(tmpdir(), 'issue-flow-worktree-meta-'));
    dirs.push(gitDir);

    const path = await writeRuntimeEnv(gitDir, { ISSUE_FLOW_BRANCH: 'feature' });
    expect(path).toBe(getWorktreeStoragePaths(gitDir).runtimeEnvPath);
    expect(path.startsWith(gitDir)).toBe(true);
    expect(await readFile(path, 'utf-8')).toBe("ISSUE_FLOW_BRANCH='feature'\n");
    await expect(stat(path)).resolves.toBeDefined();
  });

  it('rewrites runtime.env in place on a second write', async () => {
    const gitDir = await mkdtemp(join(tmpdir(), 'issue-flow-worktree-meta-'));
    dirs.push(gitDir);

    await writeRuntimeEnv(gitDir, { A: '1' });
    const path = await writeRuntimeEnv(gitDir, { B: '2' });
    expect(await readFile(path, 'utf-8')).toBe("B='2'\n");
  });
});

describe('resolveWorktreePath', () => {
  // A branch name with slashes nests directories, keeping the path a readable
  // mirror of the branch instead of an ambiguous flattened slug.
  it('mirrors the branch under the container, slashes included', () => {
    expect(resolveWorktreePath('/repo', '../worktrees', 'feat/63-thing')).toBe(
      '/worktrees/feat/63-thing',
    );
  });

  it('accepts an absolute container', () => {
    expect(resolveWorktreePath('/repo', '/elsewhere/wt', 'feature')).toBe('/elsewhere/wt/feature');
  });
});

describe('WorktreeCreationTracker', () => {
  function progress(branch: string) {
    return {
      branch,
      path: `/wt/${branch}`,
      phase: 'creating_worktree' as const,
      source: 'cli' as const,
    };
  }

  it('tracks what is being created and forgets it when cleared', () => {
    const tracker = new WorktreeCreationTracker();
    expect(tracker.has('a')).toBe(false);

    tracker.set(progress('a'));
    expect(tracker.has('a')).toBe(true);
    expect(tracker.list()).toMatchObject([{ branch: 'a', phase: 'creating_worktree' }]);

    expect(tracker.clear('a')).toBe(true);
    expect(tracker.clear('a')).toBe(false);
    expect(tracker.list()).toEqual([]);
  });

  it('replaces the state of a branch rather than appending to it', () => {
    const tracker = new WorktreeCreationTracker();
    tracker.set(progress('a'));
    tracker.set({ ...progress('a'), phase: 'starting_session' });
    expect(tracker.list()).toMatchObject([{ branch: 'a', phase: 'starting_session' }]);
  });

  // Sorted rather than in insertion order: a poller that renders this list
  // should not see rows jump around because a creation finished elsewhere.
  it('lists branches in a stable order', () => {
    const tracker = new WorktreeCreationTracker();
    tracker.set(progress('c'));
    tracker.set(progress('a'));
    tracker.set(progress('b'));
    expect(tracker.list().map((state) => state.branch)).toEqual(['a', 'b', 'c']);
  });

  it('hands out copies, so a caller cannot mutate the tracker state', () => {
    const tracker = new WorktreeCreationTracker();
    tracker.set(progress('a'));
    const listed = tracker.list();
    listed[0]!.phase = 'reconciling';
    expect(tracker.list()[0]?.phase).toBe('creating_worktree');
  });
});
