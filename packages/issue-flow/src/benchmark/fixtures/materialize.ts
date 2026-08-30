import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ISSUES_DIR_NAME } from '../../storage/paths.js';
import { run } from '../../utils/shell.js';
import type { AcceptanceCheck } from '../../verify/types.js';
import type { CorpusTask } from '../corpus.js';
import { CORPUS } from '../corpus.js';
import { templateFor } from './templates.js';

export interface FixtureHandle {
  root: string;
  issueRef: string;
  expectedVerification: AcceptanceCheck[];
  seed: number;
  task: CorpusTask['id'];
  dispose(): Promise<void>;
}

const GIT_IDENT = ['-c', 'user.name=issue-flow-bench', '-c', 'user.email=bench@issue-flow.test'];

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await run('git', args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr || result.stdout}`,
    );
  }
}

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf-8');
  }
}

async function writeLocalIssue(root: string, title: string, body: string): Promise<void> {
  const issueDir = join(root, ISSUES_DIR_NAME, '1');
  await mkdir(issueDir, { recursive: true });
  await writeFile(join(issueDir, 'issue.md'), `# ${title}\n\n${body.trim()}\n`, 'utf-8');
  await writeFile(
    join(issueDir, 'metadata.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: '1',
        number: 1,
        source: 'local',
        title,
        labels: ['bench'],
        state: 'open',
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:00.000Z',
        contentHash: 'sha256:fixture',
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );
}

/**
 * Materialize a disposable git repository for one corpus class and one seed.
 * A new call always starts from the same unfinished state — never from the
 * work of a previous repetition.
 */
export async function materialize(task: CorpusTask, seed: number): Promise<FixtureHandle> {
  const root = await mkdtemp(join(tmpdir(), `issue-flow-bench-${task.id}-${seed}-`));
  const template = templateFor(task.id, seed);
  await writeTree(root, template.files);
  await writeLocalIssue(root, template.issueTitle, template.issueBody);

  // An empty template skips sample hooks. Some sandboxes forbid writing
  // executable files under `.git/hooks/`.
  await git(root, ['-c', 'init.templateDir=', 'init']);
  await git(root, ['add', '.']);
  await git(root, [...GIT_IDENT, 'commit', '-m', `fixture ${task.id} seed=${seed}`]);

  return {
    root,
    issueRef: '1',
    expectedVerification: template.expectedVerification,
    seed,
    task: task.id,
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function corpusTask(id: CorpusTask['id']): CorpusTask {
  const task = CORPUS.find((entry) => entry.id === id);
  if (!task) throw new Error(`Unknown corpus class: ${id}`);
  return task;
}
