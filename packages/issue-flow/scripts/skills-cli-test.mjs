import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkArtifactCli } from './artifacts-cli-test.mjs';
import { artifactRoot, files, packageRoot, repoRoot } from './skills-build.mjs';

// Exercise the actual npm payload, with neither Skill source nor installed Skills.
const root = await mkdtemp(join(tmpdir(), 'issue-flow-cli-package-'));
try {
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], {
      cwd: packageRoot,
      encoding: 'utf8',
    }),
  )[0];
  assert.ok(packed.files.some((f) => f.path === 'dist/cli.js'));
  assert.ok(packed.files.some((f) => f.path === 'prompts/pr-review.md'));
  assert.ok(
    !packed.files.some((f) => /^(skills|skills-src|src|scripts|evals|prompts-src)\//.test(f.path)),
  );
  const packageManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const installDocs = [
    join(repoRoot, 'README.md'),
    join(repoRoot, 'docs/cli.md'),
    join(packageRoot, 'README.md'),
  ];
  for (const path of installDocs) {
    const documentation = await readFile(path, 'utf8');
    assert.match(documentation, /npm install -g issue-flow/);
    assert.ok(
      !documentation
        .split('\n')
        .some((line) => /^\s*npm (?:i|install) -g fabioassuncao\/issue-flow\s*$/.test(line)),
    );
  }
  const globalPrefix = join(root, 'global');
  execFileSync(
    'npm',
    [
      'install',
      '--global',
      '--prefix',
      globalPrefix,
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(root, packed.filename),
    ],
    { encoding: 'utf8', timeout: 120000 },
  );
  const globalBin =
    process.platform === 'win32'
      ? join(globalPrefix, 'issue-flow.cmd')
      : join(globalPrefix, 'bin/issue-flow');
  assert.equal(
    execFileSync(globalBin, ['--version'], { encoding: 'utf8' }).trim(),
    packageManifest.version,
  );
  const runtime = join(root, 'runtime');
  await mkdir(runtime);
  await writeFile(join(runtime, 'package.json'), '{"private":true}');
  execFileSync(
    'npm',
    [
      'install',
      '--prefix',
      runtime,
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(root, packed.filename),
    ],
    { encoding: 'utf8', timeout: 120000 },
  );
  const installed = join(runtime, 'node_modules/issue-flow');
  const cli = join(installed, 'dist/cli.js');
  await checkArtifactCli(cli, root);
  const env = { ...process.env, ISSUE_FLOW_HOME: join(root, 'state'), NO_COLOR: '1' };
  assert.match(
    execFileSync(process.execPath, [cli, '--help'], { env, encoding: 'utf8' }),
    /Usage: issue-flow/,
  );
  const project = join(root, 'project');
  await mkdir(project);
  execFileSync('git', ['init', '-q', project]);
  await writeFile(
    join(project, '.issue-flow.json'),
    JSON.stringify({
      policy: {
        discovery: { labels: false, issueTypes: false, organizationTemplates: false },
        pullRequests: { baseBranch: 'develop' },
      },
    }),
  );
  const policy = JSON.parse(
    execFileSync(process.execPath, [cli, 'policy', '--json'], {
      cwd: project,
      env,
      encoding: 'utf8',
    }),
  );
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.pullRequests.baseBranch, 'develop');
  // Now add one copied Skill: its optional integration must consume the packed CLI.
  const skill = join(root, 'analyze-issue');
  await cp(join(artifactRoot, 'analyze-issue'), skill, { recursive: true });
  const integrated = JSON.parse(
    execFileSync(process.execPath, [join(skill, 'scripts/optional-cli.mjs'), 'policy'], {
      cwd: project,
      env: { ...env, PATH: `${join(runtime, 'node_modules/.bin')}:${process.env.PATH}` },
      encoding: 'utf8',
    }),
  );
  assert.equal(integrated.pullRequests.baseBranch, 'develop');
  await rm(skill, { recursive: true });
  // Reuse the existing complete-pipeline fixtures against the installed binary.
  await mkdir(join(installed, 'scripts'));
  await cp(
    join(packageRoot, 'scripts/smoke-issue-providers.sh'),
    join(installed, 'scripts/smoke-issue-providers.sh'),
  );
  const smoke = execFileSync('bash', [join(installed, 'scripts/smoke-issue-providers.sh')], {
    cwd: project,
    env,
    encoding: 'utf8',
    timeout: 180000,
  });
  console.log(smoke);
  for (const path of await files(join(installed, 'prompts')))
    assert.ok(
      !(await readFile(join(installed, 'prompts', path), 'utf8')).includes('<!-- contract:'),
    );
  console.log(
    'PASS: global-prefix install, packed CLI alone, full pipeline fixtures, packaged prompts, and optional Skill + CLI policy integration.',
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
