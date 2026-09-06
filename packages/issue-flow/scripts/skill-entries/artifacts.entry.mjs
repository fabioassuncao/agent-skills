import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspectArtifact } from '../../src/core/artifact-files.ts';
import { resolveIssueArtifactPaths } from '../../src/storage/artifact-paths.ts';
import {
  directoryExists,
  ensureWorkspaceStorageIgnored,
  selectArtifactStorage,
  WORKSPACE_STORAGE_DIR,
} from '../../src/storage/artifact-storage.ts';
import { normalizeRemoteUrl, projectIdFromRemote } from '../../src/storage/project-identity.ts';

function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

async function resolveArtifacts(issueId) {
  const projectRoot = git(['rev-parse', '--show-toplevel'], process.cwd());
  if (!projectRoot) throw new Error('Not inside a Git repository');
  const remote = normalizeRemoteUrl(git(['remote', 'get-url', 'origin'], projectRoot));
  const projectId = projectIdFromRemote(remote, projectRoot);
  const globalRoot = resolve(process.env.ISSUE_FLOW_HOME?.trim() || join(homedir(), '.issue-flow'));
  const selected = selectArtifactStorage(
    projectRoot,
    globalRoot,
    projectId,
    await directoryExists(join(projectRoot, WORKSPACE_STORAGE_DIR, 'issues')),
  );
  if (selected.storageMode === 'workspace') await ensureWorkspaceStorageIgnored(projectRoot);
  return {
    ...selected,
    projectId,
    issuesDir: join(selected.projectDir, 'issues'),
    paths: resolveIssueArtifactPaths(selected.projectDir, issueId),
  };
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const context = args.includes('--context');
const positional = args.filter((arg) => arg !== '--json' && arg !== '--context');
if (positional[0] === '--help') {
  console.log(
    'resolve <id>: return the active CLI/Skill artifact paths. prepare <id>: create its directory. reconcile <id>: validate a Skill-updated tasks.json for the next CLI import. issue <issue.md> [metadata.json]: parse/hash and validate metadata. plan <tasks.json>: validate schema and dependencies. Add --json for versioned output; plan --context selects current execution facts.',
  );
} else {
  const [operation, path, metadata] = positional;
  let result;
  if (['resolve', 'prepare', 'reconcile'].includes(operation)) {
    try {
      if (!path || metadata || positional.length !== 2 || context)
        throw new Error('Expected one issue id');
      const project = await resolveArtifacts(path);
      const { paths } = project;
      if (operation === 'prepare') await mkdir(paths.issueDir, { recursive: true });
      if (operation === 'reconcile') {
        const inspected = await inspectArtifact('plan', paths.tasksFile);
        if (!inspected.ok) result = inspected;
      }
      result ??= {
        schemaVersion: 1,
        ok: true,
        data: {
          storageMode: project.storageMode,
          projectId: project.projectId,
          projectDir: project.projectDir,
          issuesDir: project.issuesDir,
          paths,
        },
        errors: [],
      };
    } catch (error) {
      result = {
        schemaVersion: 1,
        ok: false,
        data: null,
        errors: [
          {
            code: 'artifact_storage',
            path: path ?? '',
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  } else {
    result =
      positional.length > 3 || (context && operation !== 'plan')
        ? {
            schemaVersion: 1,
            ok: false,
            data: null,
            errors: [{ code: 'arguments', path: '', message: 'Invalid arguments' }],
          }
        : await inspectArtifact(context ? 'context' : operation, path, metadata);
  }
  if (json || context) console.log(JSON.stringify(result));
  else if (!result.ok) console.error(result.errors.map((error) => error.message).join('\n'));
  else if (operation === 'plan')
    console.log(JSON.stringify({ valid: true, stories: result.data.counts.total }));
  else console.log(JSON.stringify(result.data));
  process.exitCode = result.ok ? 0 : 1;
}
