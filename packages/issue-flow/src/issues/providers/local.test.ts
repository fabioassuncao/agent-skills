import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** gh is unreachable unless a test says otherwise. */
function ghUnavailable(): void {
  mockRun.mockRejectedValue(new Error('spawn gh ENOENT'));
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
let provider: InstanceType<typeof LocalFileIssueProvider>;

async function writeIssue(id: string, markdown: string, meta?: IssueMetadata | string) {
  const dir = join(root, 'issues', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'issue.md'), markdown, 'utf-8');
  if (meta !== undefined) {
    const content = typeof meta === 'string' ? meta : `${JSON.stringify(meta, null, 2)}\n`;
    await writeFile(join(dir, 'metadata.json'), content, 'utf-8');
  }
}

async function readMetadata(id: string): Promise<IssueMetadata> {
  return JSON.parse(await readFile(join(root, 'issues', id, 'metadata.json'), 'utf-8'));
}

beforeEach(async () => {
  mockRun.mockReset();
  ghUnavailable();
  root = await mkdtemp(join(tmpdir(), 'issue-flow-local-provider-'));
  provider = new LocalFileIssueProvider(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
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
    await mkdir(join(root, 'issues', '7'), { recursive: true });

    expect(await provider.get('7')).toBeNull();
  });

  it('throws citing the path and the field when metadata.json breaks the schema', async () => {
    const invalid = { ...metadata(), state: 'archived' };
    await writeIssue('23', '# Title\n\nBody\n', invalid as unknown as IssueMetadata);

    await expect(provider.get('23')).rejects.toThrow(/issues[/\\]23[/\\]metadata\.json/);
    await expect(provider.get('23')).rejects.toThrow(/state/);
  });

  it('throws citing the path when metadata.json is not valid JSON', async () => {
    await writeIssue('23', '# Title\n\nBody\n', '{ not json');

    await expect(provider.get('23')).rejects.toThrow(/Invalid JSON in issues[/\\]23/);
  });

  it('rejects identifiers that would escape the issues directory', async () => {
    await expect(provider.get('../../etc')).rejects.toThrow(/Invalid local issue identifier/);
    await expect(provider.get('   ')).rejects.toThrow(/cannot be empty/);
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

    const markdown = await readFile(join(root, 'issues', '1', 'issue.md'), 'utf-8');
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
    mockRun.mockReset();
    mockRun.mockResolvedValue(result({ stdout: JSON.stringify([{ number: 108 }]) }));

    expect(await provider.create({ title: 'Next', body: 'Body', labels: [] })).toMatchObject({
      id: '109',
    });
  });

  it('counts pull requests too, since GitHub shares one counter', async () => {
    mockRun.mockReset();
    mockRun.mockImplementation(async (_cmd: string, args: string[] = []) =>
      result({ stdout: JSON.stringify([{ number: args[0] === 'pr' ? 300 : 7 }]) }),
    );

    expect(await provider.create({ title: 'Next', body: 'Body', labels: [] })).toMatchObject({
      id: '301',
    });
  });

  it('ignores an unreachable or failing remote', async () => {
    mockRun.mockReset();
    mockRun.mockResolvedValue(result({ exitCode: 1, stderr: 'no git remote found' }));

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

    const untouched = await readFile(join(root, 'issues', '7', 'issue.md'), 'utf-8');
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

  it('throws when the issue does not exist', async () => {
    await expect(provider.close('999')).rejects.toThrow(/not found/);
  });
});

describe('isAvailable', () => {
  it('is true when the project directory is writable', async () => {
    expect(await provider.isAvailable()).toBe(true);
  });

  it('is false when the project directory is missing', async () => {
    expect(await new LocalFileIssueProvider(join(root, 'nope')).isAvailable()).toBe(false);
  });
});
