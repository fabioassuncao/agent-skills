import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactRoot } from './skills-build.mjs';

/** Real stdout/exit-code contract, exercised against the installed npm payload. */
export async function checkArtifactCli(cli, root) {
  const cwd = join(root, 'inspection');
  await mkdir(cwd);
  const env = { ...process.env, HOME: cwd, ISSUE_FLOW_HOME: join(cwd, 'state'), NO_COLOR: '1' };
  const run = (args, binary = cli) =>
    spawnSync(process.execPath, [binary, ...args], { cwd, env, encoding: 'utf8', timeout: 10000 });
  const guide = await readFile(
    join(artifactRoot, 'execute-tasks/references/plan-format.md'),
    'utf8',
  );
  const plan = JSON.parse(guide.match(/```json\n([\s\S]*?)\n```/)[1]);
  const file = join(cwd, 'tasks.json');
  const original = JSON.stringify({ ...plan, unknownConsumerField: 'keep' });
  await writeFile(file, original);
  const result = run(['artifacts', 'plan', file, '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
  const portable = run(
    ['plan', file, '--json'],
    join(artifactRoot, 'execute-tasks/scripts/artifacts.mjs'),
  );
  assert.equal(portable.status, 0, portable.stderr);
  assert.deepEqual(JSON.parse(result.stdout), JSON.parse(portable.stdout));
  const context = run(['artifacts', 'plan', file, '--context', '--json']);
  const portableContext = run(
    ['plan', file, '--context', '--json'],
    join(artifactRoot, 'execute-tasks/scripts/artifacts.mjs'),
  );
  assert.equal(context.status, 0, context.stderr);
  assert.equal(portableContext.status, 0, portableContext.stderr);
  assert.deepEqual(JSON.parse(context.stdout), JSON.parse(portableContext.stdout));
  assert.deepEqual(
    JSON.parse(context.stdout).data.activeStory.acceptanceCriteria,
    plan.userStories[0].acceptanceCriteria,
  );
  assert.equal(await readFile(file, 'utf8'), original);
  assert.deepEqual(await readdir(cwd), ['tasks.json']); // no repository/storage initialization
  for (const args of [
    ['plan'],
    ['plan', 'missing.json'],
    ['plan', file, 'extra'],
    ['plan', file, '--unknown'],
    ['unknown'],
  ]) {
    const failure = run(['artifacts', ...args, '--json']);
    assert.equal(failure.status, 1, failure.stderr);
    assert.deepEqual(Object.keys(JSON.parse(failure.stdout)).sort(), [
      'data',
      'errors',
      'ok',
      'schemaVersion',
    ]);
    assert.equal(JSON.parse(failure.stdout).ok, false);
  }
  const status = run(['status', '--json']);
  assert.equal(status.status, 1);
  assert.equal(JSON.parse(status.stdout).error.code, 'project_unavailable');
  // A malformed configuration emits diagnostics on stderr, leaving stdout JSON.
  assert.equal(spawnSync('git', ['init', '-q'], { cwd }).status, 0);
  await writeFile(join(cwd, '.issue-flow.json'), '{');
  const configured = run(['status', '--json']);
  assert.equal(configured.status, 0, configured.stderr);
  assert.equal(JSON.parse(configured.stdout).schemaVersion, 1);
  assert.match(configured.stderr, /config|json/i);
}
