import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { artifactRoot, files, packageRoot, sourceRoot } from './skills-build.mjs';
import { validateSkill } from './skills-check.mjs';

const cli = join(packageRoot, 'node_modules/skills/bin/cli.mjs');
const root = await mkdtemp(join(tmpdir(), 'issue-flow-install-'));
const names = Object.keys(
  JSON.parse(await readFile(join(sourceRoot, 'manifest.json'), 'utf8')).skills,
).sort();
const results = [];
function invoke(cwd, args) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 90000,
    env: { ...process.env, DISABLE_TELEMETRY: '1', CI: '1' },
  });
}
async function verify(path, expected) {
  const actual = (await readdir(path)).sort();
  assert.deepEqual(actual, [...expected].sort());
  for (const name of expected) {
    const dir = await realpath(join(path, name));
    assert.deepEqual(await validateSkill(dir), []);
    const sourceFiles = await files(join(artifactRoot, name));
    assert.deepEqual(await files(dir), sourceFiles);
    for (const file of sourceFiles)
      assert.deepEqual(
        await readFile(join(dir, file)),
        await readFile(join(artifactRoot, name, file)),
      );
  }
}
try {
  // A Git checkout containing only the distribution, not source/build dependencies.
  const gitSource = join(root, 'source');
  await cp(artifactRoot, join(gitSource, 'skills'), { recursive: true });
  execFileSync('git', ['init', '-q', gitSource]);
  execFileSync('git', ['-C', gitSource, 'add', 'skills']);
  execFileSync('git', [
    '-C',
    gitSource,
    '-c',
    'user.name=Skill Test',
    '-c',
    'user.email=skills@example.invalid',
    'commit',
    '-qm',
    'distribution fixture',
  ]);
  const discovery = stripVTControlCharacters(invoke(root, ['add', gitSource, '--list']));
  for (const name of names) assert.ok(discovery.includes(name));
  assert.ok(discovery.includes(`Found ${names.length} skills`));
  results.push({ scenario: 'discovery', status: 'PASS', count: names.length });

  for (const name of names) {
    const project = join(root, name);
    await mkdir(project);
    invoke(project, [
      'add',
      join(gitSource, 'skills', name),
      '--skill',
      name,
      '-a',
      'codex',
      '--copy',
      '-y',
    ]);
    await verify(join(project, '.agents/skills'), [name]);
  }
  results.push({
    scenario: 'individual direct paths, copied resources',
    status: 'PASS',
    count: names.length,
  });

  for (const mode of ['copy', 'symlink']) {
    const project = join(root, mode);
    await mkdir(project);
    invoke(project, [
      'add',
      gitSource,
      '--skill',
      '*',
      '-a',
      'claude-code',
      'codex',
      'opencode',
      '-y',
      ...(mode === 'copy' ? ['--copy'] : []),
    ]);
    for (const dir of ['.claude/skills', '.agents/skills']) await verify(join(project, dir), names);
    const listed = invoke(project, ['list', '--json']);
    for (const name of names) assert.ok(listed.includes(name));
    results.push({
      scenario: `all Skills, ${mode}, Claude/Codex/OpenCode and list`,
      status: 'PASS',
    });
  }
  const subset = join(root, 'subset');
  await mkdir(subset);
  invoke(subset, [
    'add',
    gitSource,
    '--skill',
    'analyze-issue',
    'review-pr',
    '-a',
    'codex',
    '--copy',
    '-y',
    '--full-depth',
  ]);
  await verify(join(subset, '.agents/skills'), ['analyze-issue', 'review-pr']);
  results.push({ scenario: 'subset and recursive discovery', status: 'PASS' });

  // A URL takes the installer's real Git-clone path, unlike a local directory.
  const gitProject = join(root, 'git-url');
  await mkdir(gitProject);
  const gitUrl = pathToFileURL(gitSource).href;
  invoke(gitProject, ['add', gitUrl, '--skill', '*', '-a', 'codex', '--copy', '-y']);
  await verify(join(gitProject, '.agents/skills'), names);
  results.push({ scenario: 'Git URL clone, discovery and complete artifacts', status: 'PASS' });

  const revisionFile = 'skills/review-issue/references/revision-fixture.txt';
  await writeFile(join(gitSource, revisionFile), 'second fixture revision\n');
  execFileSync('git', ['-C', gitSource, 'add', revisionFile]);
  execFileSync('git', [
    '-C',
    gitSource,
    '-c',
    'user.name=Skill Test',
    '-c',
    'user.email=skills@example.invalid',
    'commit',
    '-qm',
    'update fixture',
  ]);
  let gitUpdate;
  let gitUpdateExit = 0;
  try {
    gitUpdate = invoke(gitProject, ['update', '-p', '-y']);
  } catch (error) {
    gitUpdate = error.stdout ?? error.message;
    gitUpdateExit = error.status;
  }
  results.push({
    scenario: 'Git URL update invocation',
    exitCode: gitUpdateExit,
    status: 'OBSERVED',
    output: stripVTControlCharacters(gitUpdate).trim(),
  });
  invoke(gitProject, ['add', gitUrl, '--skill', 'review-issue', '-a', 'codex', '--copy', '-y']);
  assert.equal(
    await readFile(
      join(gitProject, '.agents/skills/review-issue/references/revision-fixture.txt'),
      'utf8',
    ),
    'second fixture revision\n',
  );
  assert.deepEqual(await validateSkill(join(gitProject, '.agents/skills/review-issue')), []);
  results.push({ scenario: 'Git revision refresh through add', status: 'PASS' });

  if (process.argv.includes('--global-container')) {
    const out = join(root, 'container');
    await mkdir(out);
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${artifactRoot}:/source:ro`,
        '-v',
        `${out}:/out`,
        'node:24.20.0-alpine',
        'sh',
        '-c',
        "npm exec --yes --package=skills@1.5.23 -- skills add /source --skill '*' -a codex -g --copy -y && npm exec --yes --package=skills@1.5.23 -- skills list -g --json > /out/list.json && cp -R /root/.agents/skills /out/global",
      ],
      { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await verify(join(out, 'global'), names);
    results.push({ scenario: 'global install/list in disposable user container', status: 'PASS' });
  } else
    results.push({
      scenario: 'global installation',
      status: 'NOT_RUN',
      reason: 'Use --global-container to avoid changing personal agent installations.',
    });

  // Updates of a local-path source are not remote-update evidence.
  const update = invoke(subset, ['update', '-p', '-y']);
  results.push({
    scenario: 'local update invocation',
    status: 'OBSERVED',
    output: stripVTControlCharacters(update).trim(),
    limitation:
      'GitHub update of the new artifacts requires this revision to be published. Local-source update is not a remote lifecycle test.',
  });
  console.log(JSON.stringify({ installer: '1.5.23', results }, null, 2));
  const outputArg = process.argv.indexOf('--output');
  if (outputArg !== -1)
    await writeFile(
      process.argv[outputArg + 1],
      `${JSON.stringify({ installer: '1.5.23', results }, null, 2)}\n`,
    );
} finally {
  await rm(root, { recursive: true, force: true });
}
