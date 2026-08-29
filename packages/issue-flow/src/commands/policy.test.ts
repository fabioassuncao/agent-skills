import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPolicyCliOverrides } from '../config.js';
import { POLICY_SCHEMA_VERSION, resetPolicyCache } from '../policy/index.js';
import { runPolicy } from './policy.js';

// The command resolves the repository from git, and reads labels via gh. Both
// are faked here so the suite exercises the command rather than the machine.
vi.mock('../utils/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/git.js')>();
  return { ...actual, getProjectRoot: vi.fn(async () => root) };
});

vi.mock('../utils/shell.js', () => ({
  run: vi.fn(async () => ({ stdout: '', stderr: 'command not found', exitCode: 127 })),
}));

let root: string;
let logged: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'issue-flow-policy-cmd-'));
  logged = [];
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
    logged.push(String(line ?? ''));
  });
  setPolicyCliOverrides({});
  resetPolicyCache();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function write(relPath: string, content: string): Promise<void> {
  const filePath = join(root, relPath);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

describe('runPolicy', () => {
  it('succeeds on a repository that declares nothing', async () => {
    expect(await runPolicy()).toBe(0);
    expect(logged.join('\n')).toContain('Scope:      (root)');
  });

  it('names the file every value came from', async () => {
    await write('.github/ISSUE_TEMPLATE/bug.yml', 'name: Bug\nlabels: ["bug"]\ntype: Bug');
    await write('AGENTS.md', '# Agents');

    expect(await runPolicy()).toBe(0);

    const output = logged.join('\n');
    expect(output).toContain('.github/ISSUE_TEMPLATE/bug.yml (form, filesystem) type=Bug');
    expect(output).toContain('AGENTS.md (agents, scope=root)');
    expect(output).toContain('Sources');
  });

  it('never prints document content in the human view', async () => {
    await write('AGENTS.md', 'SECRET_MARKER_IN_BODY');

    await runPolicy();

    expect(logged.join('\n')).not.toContain('SECRET_MARKER_IN_BODY');
  });

  it('emits versioned JSON carrying the content the skills need', async () => {
    await write('AGENTS.md', '# Agents\n\nRules live here.');

    expect(await runPolicy({ json: true })).toBe(0);

    const payload = JSON.parse(logged.join('\n')) as Record<string, unknown>;
    expect(payload.schemaVersion).toBe(POLICY_SCHEMA_VERSION);
    expect(payload).toMatchObject({
      root,
      scope: null,
      enabled: true,
      codeowners: null,
      docs: [
        expect.objectContaining({ path: 'AGENTS.md', content: '# Agents\n\nRules live here.' }),
      ],
    });
    expect(Array.isArray(payload.sources)).toBe(true);
  });

  it('resolves the scope given on the command line', async () => {
    await write('AGENTS.md', '# Root');
    await write('apps/api/AGENTS.md', '# API');

    await runPolicy({ scope: 'apps/api', json: true });

    const payload = JSON.parse(logged.join('\n')) as {
      scope: string;
      docs: { path: string }[];
    };
    expect(payload.scope).toBe('apps/api');
    expect(payload.docs.map((doc) => doc.path)).toEqual(['AGENTS.md', 'apps/api/AGENTS.md']);
  });

  it('reports the sources it could not consult instead of pretending completeness', async () => {
    await runPolicy();

    expect(logged.join('\n')).toContain('could not be consulted');
  });
});
