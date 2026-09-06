// Development-only Git fixtures and observations. Never shipped with a Skill.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { contained } from './skills-build.mjs';

function git(root, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Skill Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Skill Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export function validateFixturePath(path) {
  assert.ok(typeof path === 'string' && path.length > 0);
  assert.ok(contained('/fixture', resolve('/fixture', path)), `Escaping fixture ${path}`);
  assert.ok(
    !path.split(/[/\\]/).some((part) => part.toLowerCase() === '.git'),
    'Git internals are not fixture files',
  );
}

function validateBranch(branch) {
  assert.equal(typeof branch, 'string');
  assert.ok(branch.length > 0 && !branch.startsWith('-'));
  git(process.cwd(), ['check-ref-format', '--branch', branch]);
}

export function validateGitFixture(config) {
  if (!config) return;
  assert.equal(typeof config, 'object');
  assert.ok(!Array.isArray(config));
  for (const key of ['branches', 'history'])
    if (config[key] !== undefined) assert.ok(Array.isArray(config[key]));
  if (config.dirty !== undefined)
    assert.ok(
      config.dirty !== null && typeof config.dirty === 'object' && !Array.isArray(config.dirty),
    );
  assert.ok(
    Object.keys(config).every((key) =>
      ['initialBranch', 'branches', 'detached', 'history', 'dirty'].includes(key),
    ),
  );
  validateBranch(config.initialBranch ?? 'main');
  for (const branch of config.branches ?? []) validateBranch(branch);
  if (config.detached !== undefined) assert.equal(typeof config.detached, 'boolean');
  for (const message of config.history ?? [])
    assert.ok(typeof message === 'string' && message.trim());
  for (const [path, value] of Object.entries(config.dirty ?? {})) {
    validateFixturePath(path);
    assert.equal(typeof value, 'string');
  }
}

export function validateGitAssertion(rule) {
  const keys = [
    'branch',
    'branches',
    'commitCount',
    'commitPattern',
    'unchangedRefs',
    'commitsOnBranch',
  ];
  assert.ok(Object.keys(rule).every((key) => key === 'target' || keys.includes(key)));
  assert.ok(
    keys.some((key) => rule[key] !== undefined),
    'Git assertion needs an expectation',
  );
  if (rule.branch !== undefined && rule.branch !== '') validateBranch(rule.branch);
  if (rule.commitsOnBranch !== undefined) validateBranch(rule.commitsOnBranch);
  for (const name of ['branches', 'unchangedRefs']) {
    if (rule[name] !== undefined) assert.ok(Array.isArray(rule[name]));
    for (const branch of rule[name] ?? []) validateBranch(branch);
  }
  if (rule.commitCount !== undefined)
    assert.ok(Number.isInteger(rule.commitCount) && rule.commitCount >= 0);
  if (rule.commitPattern !== undefined) {
    assert.equal(typeof rule.commitPattern, 'string');
    new RegExp(rule.commitPattern);
  }
}

export function gitSnapshot(root) {
  const rows = git(root, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'])
    .split('\n')
    .filter(Boolean);
  return {
    head: git(root, ['rev-parse', 'HEAD']),
    branch: git(root, ['branch', '--show-current']),
    refs: Object.fromEntries(rows.map((row) => row.split(' '))),
  };
}

export async function prepareGitFixture(root, scenario) {
  validateGitFixture(scenario.git);
  const config = scenario.git ?? {};
  git(root, ['init', '-q', '--initial-branch', config.initialBranch ?? 'main']);
  git(root, ['config', '--local', 'user.name', 'Skill Fixture']);
  git(root, ['config', '--local', 'user.email', 'fixture@example.invalid']);
  git(root, ['config', '--local', 'commit.gpgsign', 'false']);
  // Installed Skills are outside the fixture's source history.
  for (const [path, content] of Object.entries(scenario.fixture ?? {})) {
    validateFixturePath(path);
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
    git(root, ['add', '--', path]);
  }
  git(root, ['commit', '-q', '--allow-empty', '-m', 'Fixture baseline']);
  for (const message of config.history ?? [])
    git(root, ['commit', '-q', '--allow-empty', '-m', message]);
  for (const branch of config.branches ?? []) git(root, ['branch', branch]);
  if (config.detached) git(root, ['checkout', '-q', '--detach']);
  for (const [path, content] of Object.entries(config.dirty ?? {})) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  // Prevent installed resources from making an otherwise clean fixture dirty.
  await writeFile(join(root, '.git/info/exclude'), '.agents/\n.claude/\n');
  return gitSnapshot(root);
}

export function gradeGit(root, rule, baseline) {
  if (!baseline) return ['Git baseline missing'];
  const state = gitSnapshot(root);
  const failures = [];
  const revisions = git(root, [
    'rev-list',
    '--all',
    'HEAD',
    '--not',
    ...new Set([baseline.head, ...Object.values(baseline.refs)]),
  ])
    .split('\n')
    .filter(Boolean);
  if (rule.branch !== undefined && state.branch !== rule.branch)
    failures.push(`Git branch: expected ${rule.branch}, got ${state.branch || 'detached HEAD'}`);
  if (
    rule.branches &&
    JSON.stringify(Object.keys(state.refs).sort()) !== JSON.stringify([...rule.branches].sort())
  )
    failures.push('Git branch set differs');
  if (rule.commitCount !== undefined && revisions.length !== rule.commitCount)
    failures.push(`Git new commits: expected ${rule.commitCount}, got ${revisions.length}`);
  for (const branch of rule.unchangedRefs ?? []) {
    if (!baseline.refs[branch] || state.refs[branch] !== baseline.refs[branch])
      failures.push(`Git ref changed: ${branch}`);
  }
  if (rule.commitPattern !== undefined) {
    const pattern = new RegExp(rule.commitPattern, 'm');
    if (!revisions.length) failures.push('Expected new commit messages, found none');
    for (const sha of revisions) {
      if (!pattern.test(git(root, ['show', '-s', '--format=%B', sha])))
        failures.push(`Commit convention mismatch: ${sha}`);
    }
  }
  if (rule.commitsOnBranch) {
    const head = state.refs[rule.commitsOnBranch];
    if (!head || !revisions.length) failures.push(`No new commits on ${rule.commitsOnBranch}`);
    else {
      const reachable = new Set(git(root, ['rev-list', head]).split('\n'));
      if (revisions.some((sha) => !reachable.has(sha)))
        failures.push(`New commits outside ${rule.commitsOnBranch}`);
    }
  }
  return failures;
}
