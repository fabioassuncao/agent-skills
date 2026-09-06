// Synthetic GitHub capability for isolated behavioral evals. No network access.
import { readFileSync, writeFileSync } from 'node:fs';
const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const config = read('./github-config.json');
const statePath = new URL('./github-state.json', import.meta.url);
let state;
try {
  state = JSON.parse(readFileSync(statePath, 'utf8'));
} catch {
  state = {
    pr: config.existingPR ?? null,
    creates: 0,
    edits: 0,
    views: 0,
    failures: 0,
    requests: [],
  };
}
const save = () => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
const output = (value) => console.log(JSON.stringify(value));
const fail = (message) => {
  save();
  console.error(message);
  process.exitCode = 1;
};
const fields = ['labels', 'assignees', 'reviewers', 'projects', 'milestone'];
function apply(input) {
  for (const field of fields) {
    if (!(field in input)) continue;
    if (config.failField === field && (config.failAlways || state.failures === 0)) {
      state.failures++;
      throw new Error(`Metadata permission failure: ${field}; PR already exists`);
    }
    const available =
      field === 'labels' ? config.labels.map((label) => label.name) : (config[field] ?? []);
    const values = field === 'milestone' ? [input[field]] : input[field];
    if (!Array.isArray(values) || values.some((value) => !available.includes(value)))
      throw new Error(`Unavailable ${field}`);
    if (field === 'milestone') state.pr[field] = input[field];
    else state.pr[field] = [...new Set([...(state.pr[field] ?? []), ...values])].sort();
  }
}
const operation = process.argv[2];
try {
  const input = process.argv[3] ? JSON.parse(process.argv[3]) : {};
  state.requests.push({ operation, input });
  switch (operation) {
    case '--help':
      output({
        usage: 'node github-pr.mjs <operation> [JSON argument]',
        operations: {
          context: 'Repository, default/base/head and published-head status',
          diff: 'Authoritative published base...head diff',
          labels: 'Repository label registry',
          eligibility: 'Assignable users, eligible reviewers, milestones and projects',
          list: 'Open PRs for the published head/base',
          view: 'Current PR including all metadata',
          create:
            'JSON: title, bodyFile, base, head; optional labels, assignees, reviewers, milestone, projects',
          edit: 'JSON: optional title/bodyFile and additive metadata fields; targets the existing PR',
        },
      });
      break;
    case 'context':
      output({
        repository: 'example/fixture',
        defaultBranch: 'main',
        base: 'main',
        head: 'feat/request',
        published: true,
      });
      break;
    case 'diff':
      output(config.diff);
      break;
    case 'labels':
      if (config.labelsUnavailable) throw new Error('Label registry unavailable');
      output(config.labels);
      break;
    case 'eligibility':
      output(
        Object.fromEntries(
          fields.filter((field) => field !== 'labels').map((field) => [field, config[field] ?? []]),
        ),
      );
      break;
    case 'list':
      output(state.pr ? [state.pr] : []);
      break;
    case 'view':
      state.views++;
      if (!state.pr) throw new Error('No PR');
      output(state.pr);
      break;
    case 'create':
      if (state.pr) throw new Error('PR already exists; reuse it');
      if (!input.title || !input.bodyFile || input.base !== 'main' || input.head !== 'feat/request')
        throw new Error('Missing title/bodyFile or incorrect base/head');
      state.creates++;
      state.pr = {
        number: 7,
        url: 'https://github.com/example/fixture/pull/7',
        title: input.title,
        body: readFileSync(input.bodyFile, 'utf8'),
        base: input.base,
        head: input.head,
        labels: [],
        assignees: [],
        reviewers: [],
        projects: [],
        milestone: null,
      };
      apply(input);
      output(state.pr);
      break;
    case 'edit':
      if (!state.pr) throw new Error('No PR to edit');
      state.edits++;
      if (input.title) state.pr.title = input.title;
      if (input.bodyFile) state.pr.body = readFileSync(input.bodyFile, 'utf8');
      apply(input);
      output(state.pr);
      break;
    default:
      throw new Error('Unknown operation; use --help');
  }
  save();
} catch (error) {
  fail(error.message);
}
