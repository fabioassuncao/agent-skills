import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageRoot } from './skills-build.mjs';
import { corpusPath, evalProviders } from './skills-eval.mjs';

const runnerPath = join(packageRoot, 'scripts/skills-eval.mjs');

function value(args, name, fallback = null) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function finite(values) {
  return values.filter((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

export function statistics(values) {
  const samples = finite(values);
  if (!samples.length) return null;
  const mean = samples.reduce((sum, current) => sum + current, 0) / samples.length;
  const variance =
    samples.length > 1
      ? samples.reduce((sum, current) => sum + (current - mean) ** 2, 0) / (samples.length - 1)
      : 0;
  return {
    reported: samples.length,
    mean,
    standardDeviation: Math.sqrt(variance),
    min: Math.min(...samples),
    max: Math.max(...samples),
  };
}

function metric(result, name) {
  if (name === 'durationMs') return result.durationMs;
  if (name === 'toolCalls') return result.actions?.length;
  if (name === 'totalTokens') {
    const input = result.usage?.inputTokens;
    const output = result.usage?.outputTokens;
    return input === undefined && output === undefined ? null : (input ?? 0) + (output ?? 0);
  }
  return result.usage?.[name] ?? null;
}

const metricNames = [
  'durationMs',
  'toolCalls',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheCreationTokens',
  'costUsd',
];

export function aggregateResults(results) {
  const groups = new Map();
  for (const result of results) {
    const key = [
      result.provider,
      result.arm,
      result.surface ?? 'unknown',
      result.kind ?? 'unknown',
    ].join('/');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  }
  return [...groups.entries()].map(([key, members]) => {
    const passed = members.filter((entry) => entry.status === 'PASS').length;
    const failed = members.filter((entry) => entry.status === 'FAIL').length;
    const harnessErrors = members.filter((entry) => entry.status === 'HARNESS_ERROR').length;
    const verifierErrors = members.filter((entry) => entry.status === 'VERIFIER_ERROR').length;
    return {
      key,
      provider: members[0].provider,
      arm: members[0].arm,
      surface: members[0].surface ?? 'unknown',
      kind: members[0].kind ?? 'unknown',
      samples: members.length,
      passed,
      failed,
      harnessErrors,
      verifierErrors,
      passRate: passed / members.length,
      evaluatedPassRate: passed + failed === 0 ? null : passed / (passed + failed),
      metrics: Object.fromEntries(
        metricNames.map((name) => [name, statistics(members.map((entry) => metric(entry, name)))]),
      ),
    };
  });
}

function comparisonKey(group) {
  return [group.provider, group.surface, group.kind].join('/');
}

export function compareAggregates(groups) {
  const byKey = new Map();
  for (const group of groups) {
    const key = comparisonKey(group);
    if (!byKey.has(key)) byKey.set(key, {});
    byKey.get(key)[group.arm] = group;
  }
  const comparisons = [];
  for (const [key, arms] of byKey) {
    if (!arms.candidate) continue;
    for (const from of ['baseline', 'without-skill']) {
      if (!arms[from]) continue;
      const metrics = {};
      for (const name of metricNames) {
        const before = arms[from].metrics[name]?.mean;
        const after = arms.candidate.metrics[name]?.mean;
        metrics[name] =
          before === undefined || after === undefined
            ? null
            : { before, after, delta: after - before };
      }
      comparisons.push({
        key: `${key}/${from}-to-candidate`,
        provider: arms.candidate.provider,
        surface: arms.candidate.surface,
        kind: arms.candidate.kind,
        from,
        to: 'candidate',
        passRate: {
          before: arms[from].passRate,
          after: arms.candidate.passRate,
          delta: arms.candidate.passRate - arms[from].passRate,
        },
        metrics,
      });
    }
  }
  return comparisons;
}

function number(value) {
  return value === null || value === undefined
    ? 'n/a'
    : Number.isInteger(value)
      ? String(value)
      : value.toFixed(2);
}

export function markdownReport(report) {
  const lines = [
    '# Agent Skills benchmark',
    '',
    `Created: ${report.createdAt}`,
    '',
    `Baseline: ${report.configuration.baseline ?? 'none'}`,
    '',
    '| Provider | Arm | Surface | Kind | Pass | Errors | Duration ms | Tokens | Tool calls |',
    '|---|---|---|---|---:|---:|---:|---:|---:|',
  ];
  for (const group of report.aggregates) {
    lines.push(
      `| ${group.provider} | ${group.arm} | ${group.surface} | ${group.kind} | ${(group.passRate * 100).toFixed(1)}% | ${group.harnessErrors + group.verifierErrors} | ${number(group.metrics.durationMs?.mean)} | ${number(group.metrics.totalTokens?.mean)} | ${number(group.metrics.toolCalls?.mean)} |`,
    );
  }
  lines.push('', '## Comparisons', '');
  if (!report.comparisons.length) lines.push('No comparable arms were requested.');
  for (const comparison of report.comparisons) {
    const duration = comparison.metrics.durationMs;
    const tokens = comparison.metrics.totalTokens;
    lines.push(
      `- ${comparison.provider} ${comparison.surface}/${comparison.kind}, ${comparison.from} → candidate: pass ${(comparison.passRate.before * 100).toFixed(1)}% → ${(comparison.passRate.after * 100).toFixed(1)}%; duration ${duration ? `${number(duration.before)} → ${number(duration.after)} ms` : 'n/a'}; tokens ${tokens ? `${number(tokens.before)} → ${number(tokens.after)}` : 'n/a'}.`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function execute(args, output) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [runnerPath, ...args, '--output', output], {
      cwd: packageRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => done({ exitCode: null, stdout, stderr, error: error.message }));
    child.on('close', (exitCode) => done({ exitCode, stdout, stderr, error: null }));
  });
}

async function benchmarkProvider(provider, jobs, directory) {
  const results = [];
  for (const job of jobs) {
    const output = join(directory, `${provider}-${job.arm}-${job.repetition}.json`);
    const args = ['--agent', provider, '--timeout', String(job.timeout)];
    if (job.scenarios.length) args.push('--scenario', job.scenarios.join(','));
    if (job.baseline) args.push('--baseline', job.baseline);
    if (job.arm === 'without-skill') args.push('--without-skill');
    const execution = await execute(args, output);
    let run;
    try {
      run = JSON.parse(await readFile(output, 'utf8'));
    } catch {
      run = null;
    }
    if (run) {
      for (const result of run.results)
        results.push({
          ...result,
          provider,
          harnessVersion: run.version,
          arm: job.arm,
          repetition: job.repetition,
        });
    } else {
      for (const id of job.scenarios)
        results.push({
          id,
          provider,
          arm: job.arm,
          repetition: job.repetition,
          status: 'HARNESS_ERROR',
          error: execution.error ?? execution.stderr.trim() ?? 'Eval runner produced no report',
        });
    }
  }
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const providers = value(args, '--agents', 'claude,codex,cursor').split(',').filter(Boolean);
  if (!providers.length || providers.some((provider) => !evalProviders.includes(provider)))
    throw new Error(`--agents must contain: ${evalProviders.join(', ')}`);
  const repeat = Number(value(args, '--repeat', '1'));
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20)
    throw new Error('--repeat must be an integer from 1 to 20');
  const timeout = Number(value(args, '--timeout', '180000'));
  if (!Number.isFinite(timeout) || timeout < 1) throw new Error('--timeout must be positive');
  const baseline = value(args, '--baseline');
  if (baseline && !/^[a-f0-9]{7,40}$/.test(baseline))
    throw new Error('--baseline must be a commit SHA');
  const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
  const requested = value(args, '--scenario', '').split(',').filter(Boolean);
  const split = value(args, '--split');
  if (!requested.length && !split)
    throw new Error('Select a bounded corpus with --scenario or --split');
  if (split && !['development', 'holdout'].includes(split))
    throw new Error('--split must be development or holdout');
  const scenarios = corpus.scenarios.filter(
    (scenario) =>
      (!requested.length || requested.includes(scenario.id)) &&
      (!split || (scenario.split ?? 'development') === split),
  );
  if (
    !scenarios.length ||
    requested.some((id) => !scenarios.some((scenario) => scenario.id === id))
  )
    throw new Error('No matching scenarios or unknown scenario ID');
  const scenarioIds = scenarios.map((scenario) => scenario.id);
  const behaviorIds = scenarios
    .filter((scenario) => scenario.kind === 'behavior')
    .map((scenario) => scenario.id);
  const arms = ['candidate'];
  if (baseline) arms.unshift('baseline');
  if (args.includes('--without-skill') && behaviorIds.length) arms.unshift('without-skill');
  const jobs = [];
  for (let repetition = 1; repetition <= repeat; repetition += 1) {
    const orderedArms = repetition % 2 === 1 ? arms : [...arms].reverse();
    for (const arm of orderedArms)
      jobs.push({
        arm,
        repetition,
        timeout,
        baseline: arm === 'baseline' ? baseline : null,
        scenarios: arm === 'without-skill' ? behaviorIds : scenarioIds,
      });
  }
  const invocations = providers.length * jobs.reduce((sum, job) => sum + job.scenarios.length, 0);
  const maxInvocations = Number(value(args, '--max-invocations', '120'));
  if (!Number.isInteger(maxInvocations) || maxInvocations < 1)
    throw new Error('--max-invocations must be a positive integer');
  if (invocations > maxInvocations)
    throw new Error(
      `Benchmark requests ${invocations} invocations; narrow the corpus or set --max-invocations explicitly`,
    );
  const output = resolve(
    value(
      args,
      '--output',
      join(packageRoot, '.cache/skills-evals', `${Date.now()}-benchmark.json`),
    ),
  );
  const directory = await mkdtemp(join(tmpdir(), 'issue-flow-skills-benchmark-'));
  try {
    const providerRuns = await Promise.all(
      providers.map((provider) => benchmarkProvider(provider, jobs, directory)),
    );
    const results = providerRuns.flat();
    const aggregates = aggregateResults(results);
    const report = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      configuration: {
        providers,
        repeat,
        baseline,
        withoutSkill: arms.includes('without-skill'),
        invocations,
        scenarios: scenarioIds,
      },
      aggregates,
      comparisons: compareAggregates(aggregates),
      results,
    };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    const markdown = `${output.slice(0, output.length - extname(output).length)}.md`;
    await writeFile(markdown, markdownReport(report));
    console.log(`Invocations: ${invocations}`);
    console.log(`Evidence: ${output}`);
    console.log(`Summary: ${markdown}`);
    if (results.some((result) => result.status !== 'PASS')) process.exitCode = 1;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
