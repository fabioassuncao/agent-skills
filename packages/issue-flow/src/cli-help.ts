interface RootHelpCommand {
  name: string;
  description: string;
}

interface RootHelpGroup {
  title: string;
  commands: readonly RootHelpCommand[];
}

const ROOT_HELP_GROUPS: readonly RootHelpGroup[] = [
  {
    title: 'Pipeline',
    commands: [
      { name: 'run', description: 'Run the complete issue-to-PR pipeline' },
      { name: 'resume', description: 'Resume an interrupted pipeline' },
      { name: 'generate', description: 'Draft and publish an issue' },
      { name: 'analyze', description: 'Analyze one issue' },
      { name: 'prd', description: 'Turn issue analysis into a PRD' },
      { name: 'plan', description: 'Turn a PRD into an executable task plan' },
      { name: 'execute', description: 'Implement the task plan story by story' },
      { name: 'review', description: 'Verify the implementation independently' },
      { name: 'pr', description: 'Create the Pull Request' },
      { name: 'pr-review', description: 'Review a Pull Request as a whole' },
    ],
  },
  {
    title: 'Sessions and worktrees',
    commands: [
      { name: 'session', description: 'Open and manage live agent sessions' },
      { name: 'tab', description: 'List, fork, switch and close agent tabs' },
      { name: 'worktree', description: 'List and curate managed worktrees' },
      { name: 'status', description: 'Show what a run is doing now' },
      { name: 'ps', description: 'List every active run on this machine' },
      { name: 'runs', description: "List this project's run history" },
      { name: 'history', description: 'Show relational history for one issue' },
      { name: 'logs', description: 'Read the filtered execution journal' },
      { name: 'pause', description: 'Request a safe checkpoint and pause' },
      { name: 'cancel', description: 'Stop and mark a run as cancelled' },
      { name: 'usage', description: 'Summarize tokens, cost and duration' },
      { name: 'artifacts', description: 'Inspect issue artifacts without writing' },
      { name: 'db', description: 'Inspect and maintain the SQLite database' },
    ],
  },
  {
    title: 'Monitor',
    commands: [
      { name: 'serve', description: 'Serve the multi-project dashboard' },
      { name: 'web', description: 'Manage the dashboard server lifecycle' },
      { name: 'project', description: 'Curate projects shown by the dashboard' },
    ],
  },
  {
    title: 'Configuration and diagnostics',
    commands: [
      { name: 'init', description: 'Check prerequisites and repository conventions' },
      { name: 'policy', description: 'Inspect resolved repository policy' },
      { name: 'routing', description: 'Inspect or configure adaptive routing' },
      { name: 'conventions', description: 'Resolve branch, commit and PR naming' },
      { name: 'agent', description: 'Inspect or select agents and models' },
      { name: 'bench', description: 'Measure the synthetic or real corpus' },
    ],
  },
  {
    title: 'Skills',
    commands: [{ name: 'complete', description: 'Generate shell completion scripts' }],
  },
];

export const ROOT_HELP_COMMANDS: readonly RootHelpCommand[] = ROOT_HELP_GROUPS.flatMap(
  (group) => group.commands,
);

const ENVIRONMENT_GROUPS = [
  {
    title: 'Storage and monitor',
    description: 'storage root, served repositories and dashboard settings',
    names: [
      'ISSUE_FLOW_HOME',
      'ISSUE_FLOW_PROJECT_DIR',
      'ISSUE_FLOW_WEB',
      'ISSUE_FLOW_WEB_PORT',
      'ISSUE_FLOW_WEB_HOST',
      'ISSUE_FLOW_WEB_REFRESH',
      'ISSUE_FLOW_WEB_LOG_LIMIT',
    ],
  },
  {
    title: 'Agents',
    description: 'provider defaults and harness-specific behavior',
    names: [
      'ISSUE_FLOW_AGENT',
      'ISSUE_FLOW_AGENT_MODEL',
      'ISSUE_FLOW_AGENT_HOOKS',
      'ISSUE_FLOW_CODEX_SANDBOX',
      'ISSUE_FLOW_CODEX_REASONING_EFFORT',
      'ISSUE_FLOW_CODEX_IGNORE_USER_CONFIG',
      'ISSUE_FLOW_CURSOR_SANDBOX',
      'ISSUE_FLOW_CURSOR_PERMISSIONS_FILE',
      'ISSUE_FLOW_ANTIGRAVITY_SANDBOX',
      'ISSUE_FLOW_ANTIGRAVITY_EFFORT',
      'ISSUE_FLOW_ANTIGRAVITY_EXECUTE_TIMEOUT',
      'ISSUE_FLOW_OPENCODE_VARIANT',
      'ISSUE_FLOW_OPENCODE_MIN_VERSION',
    ],
  },
  {
    title: 'Run and runtime',
    description: 'session, concurrency and PR-review defaults',
    names: [
      'ISSUE_FLOW_RUN_AUTO_CLOSE',
      'ISSUE_FLOW_RUNTIME_PROFILE',
      'ISSUE_FLOW_RUNTIME_MAX_CONCURRENT',
      'ISSUE_FLOW_PR_REVIEW_PUBLISHER',
    ],
  },
  {
    title: 'GitHub',
    description: 'linked repositories and PR/CI cadence',
    names: [
      'ISSUE_FLOW_GITHUB_LINKED_REPOS',
      'ISSUE_FLOW_GITHUB_SYNC_INTERVAL_MS',
      'ISSUE_FLOW_GITHUB_AUTO_REMOVE_ON_MERGE',
    ],
  },
  {
    title: 'Linear',
    description: 'provider enablement, watched teams and worktree automation',
    names: [
      'ISSUE_FLOW_LINEAR_ENABLED',
      'ISSUE_FLOW_LINEAR_AUTO_CREATE',
      'ISSUE_FLOW_LINEAR_WATCH_TEAMS',
    ],
  },
  {
    title: 'Policy',
    description: 'repository convention overrides',
    names: [
      'ISSUE_FLOW_POLICY',
      'ISSUE_FLOW_POLICY_CONTEXT_BUDGET',
      'ISSUE_FLOW_POLICY_BASE_BRANCH',
      'ISSUE_FLOW_POLICY_BRANCH_CONVENTION',
      'ISSUE_FLOW_POLICY_COMMIT_CONVENTION',
      'ISSUE_FLOW_POLICY_PR_TITLE_CONVENTION',
      'ISSUE_FLOW_POLICY_ISSUE_TITLE_CONVENTION',
    ],
  },
  {
    title: 'Telemetry',
    description: 'collection, retention and pricing estimates',
    names: [
      'ISSUE_FLOW_TELEMETRY',
      'ISSUE_FLOW_TELEMETRY_MAX_EXECUTIONS',
      'ISSUE_FLOW_TELEMETRY_ESTIMATE',
    ],
  },
  {
    title: 'Benchmark',
    description: 'explicit opt-in for paid live campaigns under the test runner',
    names: ['ISSUE_FLOW_E2E_BENCH'],
  },
  {
    title: 'Resilience',
    description: 'retry, failover, queue and journal settings',
    names: [
      'ISSUE_FLOW_RESILIENCE_PROFILE',
      'ISSUE_FLOW_RESILIENCE_FAILOVER',
      'ISSUE_FLOW_RESILIENCE_FAILOVER_ON_AUTH',
      'ISSUE_FLOW_RESILIENCE_PROVIDER_CHAIN',
      'ISSUE_FLOW_RESILIENCE_PROVIDER_COOLDOWN_MS',
      'ISSUE_FLOW_RESILIENCE_PROVIDER_MAX_COOLDOWN_MS',
      'ISSUE_FLOW_RESILIENCE_PROVIDER_FAILURE_WINDOW_MS',
      'ISSUE_FLOW_RESILIENCE_PROVIDER_FAILURES_TO_TRIP',
      'ISSUE_FLOW_RESILIENCE_ON_ISSUE_FAILURE',
      'ISSUE_FLOW_RESILIENCE_MAX_ISSUE_ATTEMPTS',
      'ISSUE_FLOW_RESILIENCE_INACTIVITY_TIMEOUT_MS',
      'ISSUE_FLOW_RESILIENCE_JOURNAL',
      'ISSUE_FLOW_RESILIENCE_JOURNAL_MAX_BYTES',
      'ISSUE_FLOW_RESILIENCE_AUTO_DECOMPOSE',
      'ISSUE_FLOW_RESILIENCE_RETRY',
    ],
  },
] as const;

export const HELP_ENVIRONMENT_VARIABLES: readonly string[] = ENVIRONMENT_GROUPS.flatMap(
  (group) => group.names,
);

function appendWrappedNames(lines: string[], names: readonly string[], maxWidth = 100): void {
  let line = '    ';
  for (const name of names) {
    const addition = line.trim() === '' ? name : `, ${name}`;
    if (line.length + addition.length > maxWidth) {
      lines.push(line);
      line = `    ${name}`;
    } else {
      line += addition;
    }
  }
  lines.push(line);
}

/** Root help is intentionally preformatted: Commander wraps long descriptions. */
export function buildRootHelp(): string {
  const commandWidth = Math.max(...ROOT_HELP_COMMANDS.map((command) => command.name.length));
  const lines = [
    'Issue Flow — Take an issue from statement to a reviewed Pull Request.',
    '',
    'Usage:',
  ];

  for (const group of ROOT_HELP_GROUPS) {
    lines.push(`  ${group.title}:`);
    for (const command of group.commands) {
      lines.push(`  issue-flow ${command.name.padEnd(commandWidth)}  ${command.description}`);
    }
  }

  lines.push(
    '',
    'Options:',
    '  -V, --version  Show the version number',
    '  -h, --help     Show this help',
    '',
    'Environment:',
  );
  for (const group of ENVIRONMENT_GROUPS) {
    lines.push(`  ${group.title}: ${group.description}`);
    appendWrappedNames(lines, group.names);
  }
  lines.push(
    '  Internal context variables (control tokens, run ids, prompts and worktree paths) are set by',
    '  Issue Flow itself and are intentionally not configuration knobs.',
  );
  lines.push('');
  return lines.join('\n');
}
