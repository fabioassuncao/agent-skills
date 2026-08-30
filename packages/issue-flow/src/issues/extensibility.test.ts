import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeadlessOptions, HeadlessResult } from '../core/headless.js';
import { resolvePackageDir } from '../core/prompt-resolver.js';
import { hashIssueContent } from './hash.js';
import type { IssueProvider } from './provider.js';
import { clearProviders, registerProvider } from './registry.js';
import { resolveIssue } from './resolver.js';
import type { Issue, IssueDraft, IssuesConfig } from './types.js';

/**
 * Executable proof that the Issue provider layer is extensible.
 *
 * A brand new origin ('memory') is implemented here, in the test, registered in
 * the registry, and the real pipeline — the real commands, loading the real
 * prompt templates from disk — runs end to end on top of it. Nothing in
 * src/commands/ or prompts/ knows this origin exists, and a guard below fails if
 * anything ever starts naming it.
 */

// Only the process boundaries are mocked: agent responses and external binaries.
// The resolver, registry, prerequisite checks, commands, execution engine and
// templates are production code.
vi.mock('../core/headless.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/headless.js')>()),
  runHeadless: vi.fn(),
}));
vi.mock('../core/executor.js', () => ({
  executeClaude: async () => {
    if (executeAgentCompletesStory) {
      const { readFile, writeFile } = await import('node:fs/promises');
      const { resolveIssuePaths } = await import('../storage/resolve.js');
      const { beginExecution, endExecution } = await import('../telemetry/recorder.js');
      const paths = await resolveIssuePaths(ISSUE_ID);
      const executionId = await beginExecution({ purpose: 'execute', harness: 'fake-agent' });
      const plan = JSON.parse(await readFile(paths.tasksFile, 'utf-8')) as TaskPlan;
      plan.userStories[0] = {
        ...plan.userStories[0],
        passes: true,
        notes: 'completed by fake agent',
      };
      await writeFile(paths.tasksFile, JSON.stringify(plan, null, 2), 'utf-8');
      if (executionId !== null) await endExecution({ id: executionId, status: 'completed' });
    }
    return { exitCode: 0, output: '<promise>COMPLETE</promise>', cost: null };
  },
}));
vi.mock('execa', () => ({ execa: vi.fn() }));
// Partial: run.ts reaches the pr-review discovery, which imports
// listPullRequests from this same module. Only the publisher is stubbed.
vi.mock('../core/session-git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/session-git.js')>();
  return { ...actual, publishGitState: vi.fn(async () => {}) };
});
vi.mock('../ui/pipeline-renderer.js', () => ({
  runPipelineWithRenderer: vi.fn(
    async (options: {
      phases: string[];
      startIndex: number;
      runners: Record<string, () => Promise<void>>;
    }) => {
      for (let i = options.startIndex; i < options.phases.length; i++) {
        const phase = options.phases[i] as string;
        try {
          await (options.runners[phase] as () => Promise<void>)();
        } catch {
          return { success: false, failedPhase: phase, overallElapsedSeconds: 1 };
        }
      }
      return { success: true, overallElapsedSeconds: 1 };
    },
  ),
}));

import { execa } from 'execa';
import { runAnalyze } from '../commands/analyze.js';
import { runPipeline } from '../commands/run.js';
import { setIssuesCliOverrides } from '../config.js';
import { runHeadless } from '../core/headless.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import { resetStorageResolutionCache, resolveIssuePaths } from '../storage/resolve.js';
import type { TaskPlan } from '../types.js';

/** The origin this proof invents. Nothing outside this file mentions it. */
const MEMORY_SOURCE = 'memory';

const ISSUE_ID = '42';
const ISSUE_TITLE = 'Support pluggable Issue origins';
const ISSUE_BODY = 'The pipeline must run on an origin it has never heard of.';
const ISSUE_LABELS = ['enhancement', 'providers'];

/**
 * A complete provider for an origin that lives nowhere but in this process.
 *
 * It implements the same `IssueProvider` contract as the built-ins and nothing
 * else: no registry entry to add elsewhere, no branch in a command, no
 * placeholder in a template.
 */
class MemoryIssueProvider implements IssueProvider {
  readonly name = MEMORY_SOURCE;

  /** Call counters, so the pipeline's access pattern can be asserted. */
  readonly calls = { get: 0, create: 0, close: 0 };

  private readonly issues = new Map<string, Issue>();
  private nextNumber = 1;

  /**
   * Reference this origin publishes for an Issue. An in-memory demand has no
   * counterpart anywhere, hence `null` by default — the same contract the local
   * provider follows for an Issue that only exists on disk.
   */
  constructor(private readonly makeRef: (id: string) => string | null = () => null) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async get(id: string): Promise<Issue | null> {
    this.calls.get++;
    return this.issues.get(id) ?? null;
  }

  async create(draft: IssueDraft): Promise<Issue> {
    this.calls.create++;
    const number = this.nextNumber++;
    const id = draft.id ?? String(number);
    const now = '2026-08-03T12:00:00Z';
    const issue: Issue = {
      id,
      number,
      title: draft.title,
      body: draft.body,
      labels: [...draft.labels],
      state: 'open',
      source: this.name,
      remoteRef: this.makeRef(id),
      createdAt: now,
      updatedAt: now,
      contentHash: hashIssueContent(draft.title, draft.body),
    };
    this.issues.set(id, issue);
    return issue;
  }

  async close(id: string): Promise<void> {
    this.calls.close++;
    const issue = this.issues.get(id);
    if (issue !== undefined) {
      this.issues.set(id, { ...issue, state: 'closed' });
    }
  }

  /** Reads the stored Issue without going through `get` (test introspection). */
  peek(id: string): Issue | undefined {
    return this.issues.get(id);
  }
}

function makeConfig(overrides: Partial<IssuesConfig> = {}): IssuesConfig {
  return {
    defaultGenerateTarget: 'github',
    preferredProvider: 'github',
    conflictPolicy: 'ask',
    requireConfirmation: true,
    ...overrides,
  };
}

const VALID_TASK_PLAN: TaskPlan = {
  project: 'issue-flow',
  issueNumber: 42,
  issueUrl: '',
  branchName: 'issue/42-memory',
  description: 'Plan produced while running on the memory origin',
  issueStatus: 'in_progress',
  completedAt: null,
  lastAttemptAt: null,
  lastError: null,
  correctionCycle: 0,
  maxCorrectionCycles: 3,
  pipeline: {
    prdCompleted: true,
    jsonCompleted: true,
    executionCompleted: false,
    reviewCompleted: false,
    prCreated: false,
  },
  userStories: [
    {
      id: 'US-001',
      title: 'Story',
      description: 'As a user, I want it to work',
      acceptanceCriteria: ['works'],
      priority: 1,
      passes: true,
      notes: '',
    },
  ],
};

let generatedPlan: TaskPlan = VALID_TASK_PLAN;
let executeAgentCompletesStory = false;

describe('extensibilidade: um provider novo roda o pipeline sem tocar em commands/prompts', () => {
  let tmp: string;
  let globalHome: string;
  let previousHome: string | undefined;
  let originalCwd: string;
  let provider: MemoryIssueProvider;
  /** Prompt of every headless invocation, in order. */
  let prompts: string[];

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmp = await mkdtemp(join(tmpdir(), 'issue-flow-ext-'));
    process.chdir(tmp);

    // The migrated phases resolve their artifacts under the global storage, so
    // the whole tree is pointed at a temporary home — otherwise this suite
    // would write into the developer's real ~/.issue-flow.
    globalHome = await mkdtemp(join(tmpdir(), 'issue-flow-ext-home-'));
    previousHome = process.env[GLOBAL_ROOT_ENV];
    process.env[GLOBAL_ROOT_ENV] = globalHome;
    resetStorageResolutionCache();

    setIssuesCliOverrides({});
    vi.clearAllMocks();
    prompts = [];
    generatedPlan = VALID_TASK_PLAN;
    executeAgentCompletesStory = false;

    // Every binary the pipeline may reach for. The environment is a healthy
    // GitHub one — gh installed and authenticated, prerequisite checks green —
    // it just does not host this Issue. Nothing is stacked in the new origin's
    // favour beyond the Issue only existing there.
    vi.mocked(execa).mockImplementation((async (file: string, args: string[] = []) => {
      if (file === 'gh' && args[0] === 'issue') {
        return {
          stdout: '',
          stderr: `Could not resolve to an Issue with the number of ${ISSUE_ID}.`,
          exitCode: 1,
        };
      }
      if (file === 'gh') {
        return { stdout: 'gh version 2.44.0', stderr: '', exitCode: 0 };
      }
      if (file === 'claude') {
        return { stdout: '1.0.0', stderr: '', exitCode: 0 };
      }
      if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        return { stdout: tmp, stderr: '', exitCode: 0 };
      }
      // The repository preflight (US-019) probes for a sequencer in progress
      // with `rev-parse --verify --quiet <REF>`; a blanket success here would
      // claim the repository is mid-rebase and block every writing phase.
      if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--verify') {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (file === 'git' && args[0] === 'symbolic-ref') {
        return { stdout: 'refs/heads/issue/42-memory\n', stderr: '', exitCode: 0 };
      }
      if (file === 'git' && args[0] === 'diff') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (file === 'git' && args[0] === 'status') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      // No origin: the project id falls back to the (temporary) path, which is
      // unique per test and keeps the global tree isolated.
      if (file === 'git' && args[0] === 'remote') {
        return { stdout: '', stderr: '', exitCode: 1 };
      }
      if (file === 'git' && args[0] === 'branch') {
        return { stdout: 'issue/42-memory', stderr: '', exitCode: 0 };
      }
      return { stdout: '2.44.0', stderr: '', exitCode: 0 };
    }) as unknown as typeof execa);

    // The agent is replaced by the artifacts each phase expects to find.
    vi.mocked(runHeadless).mockImplementation(
      async (options: HeadlessOptions): Promise<HeadlessResult> => {
        prompts.push(options.prompt);
        const status = options.statusMessage ?? '';
        // Where the phase told the agent it may write: the same directory it
        // will read the artifact back from, whichever layout it resolved.
        const issueDir = options.addDirs?.[0] ?? join(tmp, 'issues', ISSUE_ID);
        if (status.startsWith('Analyzing')) {
          await writeFile(join(issueDir, 'analysis.md'), '# Analysis\n\nDone.', 'utf-8');
        }
        if (status.startsWith('Generating PRD')) {
          await writeFile(join(issueDir, 'prd.md'), '# PRD\n\nUser stories go here.', 'utf-8');
        }
        if (status.startsWith('Converting PRD')) {
          await writeFile(
            join(issueDir, 'tasks.json'),
            JSON.stringify(generatedPlan, null, 2),
            'utf-8',
          );
        }
        const output = status.startsWith('Reviewing Pull Request')
          ? '<pr-review-result>\nRECOMMENDATION: APPROVE\nBLOCKERS:\n- None\n</pr-review-result>'
          : status.startsWith('Reviewing')
            ? '<review-result>\nSTATUS: PASS\n</review-result>'
            : status.startsWith('Creating PR')
              ? 'https://github.com/acme/repo/pull/42'
              : 'done';
        return { success: true, result: output, cost: null, error: null };
      },
    );

    clearProviders();
    provider = new MemoryIssueProvider();
    registerProvider(provider);
    await provider.create({
      title: ISSUE_TITLE,
      body: ISSUE_BODY,
      labels: ISSUE_LABELS,
      id: ISSUE_ID,
    });
  });

  afterEach(async () => {
    setIssuesCliOverrides({});
    clearProviders();
    process.chdir(originalCwd);
    resetStorageResolutionCache();
    if (previousHome === undefined) delete process.env[GLOBAL_ROOT_ENV];
    else process.env[GLOBAL_ROOT_ENV] = previousHome;
    await rm(tmp, { recursive: true, force: true });
    await rm(globalHome, { recursive: true, force: true });
  });

  it('o resolver elege a origem nova sem nenhuma configuração', async () => {
    const resolved = await resolveIssue(ISSUE_ID, {
      config: makeConfig(),
      info: vi.fn(),
      warn: vi.fn(),
    });

    // Nothing was passed to point the resolver at 'memory': registering the
    // provider is what put it in the running, alongside the built-ins.
    expect(resolved.source).toBe(MEMORY_SOURCE);
    expect(resolved.issue.title).toBe(ISSUE_TITLE);
    expect(resolved.divergent).toBe(false);
    expect(resolved.github).toBeNull();
    expect(resolved.local).toBeNull();
  });

  it('uma fase avulsa injeta a Issue da origem nova nos placeholders do template', async () => {
    const code = await runAnalyze(ISSUE_ID);

    expect(code).toBe(0);
    const prompt = prompts[0] as string;
    expect(prompt).toContain(ISSUE_TITLE);
    expect(prompt).toContain(ISSUE_BODY);
    expect(prompt).toContain(ISSUE_LABELS.join(', '));
    // The origin travels to the template under its own name.
    expect(prompt).toContain(MEMORY_SOURCE);
    // No placeholder survived unresolved.
    expect(prompt).not.toContain('__ISSUE_');
  });

  it('a referência publicada pelo provider chega ao template', async () => {
    clearProviders();
    const referenced = new MemoryIssueProvider((id) => `memory://issues/${id}`);
    registerProvider(referenced);
    await referenced.create({
      title: ISSUE_TITLE,
      body: ISSUE_BODY,
      labels: ISSUE_LABELS,
      id: ISSUE_ID,
    });

    expect(await runAnalyze(ISSUE_ID)).toBe(0);
    expect(prompts[0]).toContain(`memory://issues/${ISSUE_ID}`);
  });

  it('o pipeline completo roda sobre a origem nova', async () => {
    const code = await runPipeline(ISSUE_ID, 'auto');

    expect(code).toBe(0);
    // prd, plan, review and pr each rendered their real template.
    expect(prompts).toHaveLength(4);
    for (const prompt of prompts) {
      expect(prompt).toContain(ISSUE_TITLE);
      expect(prompt).toContain(ISSUE_BODY);
      expect(prompt).not.toContain('__ISSUE_');
    }
    const paths = await resolveIssuePaths(ISSUE_ID);
    expect(await readFile(paths.prdFile, 'utf-8')).toContain('# PRD');
    // Nothing was written back into the repository itself.
    await expect(readFile(join(tmp, 'issues', ISSUE_ID, 'prd.md'), 'utf-8')).rejects.toThrow();
  });

  it('runs the real plan → execute → review → pr → pr-review chain and preserves agent state after telemetry closes', async () => {
    generatedPlan = {
      ...VALID_TASK_PLAN,
      pipeline: { ...VALID_TASK_PLAN.pipeline, prReviewCompleted: false },
      userStories: [{ ...VALID_TASK_PLAN.userStories[0], passes: false, notes: '' }],
    };
    executeAgentCompletesStory = true;

    const code = await runPipeline(ISSUE_ID, 'auto', undefined, false, true);

    expect(code).toBe(0);
    const paths = await resolveIssuePaths(ISSUE_ID);
    const plan = JSON.parse(await readFile(paths.tasksFile, 'utf-8')) as TaskPlan;
    expect(plan.userStories[0]).toMatchObject({
      passes: true,
      notes: 'completed by fake agent',
    });
    expect(plan.pipeline).toMatchObject({
      executionCompleted: true,
      reviewCompleted: true,
      prCreated: true,
      prReviewCompleted: true,
    });
  });

  it('a Issue é lida uma única vez e fechada pelo provider da origem', async () => {
    expect(await runPipeline(ISSUE_ID, 'auto')).toBe(0);

    // One read for the whole run: the origin is settled once and propagated.
    expect(provider.calls.get).toBe(1);
    expect(provider.calls.close).toBe(1);
    expect(provider.peek(ISSUE_ID)?.state).toBe('closed');
  });

  it('a Issue não é fechada nem procurada como PR no GitHub', async () => {
    expect(await runPipeline(ISSUE_ID, 'auto')).toBe(0);

    // `gh issue view` is expected (the GitHub origin is queried like any other),
    // but nothing may be written to GitHub, and the PR lookup of the summary is
    // GitHub-only — an Issue from another origin must not trigger it.
    //
    // The one `gh pr` call that *is* expected is the idempotence guard of the
    // `pr` phase (`--state open`, US-021): the Pull Request itself is a GitHub
    // object whatever the Issue's origin, so "is one already open for this
    // branch" is a question that has to be asked before opening a second one.
    const isAdoptionGuard = (args: readonly string[]) =>
      args[0] === 'pr' && args[1] === 'list' && args.includes('open');

    const forbidden = vi
      .mocked(execa)
      .mock.calls.filter(
        ([file, args]) =>
          file === 'gh' &&
          Array.isArray(args) &&
          !isAdoptionGuard(args) &&
          (args[0] === 'pr' || (args[0] === 'issue' && args[1] !== 'view')),
      );
    expect(forbidden).toEqual([]);
  });

  it('o PR omite o Closes #N para uma origem sem contraparte remota', async () => {
    // Only an Issue GitHub hosts can be closed by reference; inventing a `#N`
    // for an origin without a remote would point at an unrelated Issue.
    const { runPr } = await import('../commands/pr.js');
    expect(await runPr(ISSUE_ID)).toBe(0);

    expect(prompts[0]).not.toMatch(/Closes #\d/);
  });
});

/**
 * The other half of the promise: the pipeline accommodates the new origin
 * because it never names it. If a command or a template ever gains a branch for
 * 'memory', this fails — and so would the equivalent branch for any third-party
 * origin that follows.
 */
describe('nem os comandos nem os templates conhecem a origem nova', () => {
  const COMMANDS_DIR = fileURLToPath(new URL('../commands', import.meta.url));
  /** The origin name as a code literal ('memory' / "memory"), not as prose. */
  const NAMED_SOURCE = /(['"])memory\1/;

  it('nenhum arquivo em src/commands/ menciona a origem', async () => {
    const names = (await readdir(COMMANDS_DIR)).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(names.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const name of names) {
      const content = await readFile(join(COMMANDS_DIR, name), 'utf-8');
      if (NAMED_SOURCE.test(content)) {
        offenders.push(name);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('nenhum template em prompts/ menciona a origem', async () => {
    const promptsDir = resolvePackageDir('prompts');
    expect(promptsDir).not.toBeNull();

    const names = (await readdir(promptsDir as string)).filter((name) => name.endsWith('.md'));
    expect(names.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const name of names) {
      const content = await readFile(join(promptsDir as string, name), 'utf-8');
      if (content.includes(MEMORY_SOURCE)) {
        offenders.push(name);
      }
    }

    expect(offenders).toEqual([]);
  });
});
