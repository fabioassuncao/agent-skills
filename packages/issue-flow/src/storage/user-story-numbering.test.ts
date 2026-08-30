import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Only the git seams are faked: everything below them (project id derivation,
// the tasks.json scan, metadata.json read/write) runs for real against a
// temporary tree.
vi.mock('../utils/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/git.js')>();
  return {
    ...actual,
    getRemoteUrl: vi.fn(async () => null),
    getProjectRoot: vi.fn(async () => process.cwd()),
  };
});

const { getProjectRoot, getRemoteUrl } = await import('../utils/git.js');
const { GLOBAL_ROOT_ENV } = await import('./paths.js');
const { resetStorageResolutionCache } = await import('./resolve.js');
const { projectMetadataSchema } = await import('./schemas.js');
const {
  determineUserStoryNumbering,
  findHighestUserStoryNumber,
  formatUserStoryId,
  parseUserStoryNumber,
  resolveUserStoryNumbering,
} = await import('./user-story-numbering.js');

const mockGetRemoteUrl = vi.mocked(getRemoteUrl);
const mockGetProjectRoot = vi.mocked(getProjectRoot);

let temps: string[] = [];
let globalHome: string;
let projectRoot: string;
let env: NodeJS.ProcessEnv;

async function makeTemp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** Seed canonical story history; numbering must never read tasks.json projections. */
async function writeTasksJson(issueId: string, userStories: Array<{ id: string }>): Promise<void> {
  const { resolveProjectPaths } = await import('./resolve.js');
  const { projectId } = await resolveProjectPaths({ projectRoot, env });
  const { seedStoriesForNumbering } = await import('./db/test-seed.js');
  await seedStoriesForNumbering({
    projectId,
    projectRoot,
    issueId,
    stories: userStories.map((story) => ({ id: story.id, number: parseUserStoryNumber(story.id) })),
    env,
  });
}

beforeEach(async () => {
  resetStorageResolutionCache();

  mockGetRemoteUrl.mockReset();
  mockGetRemoteUrl.mockResolvedValue(null);

  globalHome = await makeTemp('issue-flow-home-');
  projectRoot = await makeTemp('issue-flow-project-');
  env = { [GLOBAL_ROOT_ENV]: globalHome };

  mockGetProjectRoot.mockReset();
  mockGetProjectRoot.mockResolvedValue(projectRoot);
});

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
  temps = [];
});

describe('formatUserStoryId', () => {
  it('zero-pads to three digits', () => {
    expect(formatUserStoryId(1)).toBe('US-001');
    expect(formatUserStoryId(16)).toBe('US-016');
    expect(formatUserStoryId(999)).toBe('US-999');
  });

  it('does not truncate numbers beyond 999', () => {
    expect(formatUserStoryId(1000)).toBe('US-1000');
  });
});

describe('parseUserStoryNumber', () => {
  it('parses the canonical US-NNN format', () => {
    expect(parseUserStoryNumber('US-001')).toBe(1);
    expect(parseUserStoryNumber('US-027')).toBe(27);
  });

  it('is tolerant of ids outside the US-NNN format', () => {
    expect(parseUserStoryNumber('story-5')).toBe(5);
    expect(parseUserStoryNumber('42')).toBe(42);
    expect(parseUserStoryNumber('v2-US-007')).toBe(7);
  });

  it('returns null for an id with no digits, without throwing', () => {
    expect(parseUserStoryNumber('add-auth')).toBeNull();
    expect(parseUserStoryNumber('')).toBeNull();
  });
});

describe('findHighestUserStoryNumber', () => {
  it('returns null when the project has no issues directory yet', async () => {
    const result = await findHighestUserStoryNumber({ projectRoot, env });
    expect(result).toBeNull();
  });

  it('finds the highest number across every issue in the project', async () => {
    await writeTasksJson('12', [{ id: 'US-001' }, { id: 'US-015' }]);
    await writeTasksJson('13', [{ id: 'US-016' }, { id: 'US-020' }]);

    const result = await findHighestUserStoryNumber({ projectRoot, env });
    expect(result).toEqual({ number: 20, issueId: '13', storyId: 'US-020' });
  });

  it('does not consult a corrupt compatibility projection in a sibling issue', async () => {
    const { resolveProjectPaths } = await import('./resolve.js');
    const { issuesDir } = await resolveProjectPaths({ projectRoot, env });
    await mkdir(join(issuesDir, '14'), { recursive: true });
    await writeFile(join(issuesDir, '14', 'tasks.json'), '{ not valid json', 'utf-8');

    await writeTasksJson('15', [{ id: 'US-005' }]);

    const result = await findHighestUserStoryNumber({ projectRoot, env });
    expect(result).toEqual({ number: 5, issueId: '15', storyId: 'US-005' });
  });

  it('ignores ids with no parseable number', async () => {
    await writeTasksJson('16', [{ id: 'add-auth' }, { id: 'US-003' }]);

    const result = await findHighestUserStoryNumber({ projectRoot, env });
    expect(result).toEqual({ number: 3, issueId: '16', storyId: 'US-003' });
  });

  it('skips the excluded issue, so its own plan never counts as history', async () => {
    await writeTasksJson('12', [{ id: 'US-005' }]);
    await writeTasksJson('42', [{ id: 'US-006' }, { id: 'US-010' }]);

    const result = await findHighestUserStoryNumber({ projectRoot, env, excludeIssueId: '42' });
    expect(result).toEqual({ number: 5, issueId: '12', storyId: 'US-005' });
  });

  it('does not depend on an issues directory existing', async () => {
    await expect(findHighestUserStoryNumber({ projectRoot, env })).resolves.toBeNull();
  });
});

describe('resolveUserStoryNumbering', () => {
  it('starts at US-001 with no history (first plan run of the project)', async () => {
    const { decision, message } = await resolveUserStoryNumbering({
      issueNumber: '42',
      projectRoot,
      env,
    });

    expect(decision).toMatchObject({ nextNumber: 1, source: 'none', issueNumber: '42' });
    expect(message).toContain('US-001');
    expect(message).toContain('no previous history');
  });

  it('continues automatically from the last used number in the project', async () => {
    await writeTasksJson('12', [{ id: 'US-015' }]);

    const { decision, message } = await resolveUserStoryNumbering({
      issueNumber: '42',
      projectRoot,
      env,
    });

    expect(decision).toMatchObject({ nextNumber: 16, source: 'history', issueNumber: '42' });
    expect(decision.detail).toContain('US-015');
    expect(message).toContain('US-016');
    expect(message).not.toContain('--continue');
  });

  it('produces the same number for --continue, with the flag named in the message', async () => {
    await writeTasksJson('12', [{ id: 'US-015' }]);

    const { decision, message } = await resolveUserStoryNumbering({
      issueNumber: '42',
      continueFlag: true,
      projectRoot,
      env,
    });

    expect(decision).toMatchObject({ nextNumber: 16, source: 'history' });
    expect(message).toContain('--continue');
  });

  it('re-planning the same issue is idempotent: its own stories are not history', async () => {
    await writeTasksJson('12', [{ id: 'US-015' }]);
    // The plan a previous `plan` run of issue #42 already wrote — it is about
    // to be overwritten, so it must not push the numbering forward.
    await writeTasksJson('42', [{ id: 'US-016' }, { id: 'US-018' }]);

    const { decision } = await resolveUserStoryNumbering({ issueNumber: '42', projectRoot, env });

    expect(decision).toMatchObject({ nextNumber: 16, source: 'history' });
    expect(decision.detail).toContain('US-015');
  });

  it('--start-us wins outright and ignores history entirely', async () => {
    await writeTasksJson('12', [{ id: 'US-015' }]);

    const { decision, message } = await resolveUserStoryNumbering({
      issueNumber: '42',
      startUs: 27,
      projectRoot,
      env,
    });

    expect(decision).toMatchObject({ nextNumber: 27, source: 'start-us', issueNumber: '42' });
    expect(message).toContain('US-027');
    expect(message).toContain('--start-us');
  });
});

describe('determineUserStoryNumbering', () => {
  it('persists the decision into metadata.json for audit', async () => {
    await writeTasksJson('12', [{ id: 'US-015' }]);

    const result = await determineUserStoryNumbering({
      issueNumber: '42',
      projectRoot,
      env,
    });

    expect(result.nextUserStoryId).toBe('US-016');

    const { resolveProjectPaths } = await import('./resolve.js');
    const { projectDir } = await resolveProjectPaths({ projectRoot, env });
    const metadataRaw = await readFile(join(projectDir, 'metadata.json'), 'utf-8');
    const metadata = projectMetadataSchema.parse(JSON.parse(metadataRaw));

    expect(metadata.userStoryNumbering).toMatchObject({
      nextNumber: 16,
      source: 'history',
      issueNumber: '42',
    });
    const { exportStoredState } = await import('./db/repository.js');
    const { projectId } = await resolveProjectPaths({ projectRoot, env });
    await expect(exportStoredState({ env })).resolves.toMatchObject({
      user_story_numbering: expect.arrayContaining([
        expect.objectContaining({ project_id: projectId, next_number: 16, issue_id: '42' }),
      ]),
    });
  });

  it('keeps createdAt across two decisions for the same project', async () => {
    const first = await determineUserStoryNumbering({ issueNumber: '42', projectRoot, env });
    expect(first.decision.source).toBe('none');

    await writeTasksJson('42', [{ id: 'US-001' }]);

    const { resolveProjectPaths } = await import('./resolve.js');
    const { projectDir } = await resolveProjectPaths({ projectRoot, env });
    const firstMetadata = projectMetadataSchema.parse(
      JSON.parse(await readFile(join(projectDir, 'metadata.json'), 'utf-8')),
    );

    const second = await determineUserStoryNumbering({ issueNumber: '43', projectRoot, env });
    expect(second.decision).toMatchObject({ nextNumber: 2, source: 'history' });

    const secondMetadata = projectMetadataSchema.parse(
      JSON.parse(await readFile(join(projectDir, 'metadata.json'), 'utf-8')),
    );
    expect(secondMetadata.createdAt).toBe(firstMetadata.createdAt);
    expect(secondMetadata.userStoryNumbering?.nextNumber).toBe(2);
  });
});
