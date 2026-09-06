import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const DEFAULT_SAMPLES = 30;
const DEFAULT_WARMUPS = 5;
const VERSION_ARGS = ['dist/cli.js', '--version'];
const COMPLETION_ARGS = ['dist/cli.js', 'complete', '--', 'db', ''];

function usage(message) {
  if (message) console.error(message);
  console.error(
    'Usage: node scripts/terminal-benchmark.mjs --baseline <package-dir> --candidate <package-dir> [--samples <n>] [--warmups <n>]',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const values = { samples: DEFAULT_SAMPLES, warmups: DEFAULT_WARMUPS };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--baseline', '--candidate', '--samples', '--warmups'].includes(key) || !value) {
      usage(`Unknown or incomplete argument: ${key}`);
    }
    values[key.slice(2)] = value;
    index += 1;
  }

  if (!values.baseline || !values.candidate) usage('Both checkout directories are required.');
  values.samples = Number(values.samples);
  values.warmups = Number(values.warmups);
  if (!Number.isInteger(values.samples) || values.samples < 20) {
    usage('--samples must be an integer of at least 20.');
  }
  if (!Number.isInteger(values.warmups) || values.warmups < 0) {
    usage('--warmups must be a non-negative integer.');
  }
  values.baseline = resolve(values.baseline);
  values.candidate = resolve(values.candidate);
  return values;
}

function percentile(sorted, fraction) {
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}

function summarize(samples) {
  const sorted = samples.map(({ durationMs }) => durationMs).sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return {
    samples: sorted.length,
    medianMs: Number(median.toFixed(3)),
    minMs: Number(sorted[0].toFixed(3)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(3)),
    maxMs: Number(sorted.at(-1).toFixed(3)),
    statuses: [...new Set(samples.map(({ status }) => status))],
  };
}

function execute(cwd, args) {
  const started = process.hrtime.bigint();
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    durationMs,
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    error: result.error?.message,
  };
}

function revision(cwd) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
}

function commandText(args) {
  return [process.execPath, ...args.map((arg) => (arg === '' ? "''" : arg))].join(' ');
}

function measurePair(baseline, candidate, args, samples, warmups) {
  for (let index = 0; index < warmups; index += 1) {
    execute(baseline, args);
    execute(candidate, args);
  }

  const measured = { baseline: [], candidate: [] };
  for (let index = 0; index < samples; index += 1) {
    const order = index % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    for (const arm of order)
      measured[arm].push(execute(arm === 'baseline' ? baseline : candidate, args));
  }

  return {
    command: commandText(args),
    baseline: {
      ...summarize(measured.baseline),
      stdout: measured.baseline[0].stdout,
      stderr: measured.baseline[0].stderr,
    },
    candidate: {
      ...summarize(measured.candidate),
      stdout: measured.candidate[0].stdout,
      stderr: measured.candidate[0].stderr,
    },
  };
}

const options = parseArgs(process.argv.slice(2));
const report = {
  schemaVersion: 1,
  measuredAt: new Date().toISOString(),
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(),
    noColor: true,
    warmups: options.warmups,
    samples: options.samples,
    scheduling:
      'Baseline and candidate executions alternate order; each sample starts a new Node process.',
  },
  directories: {
    baseline: options.baseline,
    candidate: options.candidate,
  },
  revisions: {
    baseline: revision(options.baseline),
    candidate: revision(options.candidate),
  },
  version: measurePair(
    options.baseline,
    options.candidate,
    VERSION_ARGS,
    options.samples,
    options.warmups,
  ),
  nestedCompletion: measurePair(
    options.baseline,
    options.candidate,
    COMPLETION_ARGS,
    options.samples,
    options.warmups,
  ),
};

report.limitations = [
  'Wall-clock timings include Node startup, module loading, process creation, and local scheduler noise.',
  ...(report.nestedCompletion.baseline.statuses.every((status) => status === 0)
    ? []
    : [
        'The baseline does not support the requested completion protocol; its measurement is rejection latency, not functional completion latency.',
      ]),
];

console.log(JSON.stringify(report, null, 2));
