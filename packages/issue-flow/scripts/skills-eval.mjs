import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { artifactRoot, contained, files, packageRoot, repoRoot } from './skills-build.mjs';
import { frontmatter } from './skills-check.mjs';
import {
  gitSnapshot,
  gradeGit,
  prepareGitFixture,
  validateFixturePath,
  validateGitAssertion,
  validateGitFixture,
} from './skills-eval-git.mjs';

export const corpusPath = join(repoRoot, 'evals/skills/scenarios.json');
const fixtureRoot = join(repoRoot, 'evals/skills/fixtures');

// References keep shared synthetic capabilities in one source while each run
// still receives a complete isolated copy. No external fixture imports at runtime.
export async function materializeScenario(scenario) {
  const fixture = { ...scenario.fixture };
  for (const [destination, source] of Object.entries(scenario.fixtureFiles ?? {})) {
    validateFixturePath(destination);
    validateFixturePath(source);
    const actual = await realpath(resolve(fixtureRoot, source));
    if (!contained(await realpath(fixtureRoot), actual))
      throw new Error(`Escaping fixture resource: ${source}`);
    if (Object.hasOwn(fixture, destination))
      throw new Error(`Duplicate fixture destination: ${destination}`);
    fixture[destination] = await readFile(actual, 'utf8');
  }
  return { ...scenario, fixture };
}

export function observeLine(line, evidence) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  const model = event.type === 'system' ? event.model : event.message?.model;
  if (typeof model === 'string') evidence.model = model;
  for (const block of event.type === 'assistant' ? (event.message?.content ?? []) : []) {
    if (block.type !== 'tool_use') continue;
    const detail = block.input?.command ?? block.input?.file_path ?? block.input?.skill;
    if (typeof detail === 'string')
      evidence.actions.push({ kind: 'tool', name: block.name, detail });
  }
  if (event.type === 'item.completed' && event.item?.type === 'command_execution')
    evidence.actions.push({
      kind: 'tool',
      name: 'command',
      detail: event.item.command,
      exitCode: event.item.exit_code,
    });
}

export function validateCorpus(corpus, names) {
  assert.equal(corpus.schemaVersion, 1);
  const ids = new Set();
  for (const scenario of corpus.scenarios) {
    assert.ok(!ids.has(scenario.id), `Duplicate scenario ${scenario.id}`);
    ids.add(scenario.id);
    assert.ok(names.includes(scenario.skill));
    assert.ok(['positive', 'negative', 'behavior'].includes(scenario.kind));
    assert.ok(scenario.prompt?.trim());
    const cliFixture = scenario.cliReview ?? scenario.cliExecute;
    assert.ok(!(scenario.cliReview && scenario.cliExecute));
    if (cliFixture) {
      assert.equal(scenario.kind, 'behavior');
      for (const path of [cliFixture.issueFile, cliFixture.tasksFile]) {
        validateFixturePath(path);
        assert.ok(Object.hasOwn(scenario.fixture ?? {}, path));
      }
    }
    assert.ok(scenario.rubric?.length);
    for (const path of Object.keys(scenario.fixture ?? {})) validateFixturePath(path);
    for (const [destination, source] of Object.entries(scenario.fixtureFiles ?? {})) {
      validateFixturePath(destination);
      validateFixturePath(source);
      assert.ok(
        !Object.hasOwn(scenario.fixture ?? {}, destination),
        'Duplicate fixture destination',
      );
    }
    validateGitFixture(scenario.git);
    if (scenario.kind === 'behavior') {
      assert.ok(scenario.assertions?.length);
      for (const rule of scenario.assertions) {
        if (rule.target === 'git') {
          validateGitAssertion(rule);
          continue;
        }
        assert.ok(rule.path || ['answer', 'actions'].includes(rule.target));
        if (rule.path) assert.ok(contained('/fixture', resolve('/fixture', rule.path)));
        if (rule.check === 'issue') {
          assert.equal(typeof rule.metadata, 'string');
          assert.ok(contained('/fixture', resolve('/fixture', rule.metadata)));
        }
        if (rule.check) assert.ok(['plan', 'issue', 'completed-evidence'].includes(rule.check));
        for (const pattern of [rule.pattern, rule.absent]) if (pattern) new RegExp(pattern);
      }
    }
  }
  for (const name of names)
    for (const kind of ['positive', 'negative', 'behavior'])
      assert.ok(
        corpus.scenarios.some((s) => s.skill === name && s.kind === kind),
        `${name}: missing ${kind}`,
      );
}

// Grades only final answers, recorded tool actions and filesystem artifacts. Never reasoning.
export async function grade(scenario, result, root, actions, baseline = null) {
  const failures = [];
  if (scenario.kind !== 'behavior') {
    let selection;
    try {
      selection = JSON.parse(result.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()).skill;
      if (selection !== null && typeof selection !== 'string') throw new Error('Missing selection');
    } catch {
      failures.push('Expected a JSON skill selection');
    }
    if (scenario.kind === 'positive' && selection !== scenario.skill)
      failures.push(`Expected ${scenario.skill}, received ${selection}`);
    if (scenario.kind === 'negative' && selection === scenario.skill)
      failures.push(`Incorrectly selected ${scenario.skill}`);
    const known = JSON.parse(
      await readFile(join(repoRoot, 'skills-src/manifest.json'), 'utf8'),
    ).skills;
    if (typeof selection === 'string' && !Object.hasOwn(known, selection))
      failures.push(`Unknown Skill selection: ${selection}`);
    return failures;
  }
  for (const rule of scenario.assertions) {
    if (rule.target === 'git') {
      failures.push(...gradeGit(root, rule, baseline));
      continue;
    }
    const path = rule.path ? resolve(root, rule.path) : null;
    if (path && !contained(root, path)) throw new Error(`Escaping assertion ${rule.path}`);
    const value =
      rule.target === 'answer'
        ? result
        : rule.target === 'actions'
          ? actions.map((a) => `${a.name} ${a.detail ?? ''}`).join('\n')
          : await readFile(path, 'utf8').catch(() => null);
    if (rule.exists !== undefined && (value !== null) !== rule.exists)
      failures.push(`${rule.path}: expected exists=${rule.exists}`);
    if (rule.pattern && !new RegExp(rule.pattern, 'im').test(value ?? ''))
      failures.push(`Missing ${rule.pattern} in ${rule.target ?? rule.path}`);
    if (rule.absent && new RegExp(rule.absent, 'im').test(value ?? ''))
      failures.push(`Forbidden ${rule.absent} in ${rule.target ?? rule.path}`);
    if (rule.json && value !== null) {
      try {
        JSON.parse(value);
      } catch {
        failures.push(`${rule.path}: invalid JSON`);
      }
    }
    if (
      rule.unchanged &&
      value !== (scenario.git?.dirty?.[rule.path] ?? scenario.fixture?.[rule.path])
    )
      failures.push(`${rule.path}: changed`);
    if (rule.check && value === null) {
      failures.push(`${rule.path}: required artifact missing`);
      continue;
    }
    if (rule.check === 'plan' || rule.check === 'issue') {
      const helper = join(artifactRoot, 'resolve-issue/scripts/artifacts.mjs');
      const args =
        rule.check === 'plan' ? ['plan', path] : ['issue', path, join(root, rule.metadata)];
      const checked = spawnSync(process.execPath, [helper, ...args], {
        encoding: 'utf8',
        timeout: 10000,
      });
      if (checked.status !== 0)
        failures.push(`${rule.path}: canonical validation failed: ${checked.stderr}`);
    }
    if (rule.check === 'completed-evidence') {
      let plan;
      try {
        plan = JSON.parse(value ?? '{}');
      } catch {
        failures.push(`${rule.path}: invalid JSON`);
        continue;
      }
      if (
        plan.userStories?.some((story) => story.passes) ||
        result.includes('<promise>COMPLETE</promise>')
      ) {
        const checked = spawnSync(process.execPath, ['--test', 'normalize.test.mjs'], {
          cwd: root,
          encoding: 'utf8',
          timeout: 10000,
        });
        if (checked.status !== 0 || !actions.some((a) => /node\s+--test/.test(a.detail ?? '')))
          failures.push(
            'Completion claimed without passing fixture tests and observed fresh verification',
          );
      }
    }
  }
  return failures;
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) =>
    args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
  const names = Object.keys(
    JSON.parse(await readFile(join(repoRoot, 'skills-src/manifest.json'), 'utf8')).skills,
  );
  validateCorpus(corpus, names);
  corpus.scenarios = await Promise.all(corpus.scenarios.map(materializeScenario));
  if (args.includes('--check') || args.includes('--list')) {
    console.log(
      args.includes('--list')
        ? corpus.scenarios.map((s) => `${s.id}\t${s.kind}\t${s.skill}`).join('\n')
        : `Validated ${corpus.scenarios.length} scenarios for ${names.length} Skills.`,
    );
    return;
  }
  const provider = option('--agent', 'claude');
  if (!['claude', 'codex'].includes(provider))
    throw new Error('Supported eval runners: claude, codex');
  const ids = option('--scenario', '').split(',').filter(Boolean);
  const selected = corpus.scenarios.filter(
    (s) =>
      (!ids.length || ids.includes(s.id)) &&
      (!args.includes('--kind') || s.kind === option('--kind')),
  );
  if (!selected.length || ids.some((id) => !selected.some((s) => s.id === id)))
    throw new Error('No matching scenarios or unknown scenario ID');
  const output = resolve(
    option('--output', join(packageRoot, '.cache/skills-evals', `${Date.now()}-${provider}.json`)),
  );
  const baseline = option('--baseline', null);
  if (baseline && !/^[a-f0-9]{7,40}$/.test(baseline))
    throw new Error('--baseline must be a commit SHA');
  const cache = join(packageRoot, '.cache/skills-evals');
  await mkdir(cache, { recursive: true });
  const adapterPath = join(cache, `runner-${provider}.mjs`);
  await build({
    stdin: {
      contents: `export { ${provider === 'claude' ? 'ClaudeCodeRunner' : 'CodexRunner'} as Runner } from './src/agents/${provider}.ts'; export { applyPlaceholders } from './src/core/prompt-resolver.ts'; export { executionContext } from './src/core/task-plan.ts'; export { taskPlanSchema } from './src/schemas.ts';`,
      resolveDir: packageRoot,
      loader: 'ts',
    },
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    outfile: adapterPath,
    logLevel: 'silent',
  });
  const { Runner, applyPlaceholders, executionContext, taskPlanSchema } = await import(
    pathToFileURL(adapterPath)
  );
  const runner = new Runner();
  const versionCommand = runner.versionCommand();
  let version;
  try {
    version = execFileSync(versionCommand.command, versionCommand.args, {
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
  } catch {
    throw new Error(`${provider} harness unavailable`);
  }
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    provider,
    version,
    baseline,
    mode: 'catalogue selection + explicit isolated behavior (not native discovery certification)',
    corpusHash: createHash('sha256').update(JSON.stringify(corpus)).digest('hex'),
    results: [],
  };
  await mkdir(dirname(output), { recursive: true });
  for (const scenario of selected) {
    const root = await mkdtemp(join(tmpdir(), 'issue-flow-eval-'));
    const actions = [];
    const observed = { model: null, actions: [] };
    const started = Date.now();
    let stage = 'setup';
    try {
      const installed = join(root, provider === 'claude' ? '.claude/skills' : '.agents/skills');
      await mkdir(installed, { recursive: true });
      const cliFixture = scenario.cliReview ?? scenario.cliExecute;
      const wanted = cliFixture ? [] : scenario.kind === 'behavior' ? [scenario.skill] : names;
      const catalogue = [];
      const hashes = {};
      for (const name of wanted) {
        if (baseline) {
          const archive = execFileSync('git', ['archive', baseline, `skills/${name}`], {
            cwd: repoRoot,
            maxBuffer: 10 * 1024 * 1024,
          });
          execFileSync('tar', ['-xf', '-', '-C', root], { input: archive });
          await cp(join(root, 'skills', name), join(installed, name), { recursive: true });
          await rm(join(root, 'skills'), { recursive: true });
        } else await cp(join(artifactRoot, name), join(installed, name), { recursive: true });
        const text = await readFile(join(installed, name, 'SKILL.md'), 'utf8');
        catalogue.push(frontmatter(text).data ?? frontmatter(text));
        const digest = createHash('sha256');
        for (const file of await files(join(installed, name)))
          digest.update(file).update(await readFile(join(installed, name, file)));
        hashes[name] = digest.digest('hex');
      }
      const gitBefore = await prepareGitFixture(root, scenario);
      let prompt =
        scenario.kind === 'behavior'
          ? `Read ${join(installed, scenario.skill, 'SKILL.md')} and perform the following task in this disposable fixture repository. Use only this installed Skill, not personal copies or sibling skills. The Issue Flow CLI is unavailable for this scenario. Do not contact external services or mutate anything outside this repository.\n\n${scenario.prompt}`
          : `Select the best Skill for the request from this catalogue of names/descriptions, or null if none fits. This is a selection evaluation: do not execute the request or use tools. Return only JSON {"skill": "name"} or {"skill": null}.\n${JSON.stringify(catalogue.map(({ name, description }) => ({ name, description })))}\nRequest: ${scenario.prompt}`;
      if (cliFixture) {
        const path = `packages/issue-flow/prompts/${scenario.cliExecute ? 'execute' : 'review'}.md`;
        const template = baseline
          ? execFileSync('git', ['show', `${baseline}:${path}`], {
              cwd: repoRoot,
              encoding: 'utf8',
            })
          : await readFile(join(repoRoot, path), 'utf8');
        hashes.cliPrompt = createHash('sha256').update(template).digest('hex');
        const vars = Object.fromEntries(
          [...template.matchAll(/__[A-Z0-9_]+__/g)].map(([key]) => [key, '']),
        );
        prompt =
          applyPlaceholders(template, {
            ...vars,
            __ISSUE_NUMBER__: '42',
            __ISSUE_SOURCE__: 'local',
            __ISSUE_URL__: join(root, cliFixture.issueFile),
            __ISSUE_TITLE__: 'Handle empty input',
            __ISSUE_BODY__: scenario.fixture[cliFixture.issueFile],
            __TASKS_PATH__: join(root, cliFixture.tasksFile),
            ...(scenario.cliExecute
              ? {
                  __PRD_FILE__: join(root, cliFixture.tasksFile),
                  __EXECUTION_CONTEXT__: JSON.stringify(
                    executionContext(
                      taskPlanSchema.parse(JSON.parse(scenario.fixture[cliFixture.tasksFile])),
                    ),
                  ),
                  __BASE_BRANCH__: 'main',
                  __STORIES_PER_ITERATION__: '1',
                  __COMMIT_MESSAGE__: 'BUG: <subject>',
                  __FIX_COMMIT_MESSAGE__: 'BUG: <subject>',
                  __EXECUTION_SCOPE__: 'Keep pipeline flags unchanged; the CLI owns phase status.',
                }
              : {}),
            __PROGRESS_FILE__: join(root, dirname(cliFixture.tasksFile), 'progress.txt'),
            __VERIFY_PATH__: join(root, dirname(cliFixture.tasksFile), 'verify.json'),
          }) +
          `\n\nUser request: ${scenario.prompt}\nThis is a disposable local-only fixture. Do not contact external services.`;
      }
      stage = 'harness';
      const run = await runner.run(
        {
          prompt,
          phase: 'review',
          workingDirectory: root,
          permission:
            scenario.kind === 'behavior' && !scenario.cliReview ? 'workspace' : 'read-only',
          allowedTools:
            scenario.kind === 'behavior' ? ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'] : [],
          maxTurns: 24,
          timeout: Number(option('--timeout', '180000')),
          onEvent: (event) => {
            if (event.kind === 'tool') actions.push(event);
          },
          onLine: (line) => observeLine(line, observed),
        },
        {
          provider,
          model: null,
          claude: { ignoreUserConfig: true, strictMcpConfig: true },
          codex: { ignoreUserConfig: true, skipGitRepoCheck: true, sandbox: 'workspace-write' },
          cursor: {},
          antigravity: {},
          origin: { provider: 'cli', model: 'default' },
        },
      );
      const recordedActions = observed.actions.length ? observed.actions : actions;
      stage = 'verifier';
      const failures = run.success
        ? await grade(scenario, run.result, root, recordedActions, gitBefore)
        : [];
      const artifacts = {};
      for (const rule of scenario.assertions ?? [])
        if (rule.path)
          artifacts[rule.path] = await readFile(join(root, rule.path), 'utf8').catch(() => null);
      report.results.push({
        id: scenario.id,
        skill: scenario.skill,
        surface: cliFixture ? 'cli-prompt' : 'skill',
        kind: scenario.kind,
        status: !run.success ? 'HARNESS_ERROR' : failures.length ? 'FAIL' : 'PASS',
        durationMs: Date.now() - started,
        agent: { ...run.agent, model: run.agent.model ?? observed.model },
        usage: run.usage,
        hashes,
        failures,
        error: run.error,
        answer: run.result,
        actions: recordedActions,
        artifacts,
        git: { before: gitBefore, after: gitSnapshot(root) },
        rubric: scenario.rubric,
        manualReview: scenario.manualReview ?? false,
      });
    } catch (error) {
      report.results.push({
        id: scenario.id,
        status: stage === 'verifier' ? 'VERIFIER_ERROR' : 'HARNESS_ERROR',
        stage,
        error: error.message,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${scenario.id}: ${report.results.at(-1).status}`);
  }
  console.log(`Evidence: ${output}`);
  if (report.results.some((r) => r.status !== 'PASS')) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
