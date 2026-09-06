import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GLOBAL_ROOT_ENV, type IssuePaths } from '../../storage/paths.js';
import {
  resetStorageResolutionCache,
  resolveIssuePaths,
  resolveProjectPaths,
} from '../../storage/resolve.js';
import type { ExecResult } from '../../utils/shell.js';
import { hashIssueContent } from '../hash.js';
import type { IssueMetadata } from '../types.js';

vi.mock('../../utils/shell.js', () => ({ run: vi.fn() }));

const { run } = await import('../../utils/shell.js');
const { LocalFileIssueProvider, localFileIssueProvider, parseIssueMarkdown } = await import(
  './local.js'
);

const mockRun = vi.mocked(run);

function result(overrides?: Partial<ExecResult>): ExecResult {
  return { stdout: '', stderr: '', exitCode: 0, ...overrides };
}

/**
 * Install a `run` double that always answers git first.
 *
 * The provider resolves the project id through `git remote get-url origin`, so
 * a double that answers every command with the same gh payload would turn that
 * payload into the "remote" and move the whole global tree. Reporting no remote
 * keeps the id derived from the temporary root, which is what the path helpers
 * in this file reproduce.
 */
function mockGh(handler: (cmd: string, args: string[]) => Promise<ExecResult>): void {
  mockRun.mockReset();
  mockRun.mockImplementation(async (cmd: string, args: string[] = []) => {
    if (cmd === 'git') return result({ exitCode: 1 });
    return handler(cmd, args);
  });
}

/** gh is unreachable unless a test says otherwise. */
function ghUnavailable(): void {
  mockGh(() => Promise.reject(new Error('spawn gh ENOENT')));
}

function metadata(overrides?: Partial<IssueMetadata>): IssueMetadata {
  return {
    schemaVersion: 1,
    id: '23',
    number: 23,
    source: 'local',
    title: 'Abstract issue providers',
    labels: ['enhancement'],
    state: 'open',
    createdAt: '2026-08-01T10:00:00Z',
    updatedAt: '2026-08-02T11:00:00Z',
    contentHash: hashIssueContent('Abstract issue providers', 'Make it origin-agnostic.'),
    ...overrides,
  };
}

let root: string;
let home: string;
let previousHome: string | undefined;
let provider: InstanceType<typeof LocalFileIssueProvider>;

/** The same resolution the provider performs, for assertions and fixtures. */
async function paths(id: string): Promise<IssuePaths> {
  return resolveIssuePaths(id, { projectRoot: root });
}

function serializeMetadata(meta: IssueMetadata | string): string {
  return typeof meta === 'string' ? meta : `${JSON.stringify(meta, null, 2)}\n`;
}

async function writeIssue(id: string, markdown: string, meta?: IssueMetadata | string) {
  const { issueDir, issueFile, metadataFile } = await paths(id);
  await mkdir(issueDir, { recursive: true });
  await writeFile(issueFile, markdown, 'utf-8');
  if (meta !== undefined) {
    await writeFile(metadataFile, serializeMetadata(meta), 'utf-8');
  }
}

/**
 * Fixture in the legacy `<projectRoot>/issues/<id>/` layout, written without
 * resolving anything — resolving would mark the issue as already checked and
 * skip the very migration these cases exercise.
 */
async function writeLegacyIssue(id: string, markdown: string, meta?: IssueMetadata | string) {
  const dir = join(root, 'issues', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'issue.md'), markdown, 'utf-8');
  if (meta !== undefined) {
    await writeFile(join(dir, 'metadata.json'), serializeMetadata(meta), 'utf-8');
  }
}

async function readMetadata(id: string): Promise<IssueMetadata> {
  return JSON.parse(await readFile((await paths(id)).metadataFile, 'utf-8'));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  ghUnavailable();
  root = await mkdtemp(join(tmpdir(), 'issue-flow-local-provider-'));
  // The provider calls resolveIssuePaths() with no options, so the `{ env }`
  // seam never reaches it: the override has to be on the real process.env.
  home = await mkdtemp(join(tmpdir(), 'issue-flow-local-home-'));
  previousHome = process.env[GLOBAL_ROOT_ENV];
  process.env[GLOBAL_ROOT_ENV] = home;
  resetStorageResolutionCache();
  provider = new LocalFileIssueProvider(root);
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env[GLOBAL_ROOT_ENV];
  else process.env[GLOBAL_ROOT_ENV] = previousHome;
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('LocalFileIssueProvider', () => {
  it('is registered under the local source', () => {
    expect(provider.name).toBe('local');
    expect(localFileIssueProvider.name).toBe('local');
  });
});

describe('parseIssueMarkdown', () => {
  it('takes the title from the leading H1 and the body from the rest', () => {
    expect(parseIssueMarkdown('# Title\n\nBody line\n')).toEqual({
      title: 'Title',
      body: 'Body line',
    });
  });

  it('leaves headings inside the body alone', () => {
    const parsed = parseIssueMarkdown('# Title\n\nIntro\n\n# Not the title\n\nMore\n');
    expect(parsed.title).toBe('Title');
    expect(parsed.body).toBe('Intro\n\n# Not the title\n\nMore');
  });

  it('falls back to an empty title when there is no leading H1', () => {
    expect(parseIssueMarkdown('Just a body\n')).toEqual({ title: '', body: 'Just a body' });
  });

  it('normalizes CRLF line endings', () => {
    expect(parseIssueMarkdown('# Title\r\n\r\nBody\r\n')).toEqual({
      title: 'Title',
      body: 'Body',
    });
  });
});

describe('get', () => {
  it('reads issue.md and metadata.json into an Issue', async () => {
    await writeIssue('23', '# Abstract issue providers\n\nMake it origin-agnostic.\n', metadata());

    const issue = await provider.get('23');

    expect(issue).toMatchObject({
      id: '23',
      number: 23,
      title: 'Abstract issue providers',
      body: 'Make it origin-agnostic.',
      labels: ['enhancement'],
      state: 'open',
      source: 'local',
      remoteRef: null,
      createdAt: '2026-08-01T10:00:00Z',
      updatedAt: '2026-08-02T11:00:00Z',
      contentHash: hashIssueContent('Abstract issue providers', 'Make it origin-agnostic.'),
    });
  });

  it('accepts identifiers with a leading #', async () => {
    await writeIssue('23', '# Title\n\nBody\n', metadata());

    expect(await provider.get('#23')).toMatchObject({ id: '23' });
  });

  it('exposes the remote reference when metadata carries one', async () => {
    await writeIssue(
      '23',
      '# Title\n\nBody\n',
      metadata({
        remote: {
          provider: 'github',
          ref: 'https://github.com/acme/repo/issues/23',
          syncedAt: '2026-08-02T11:00:00Z',
          syncedContentHash: hashIssueContent('Title', 'Body'),
        },
      }),
    );

    expect(await provider.get('23')).toMatchObject({
      remoteRef: 'https://github.com/acme/repo/issues/23',
    });
  });

  it('recomputes the content hash from issue.md instead of trusting metadata', async () => {
    await writeIssue(
      '23',
      '# Title\n\nEdited by hand\n',
      metadata({ contentHash: 'sha256:stale' }),
    );

    const issue = await provider.get('23');

    expect(issue?.contentHash).toBe(hashIssueContent('Title', 'Edited by hand'));
  });

  it('derives minimal metadata when metadata.json is absent', async () => {
    await writeIssue('42', '# Local only\n\nNo metadata file here.\n');

    const issue = await provider.get('42');

    expect(issue).toMatchObject({
      id: '42',
      number: 42,
      title: 'Local only',
      body: 'No metadata file here.',
      labels: [],
      state: 'open',
      source: 'local',
      remoteRef: null,
      contentHash: hashIssueContent('Local only', 'No metadata file here.'),
    });
    expect(issue?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(issue?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps number null for non-numeric identifiers', async () => {
    await writeIssue('spike-auth', '# Spike\n\nBody\n');

    expect(await provider.get('spike-auth')).toMatchObject({ id: 'spike-auth', number: null });
  });

  it('returns null when the directory does not exist', async () => {
    expect(await provider.get('999')).toBeNull();
  });

  it('returns null when the directory exists without issue.md', async () => {
    await mkdir((await paths('7')).issueDir, { recursive: true });

    expect(await provider.get('7')).toBeNull();
  });

  it('throws citing the path and the field when metadata.json breaks the schema', async () => {
    const invalid = { ...metadata(), state: 'archived' };
    await writeIssue('23', '# Title\n\nBody\n', invalid as unknown as IssueMetadata);
    const { metadataFile } = await paths('23');

    await expect(provider.get('23')).rejects.toThrow(metadataFile);
    await expect(provider.get('23')).rejects.toThrow(/state/);
  });

  it('throws citing the path when metadata.json is not valid JSON', async () => {
    await writeIssue('23', '# Title\n\nBody\n', '{ not json');
    const { metadataFile } = await paths('23');

    await expect(provider.get('23')).rejects.toThrow(`Invalid JSON in ${metadataFile}`);
  });

  it('rejects identifiers that would escape the issues directory', async () => {
    await expect(provider.get('../../etc')).rejects.toThrow(/Invalid local issue identifier/);
    await expect(provider.get('   ')).rejects.toThrow(/cannot be empty/);
  });
});

describe('global storage', () => {
  it('reads an issue that still only exists in the legacy tree, leaving it untouched', async () => {
    await writeLegacyIssue('23', '# Legacy issue\n\nStill in the repo.\n', metadata());

    expect(await provider.get('23')).toMatchObject({
      id: '23',
      title: 'Legacy issue',
      body: 'Still in the repo.',
    });

    // Migrated, not moved: the copy landed in the global tree and the source is
    // byte for byte what it was.
    const { issueFile } = await paths('23');
    expect(await readFile(issueFile, 'utf-8')).toBe('# Legacy issue\n\nStill in the repo.\n');
    expect(await readFile(join(root, 'issues', '23', 'issue.md'), 'utf-8')).toBe(
      '# Legacy issue\n\nStill in the repo.\n',
    );
  });

  it('allocates above a number that only the legacy tree knows about', async () => {
    await writeLegacyIssue('41', '# Legacy\n\nBody\n');

    expect(await provider.create({ title: 'Next', body: 'Body', labels: [] })).toMatchObject({
      id: '42',
    });
  });

  it('never writes under <projectRoot>/issues/', async () => {
    await provider.create({ title: 'Fresh', body: 'Body', labels: [] });
    await provider.close('1');

    expect(await exists(join(root, 'issues'))).toBe(false);
  });
});

describe('create', () => {
  it('writes issue.md and a schema-valid metadata.json', async () => {
    const issue = await provider.create({
      title: 'New local demand',
      body: 'Describe it here.',
      labels: ['bug'],
    });

    expect(issue).toMatchObject({
      id: '1',
      number: 1,
      title: 'New local demand',
      body: 'Describe it here.',
      labels: ['bug'],
      state: 'open',
      source: 'local',
      remoteRef: null,
      contentHash: hashIssueContent('New local demand', 'Describe it here.'),
    });

    const markdown = await readFile((await paths('1')).issueFile, 'utf-8');
    expect(markdown).toBe('# New local demand\n\nDescribe it here.\n');

    expect(await readMetadata('1')).toMatchObject({
      schemaVersion: 1,
      id: '1',
      number: 1,
      source: 'local',
      state: 'open',
      labels: ['bug'],
    });
  });

  it('round-trips through get', async () => {
    const created = await provider.create({ title: 'Round trip', body: 'Body', labels: [] });

    expect(await provider.get(created.id)).toMatchObject({
      title: 'Round trip',
      body: 'Body',
      contentHash: created.contentHash,
    });
  });

  it('allocates above the highest local number', async () => {
    await writeIssue('23', '# Existing\n\nBody\n', metadata());
    await writeIssue('41', '# Another\n\nBody\n');

    expect(await provider.create({ title: 'Next', body: 'Body', labels: [] })).toMatchObject({
      id: '42',
      number: 42,
    });
  });

  it('allocates above the highest remote number when GitHub answers', async () => {
    await writeIssue('23', '# Existing\n\nBody\n', metadata());
    mockGh(async () => result({ stdout: JSON.stringify([{ number: 108 }]) }));

    expect(await provider.create({ title: 'Next', body: 'Body', labels: [] })).toMatchObject({
      id: '109',
    });
  });

  it('counts pull requests too, since GitHub shares one counter', async () => {
    mockGh(async (_cmd, args) =>
      result({ stdout: JSON.stringify([{ number: args[0] === 'pr' ? 300 : 7 }]) }),
    );

    expect(await provider.create({ title: 'Next', body: 'Body', labels: [] })).toMatchObject({
      id: '301',
    });
  });

  it('ignores an unreachable or failing remote', async () => {
    mockGh(async () => result({ exitCode: 1, stderr: 'no git remote found' }));

    expect(await provider.create({ title: 'Offline', body: 'Body', labels: [] })).toMatchObject({
      id: '1',
    });
  });

  it('honours an explicit identifier instead of allocating one', async () => {
    const allocate = vi.spyOn(provider, 'allocateNumber');

    expect(
      await provider.create({ title: 'Mirror', body: 'Body', labels: [], id: '108' }),
    ).toMatchObject({ id: '108', number: 108 });

    expect(allocate).not.toHaveBeenCalled();
    expect(await readMetadata('108')).toMatchObject({ id: '108', number: 108 });
  });

  it('rejects an explicit identifier that would escape the issues directory', async () => {
    await expect(
      provider.create({ title: 'Escape', body: 'Body', labels: [], id: '../elsewhere' }),
    ).rejects.toThrow(/Invalid local issue identifier/);
  });

  it('records the remote pointer of a mirrored issue', async () => {
    const remote = {
      provider: 'github' as const,
      ref: 'https://github.com/acme/app/issues/108',
      syncedAt: '2026-08-03T12:00:00Z',
      syncedContentHash: hashIssueContent('Mirror', 'Body'),
    };

    const issue = await provider.create({
      title: 'Mirror',
      body: 'Body',
      labels: [],
      id: '108',
      remote,
    });

    expect(issue.remoteRef).toBe(remote.ref);
    expect(await readMetadata('108')).toMatchObject({ remote });
    expect((await provider.get('108'))?.remoteRef).toBe(remote.ref);
  });

  it('refuses an explicit identifier that already exists', async () => {
    await writeIssue('108', '# Existing\n\nBody\n');

    await expect(
      provider.create({ title: 'Mirror', body: 'Body', labels: [], id: '108' }),
    ).rejects.toThrow(/already exists.*pick another identifier/s);
  });

  it('refuses to overwrite an existing issue when a collision is detected', async () => {
    await writeIssue('7', '# Existing\n\nBody\n');
    vi.spyOn(provider, 'allocateNumber').mockResolvedValue(7);

    await expect(provider.create({ title: 'Clash', body: 'Body', labels: [] })).rejects.toThrow(
      /already exists.*pick another identifier/s,
    );

    const untouched = await readFile((await paths('7')).issueFile, 'utf-8');
    expect(untouched).toBe('# Existing\n\nBody\n');
  });
});

describe('close', () => {
  it('marks the issue closed and refreshes updatedAt', async () => {
    await writeIssue('23', '# Title\n\nBody\n', metadata());

    await provider.close('23');

    const stored = await readMetadata('23');
    expect(stored.state).toBe('closed');
    expect(stored.updatedAt).not.toBe('2026-08-02T11:00:00Z');
    expect(stored.createdAt).toBe('2026-08-01T10:00:00Z');
    expect(await provider.get('23')).toMatchObject({ state: 'closed' });
  });

  it('preserves the remote pointer', async () => {
    const remote = {
      provider: 'github' as const,
      ref: 'https://github.com/acme/repo/issues/23',
      syncedAt: '2026-08-02T11:00:00Z',
      syncedContentHash: hashIssueContent('Title', 'Body'),
    };
    await writeIssue('23', '# Title\n\nBody\n', metadata({ remote }));

    await provider.close('23');

    expect((await readMetadata('23')).remote).toEqual(remote);
  });

  it('writes metadata.json for an issue that had none', async () => {
    await writeIssue('42', '# Local only\n\nBody\n');

    await provider.close('42');

    expect(await readMetadata('42')).toMatchObject({
      schemaVersion: 1,
      id: '42',
      number: 42,
      state: 'closed',
      title: 'Local only',
    });
  });

  it('throws citing the resolved directory when the issue does not exist', async () => {
    const { issueDir } = await paths('999');

    await expect(provider.close('999')).rejects.toThrow(`not found at ${issueDir}`);
  });
});

describe('isAvailable', () => {
  it('is true for a brand new project, without creating the storage directory', async () => {
    const { projectDir } = await resolveProjectPaths({ projectRoot: root });
    expect(await exists(projectDir)).toBe(false);

    expect(await provider.isAvailable()).toBe(true);
    // A mere availability check must not litter `~/.issue-flow` with an empty
    // directory for a project that never goes on to read or write a local
    // issue — every other source is probed on every resolution, so this runs
    // far more often than the provider is actually used.
    expect(await exists(projectDir)).toBe(false);
  });

  it('is true once the project storage directory already exists and is writable', async () => {
    const { projectDir } = await resolveProjectPaths({ projectRoot: root });
    await mkdir(projectDir, { recursive: true });

    expect(await provider.isAvailable()).toBe(true);
  });

  it('is false when the global storage directory cannot be created', async () => {
    const blocker = join(root, 'not-a-directory');
    await writeFile(blocker, 'x', 'utf-8');
    process.env[GLOBAL_ROOT_ENV] = join(blocker, 'home');
    resetStorageResolutionCache();

    expect(await new LocalFileIssueProvider(root).isAvailable()).toBe(false);
  });
});

it('allocates locally without probing GitHub when localOnly is explicit', async () => {
  mockRun.mockClear();
  await provider.create({ title: 'Local demand', body: 'Body', labels: [] }, { localOnly: true });
  expect(mockRun.mock.calls.filter(([cmd]) => cmd === 'gh')).toEqual([]);
});
