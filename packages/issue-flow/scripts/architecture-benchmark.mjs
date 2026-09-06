import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactRoot, files, repoRoot } from './skills-build.mjs';

// Static text proxy, not tokenizer usage or an end-to-end latency claim.
const estimate = (text) => Math.ceil(text.length / 4);
const baseline = process.argv[2] ?? 'ebb7124';
const before = (path) =>
  execFileSync('git', ['show', `${baseline}:${path}`], { cwd: repoRoot, encoding: 'utf8' });
const report = {
  schemaVersion: 1,
  baseline,
  measurement: 'estimated tokens = ceil(characters / 4); no model invocation',
  skills: [],
  prompts: [],
  projection: null,
};
const manifest = JSON.parse(await readFile(join(repoRoot, 'skills-src/manifest.json'), 'utf8'));
for (const name of Object.keys(manifest.skills)) {
  const paths = (await files(join(artifactRoot, name))).filter((path) => path.endsWith('.md'));
  const entry = `skills/${name}/SKILL.md`;
  report.skills.push({
    name,
    entryBefore: estimate(before(entry)),
    entryAfter: estimate(await readFile(join(repoRoot, entry), 'utf8')),
    allMarkdownBefore: estimate(paths.map((path) => before(`skills/${name}/${path}`)).join('\n')),
    allMarkdownAfter: estimate(
      (
        await Promise.all(paths.map((path) => readFile(join(artifactRoot, name, path), 'utf8')))
      ).join('\n'),
    ),
  });
}
for (const name of await files(join(repoRoot, 'packages/issue-flow/prompts'))) {
  const path = `packages/issue-flow/prompts/${name}`;
  report.prompts.push({
    name,
    before: estimate(before(path)),
    after: estimate(await readFile(join(repoRoot, path), 'utf8')),
  });
}
const root = await mkdtemp(join(tmpdir(), 'if-benchmark-'));
try {
  const guide = await readFile(
    join(artifactRoot, 'execute-tasks/references/plan-format.md'),
    'utf8',
  );
  const plan = JSON.parse(guide.match(/```json\n([\s\S]*?)\n```/)[1]);
  plan.userStories = Array.from({ length: 20 }, (_, index) => ({
    ...plan.userStories[0],
    id: `US-${String(index + 1).padStart(3, '0')}`,
    description: `Implement capability ${index + 1}. ${'Context relevant only to this capability. '.repeat(12)}`,
    priority: index + 1,
    dependencies: index ? [`US-${String(index).padStart(3, '0')}`] : [],
  }));
  const path = join(root, 'tasks.json');
  const text = JSON.stringify(plan, null, 2);
  await writeFile(path, text);
  const result = spawnSync(
    process.execPath,
    [join(artifactRoot, 'execute-tasks/scripts/artifacts.mjs'), 'plan', path, '--json'],
    { encoding: 'utf8', timeout: 10000 },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  report.projection = {
    stories: 20,
    fullPlanEstimatedTokens: estimate(text),
    inspectionEstimatedTokens: estimate(result.stdout),
    reductionPercent: Math.round(100 * (1 - result.stdout.length / text.length)),
    callsBefore: 1,
    callsAfter: 1,
    caveat:
      'Only the discovery projection; implementation may still require PRD, code, evidence and source-plan edits.',
  };
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify(report, null, 2));
