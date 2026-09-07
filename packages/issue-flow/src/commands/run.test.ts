import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setIssuesCliOverrides, setWebCliOverrides } from '../config.js';
import { sessionSnapshotSchema } from '../schemas.js';
import type { WebServerHandle, WebServerOptions } from '../web/server.js';

vi.mock('./init.js', () => ({ runInit: vi.fn(async () => 0) }));
vi.mock('./prd.js', () => ({ runPrd: vi.fn(async () => 0) }));
vi.mock('./plan.js', () => ({ runPlan: vi.fn(async () => 0) }));
vi.mock('./execute.js', () => ({ runExecute: vi.fn(async () => 0) }));
vi.mock('./review.js', () => ({ runReview: vi.fn(async () => 0) }));
vi.mock('./pr.js', () => ({ runPr: vi.fn(async () => 0) }));
vi.mock('./pr-review.js', () => ({ runPrReview: vi.fn(async () => 0) }));

// resolveIssuePaths() shells out to `git rev-parse --show-toplevel` (via
// utils/git.ts) to identify the project instead of trusting process.cwd().
// Every test below chdir's into a fresh tmpdir that is not itself a git repo,
// so that call must be stubbed to answer with the same tmpdir — mutated per
// test via mockProjectRoot.current — for the project id (and therefore every
// path under ISSUE_FLOW_HOME) to stay deterministic per test. Every other execa
// invocation keeps the previous harmless default.
const mockProjectRoot = vi.hoisted(() => ({ current: '' }));
// Branch answered by `git branch --show-current`; empty (the previous default)
// unless a test needs the summary to look a Pull Request up by head branch.
const mockBranch = vi.hoisted(() => ({ current: '' }));
vi.mock('execa', () => ({
  execa: vi.fn(async (file: string, args: string[] = []) => {
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { stdout: mockProjectRoot.current, exitCode: 0 };
    }
    // The repository preflight (US-019) asks which branch HEAD points at; a
    // failing answer here would read as a detached HEAD and block every phase
    // that writes.
    if (file === 'git' && args[0] === 'symbolic-ref') {
      return { stdout: `refs/heads/${mockBranch.current || 'main'}\n`, exitCode: 0 };
    }
    if (file === 'git' && args[0] === 'branch' && args[1] === '--show-current') {
      return { stdout: mockBranch.current, exitCode: 0 };
    }
    // No remote: the project id is derived from the temporary root's path,
    // which keeps it deterministic per test instead of picking up whatever the
    // generic branch below happens to return.
    if (file === 'git' && args[0] === 'remote' && args[1] === 'get-url') {
      return { stdout: '', exitCode: 1 };
    }
    return { stdout: '' };
  }),
}));
// Partial mock: run.ts imports listPullRequests from the same module, and a
// literal factory would drop it from the graph.
vi.mock('../core/session-git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/session-git.js')>();
  return {
    ...actual,
    publishGitState: vi.fn(async () => {}),
    listPullRequests: vi.fn(async () => []),
  };
});

// The resolver is the single decision point; the pipeline must call it once.
vi.mock('../issues/resolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../issues/resolver.js')>();
  return { ...actual, resolveIssue: vi.fn() };
});
vi.mock('../issues/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../issues/registry.js')>();
  return { ...actual, getProvider: vi.fn() };
});

// Deterministic renderer: runs each phase runner in order, no listr2 output.
vi.mock('../ui/pipeline-renderer.js', () => ({
  runPipelineWithRenderer: vi.fn(
    async (options: {
      phases: string[];
      startIndex: number;
      runners: Record<string, () => Promise<void>>;
    }) => {
      for (let i = options.startIndex; i < options.phases.length; i++) {
        const phase = options.phases[i];
        try {
          await options.runners[phase]();
        } catch {
          return { success: false, failedPhase: phase, overallElapsedSeconds: 1 };
        }
      }
      return { success: true, overallElapsedSeconds: 1 };
    },
  ),
}));

// Wrap the real startWebServer to capture the handles it returns.
const serverHandles: WebServerHandle[] = [];
vi.mock('../web/server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/server.js')>();
  return {
    ...actual,
    startWebServer: vi.fn(async (options: WebServerOptions) => {
      const handle = await actual.startWebServer(options);
      if (handle) serverHandles.push(handle);
      return handle;
    }),
  };
});

// ensureWebMonitor() (US-002) spawns `<node> <cli> web serve ...` detached
// when no instance is active. There is no built CLI to exec from a vitest
// run (and forking a real subprocess per test would be slow and flaky), so
// this simulates the detached process in-process instead: parse the same
// argv production code passes and run the same bind-and-claim path
// `runWebServe` (commands/web.ts) uses, through the wrapped startWebServer
// above so `serverHandles` still captures the real handle. The one deliberate
// difference from `runWebServe` is a short session-directory poll interval —
// a real detached process races nothing, these tests race a 5s test timeout.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((_command: string, args: string[]) => {
      const opts: { port?: number; host?: string; refresh?: number } = {};
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '--port') opts.port = Number(args[++i]);
        else if (args[i] === '--host') opts.host = args[++i];
        else if (args[i] === '--refresh') opts.refresh = Number(args[++i]);
      }
      void (async () => {
        const { watchSessionDirectory } = await import('../web/session-directory.js');
        const { ensureSingleWebServer } = await import('../web/lock.js');
        const sessions = watchSessionDirectory({ pollIntervalMs: 20 });
        const handle = await ensureSingleWebServer({
          sessions,
          port: opts.port ?? 3737,
          host: opts.host ?? '0.0.0.0',
          refreshSeconds: opts.refresh,
          unref: false,
          info: () => {},
          warn: () => {},
        });
        if (handle?.server === undefined) sessions.close();
      })();
      return { unref: () => {} } as unknown as ReturnType<typeof actual.spawn>;
    }),
  };
});

import { execa } from 'execa';
import { parseJournal } from '../core/journal.js';
import { listPullRequests } from '../core/session-git.js';
import { getSessionPublisher } from '../core/session-publisher.js';
import { MemoryPublisher, type SessionSnapshot } from '../core/session-state.js';
import { beginShutdown, resetShutdownState } from '../core/shutdown.js';
import type { IssueProvider } from '../issues/provider.js';
import { getProvider } from '../issues/registry.js';
import { IssueResolutionError, resolveIssue } from '../issues/resolver.js';
import type { Issue, IssueSource, ResolvedIssue } from '../issues/types.js';
import { GLOBAL_ROOT_ENV } from '../storage/paths.js';
import {
  resetStorageResolutionCache,
  resolveIssuePaths,
  resolveProjectPaths,
} from '../storage/resolve.js';
import type { TaskPlan, UserStory } from '../types.js';
import { runPipelineWithRenderer } from '../ui/pipeline-renderer.js';
import { ensureSingleWebServer } from '../web/lock.js';
import { startWebServer } from '../web/server.js';
import { runExecute } from './execute.js';
import { runInit } from './init.js';
import { runPlan } from './plan.js';
import { runPr } from './pr.js';
import { runPrReview } from './pr-review.js';
import { runPrd } from './prd.js';
import { runReview } from './review.js';
import { runPipeline } from './run.js';

/**
 * `run` resolves every artifact through the global storage, so every test in
 * this file needs `ISSUE_FLOW_HOME` pointed at a throwaway directory — without
 * it the suite writes into the developer's real `~/.issue-flow`. The hooks are
 * file-level on purpose: they run before/after each `describe`'s own hooks, so
 * no block can forget them.
 */
let globalHome: string;
let previousGlobalHome: string | undefined;

beforeEach(async () => {
  globalHome = await mkdtemp(join(tmpdir(), 'issue-flow-home-'));
  previousGlobalHome = process.env[GLOBAL_ROOT_ENV];
  process.env[GLOBAL_ROOT_ENV] = globalHome;
  resetStorageResolutionCache();
});

afterEach(async () => {
  resetStorageResolutionCache();
  if (previousGlobalHome === undefined) delete process.env[GLOBAL_ROOT_ENV];
  else process.env[GLOBAL_ROOT_ENV] = previousGlobalHome;
  await rm(globalHome, { recursive: true, force: true });
});

/**
 * Where `run` actually writes: the same resolver the command uses, so the
 * assertions follow the storage layout instead of restating it by hand.
 */
const globalPaths = async (id = '42') => await resolveIssuePaths(id);

function makeResolved(
  overrides: Partial<Issue> = {},
  source: IssueSource = 'github',
): ResolvedIssue {
  const issue: Issue = {
    id: '42',
    number: 42,
    title: 'Sample issue',
    body: 'Body',
    labels: [],
    state: 'open',
    source,
    remoteRef: source === 'github' ? 'https://github.com/acme/repo/issues/42' : null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    contentHash: 'sha256:abc',
    ...overrides,
  };
  return {
    issue,
    source,
    local: source === 'local' ? issue : null,
    github: source === 'github' ? issue : null,
    divergent: false,
  };
}

/** Minimal provider double; `close` is omitted when the origin is read-only. */
function makeProvider(close?: IssueProvider['close']): IssueProvider {
  return {
    name: 'github',
    isAvailable: async () => true,
    get: async () => null,
    create: async () => {
      throw new Error('not implemented');
    },
    ...(close === undefined ? {} : { close }),
  };
}

const WEB_ENV_VARS = [
  'ISSUE_FLOW_WEB',
  'ISSUE_FLOW_WEB_PORT',
  'ISSUE_FLOW_WEB_HOST',
  'ISSUE_FLOW_WEB_REFRESH',
  'ISSUE_FLOW_WEB_LOG_LIMIT',
];

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createNetServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Run the pipeline capturing every terminal line (emit falls back to console.log). */
async function runCaptured(): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    const code = await runPipeline('42', 'auto');
    return { code, lines };
  } finally {
    spy.mockRestore();
  }
}

describe('runPipeline — impacto zero do monitoramento (US-009)', () => {
  let tmp: string;
  let originalCwd: string;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmp = await mkdtemp(join(tmpdir(), 'issue-flow-run-'));
    mockProjectRoot.current = tmp;
    process.chdir(tmp);
    for (const name of WEB_ENV_VARS) {
      savedEnv.set(name, process.env[name]);
      delete process.env[name];
    }
    setWebCliOverrides({});
    setIssuesCliOverrides({});
    serverHandles.length = 0;
    vi.clearAllMocks();
    vi.mocked(resolveIssue).mockResolvedValue(makeResolved());
    vi.mocked(getProvider).mockReturnValue(makeProvider(vi.fn(async () => {})));
  });

  afterEach(async () => {
    await Promise.all(serverHandles.map((h) => h.close()));
    setWebCliOverrides({});
    setIssuesCliOverrides({});
    for (const [name, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    process.chdir(originalCwd);
    await rm(tmp, { recursive: true, force: true });
  });

  it('sem flags: não sobe servidor nem cria session.json', async () => {
    const { code } = await runCaptured();

    expect(code).toBe(0);
    expect(vi.mocked(startWebServer)).not.toHaveBeenCalled();
    expect(existsSync((await globalPaths()).sessionFile)).toBe(false);
    // O modo desligado não cria nenhum arquivo: nem o diretório global da
    // issue, nem o legado issues/ dentro do repositório.
    expect(existsSync((await globalPaths()).issueDir)).toBe(false);
    expect(existsSync(join(tmp, 'issues'))).toBe(false);
  });

  it('sem --web o reducer persiste no SQLite sem criar projeções de arquivo', async () => {
    let publisherName = '';
    vi.mocked(runExecute).mockImplementationOnce(async () => {
      publisherName = getSessionPublisher().constructor.name;
      return 0;
    });

    const { code } = await runCaptured();

    expect(code).toBe(0);
    expect(publisherName).toBe('SqliteSessionPublisher');
    expect(existsSync((await globalPaths()).sessionFile)).toBe(false);
    expect(existsSync((await globalPaths()).issueDir)).toBe(false);
  });

  it('saída do terminal é idêntica com e sem --web (exceto a URL do servidor)', async () => {
    const { code: offCode, lines: offLines } = await runCaptured();
    expect(offCode).toBe(0);

    // host pinned to loopback: this test is about US-009 (zero pipeline
    // impact from monitoring), not about the 0.0.0.0 security warning,
    // which is covered separately in web/server.test.ts.
    setWebCliOverrides({ enabled: true, port: await getFreePort(), host: '127.0.0.1' });
    const { code: onCode, lines: onLines } = await runCaptured();
    expect(onCode).toBe(0);

    const serverLines = onLines.filter((l) => l.includes('Web monitor running at'));
    expect(serverLines).toHaveLength(1);
    // Removida a linha da URL, a saída é byte a byte igual à do modo desligado.
    expect(onLines.filter((l) => !l.includes('Web monitor running at'))).toEqual(offLines);
  });

  it('com --web: reaproveita uma instância já ativa em vez de subir outra (US-001)', async () => {
    const existing = await ensureSingleWebServer({
      publisher: new MemoryPublisher(),
      port: await getFreePort(),
      host: '127.0.0.1',
      info: () => {},
      warn: () => {},
    });
    expect(existing).not.toBeNull();
    vi.mocked(startWebServer).mockClear();

    setWebCliOverrides({ enabled: true, port: await getFreePort(), host: '127.0.0.1' });
    const { code, lines } = await runCaptured();

    expect(code).toBe(0);
    // A monitoring server was already up under the same lock: run must not
    // attempt to bind a second one.
    expect(vi.mocked(startWebServer)).not.toHaveBeenCalled();
    // The reuse line carries the version of the *reused* monitor: it is the
    // process serving the dashboard, and it may not be the one running here.
    expect(lines.some((l) => /Reusing existing web monitor v\d+\.\d+\.\d+ at /.test(l))).toBe(true);
  });

  it('com --web: ao término, session.json global contém o estado final', async () => {
    setWebCliOverrides({ enabled: true, port: await getFreePort() });

    const { code } = await runCaptured();
    expect(code).toBe(0);

    const raw = await readFile((await globalPaths()).sessionFile, 'utf-8');
    const snapshot = sessionSnapshotSchema.parse(JSON.parse(raw));
    expect(snapshot.status).toBe('completed');
    expect(snapshot.issue.number).toBe(42);
    expect(snapshot.endedAt).not.toBeNull();
    expect(snapshot.phases.length).toBeGreaterThan(0);
    expect(snapshot.phases.every((p) => p.status === 'completed')).toBe(true);
    // Nada foi escrito na árvore de trabalho: o artefato de runtime saiu do repo.
    expect(existsSync(join(tmp, 'issues'))).toBe(false);
  });

  it('publica as stories assim que plan termina, antes de execute começar', async () => {
    setWebCliOverrides({ enabled: true, port: await getFreePort() });
    vi.mocked(runPlan).mockImplementationOnce(async () => {
      const paths = await globalPaths();
      await mkdir(paths.issueDir, { recursive: true });
      await writeFile(
        paths.tasksFile,
        JSON.stringify(makePlan({ userStories: [makeStory()] }), null, 2),
        'utf-8',
      );
      return 0;
    });
    let storiesAtExecuteStart: string[] = [];
    vi.mocked(runExecute).mockImplementationOnce(async () => {
      storiesAtExecuteStart = getSessionPublisher()
        .snapshot()
        .stories.map((story) => story.id);
      return 0;
    });

    const { code } = await runCaptured();

    expect(code).toBe(0);
    expect(storiesAtExecuteStart).toEqual(['US-001']);
  });

  it('matar o servidor durante a execução não afeta o pipeline', async () => {
    setWebCliOverrides({ enabled: true, port: await getFreePort() });

    vi.mocked(runExecute).mockImplementationOnce(async () => {
      const handle = serverHandles[0];
      expect(handle).toBeDefined();
      // /api/health rather than /api/status: with the server now backed by
      // the (polled) session directory instead of an in-process publisher,
      // whether this run's own session.json has been scanned yet is a timing
      // detail this test does not care about — only that the server is up.
      const res = await fetch(`${handle.url}/api/health`);
      expect(res.status).toBe(200);
      // Simula o servidor morrendo no meio da execução.
      await handle.close();
      await expect(fetch(`${handle.url}/api/health`)).rejects.toThrow();
      return 0;
    });

    const { code } = await runCaptured();
    expect(code).toBe(0);

    // O publisher é independente do servidor: o estado final ainda é gravado.
    const raw = await readFile((await globalPaths()).sessionFile, 'utf-8');
    const snapshot = sessionSnapshotSchema.parse(JSON.parse(raw));
    expect(snapshot.status).toBe('completed');
  });

  it('resolve a Issue uma única vez e propaga a decisão a todas as fases', async () => {
    const { code } = await runCaptured();

    expect(code).toBe(0);
    expect(vi.mocked(resolveIssue)).toHaveBeenCalledTimes(1);

    const resolved = await vi.mocked(resolveIssue).mock.results[0]?.value;
    expect(vi.mocked(runPrd)).toHaveBeenCalledWith('42', resolved);
    expect(vi.mocked(runPlan)).toHaveBeenCalledWith('42', resolved, {
      continueFlag: undefined,
      startUs: undefined,
    });
    expect(vi.mocked(runReview)).toHaveBeenCalledWith('42', resolved);
    expect(vi.mocked(runPr)).toHaveBeenCalledWith('42', resolved);
  });

  it('propaga --continue e --start-us (issue #36) para a fase plan', async () => {
    const code = await runPipeline('42', 'auto', undefined, undefined, undefined, {
      continueNumbering: true,
    });
    expect(code).toBe(0);
    expect(vi.mocked(runPlan)).toHaveBeenCalledWith('42', expect.anything(), {
      continueFlag: true,
      startUs: undefined,
    });

    vi.mocked(runPlan).mockClear();
    const codeWithStartUs = await runPipeline('42', 'auto', undefined, undefined, undefined, {
      startUs: 27,
    });
    expect(codeWithStartUs).toBe(0);
    expect(vi.mocked(runPlan)).toHaveBeenCalledWith('42', expect.anything(), {
      continueFlag: undefined,
      startUs: 27,
    });
  });

  it('--no-branch mantém a branch atual no plano e a marca como não criada', async () => {
    mockBranch.current = 'develop';
    let gitAtExecute: SessionSnapshot['git'] | null = null;
    vi.mocked(runExecute).mockImplementationOnce(async () => {
      gitAtExecute = getSessionPublisher().snapshot().git;
      return 0;
    });

    try {
      const code = await runPipeline('42', 'auto', undefined, true);

      expect(code).toBe(0);
      expect(vi.mocked(runPlan)).toHaveBeenCalledWith('42', expect.anything(), {
        continueFlag: undefined,
        startUs: undefined,
        branchName: 'develop',
      });
      expect(gitAtExecute).toMatchObject({ branch: 'develop', branchCreated: false });
    } finally {
      mockBranch.current = '';
    }
  });

  it('não passa orçamento de retry à fase execute quando as flags estão ausentes', async () => {
    // The non-regression half of US-012: `run` without the new flags must hand
    // `runExecute` exactly what it handed before they existed, so `createConfig`
    // applies the engine defaults instead of a number this command invented.
    const code = await runPipeline('42', 'auto');

    expect(code).toBe(0);
    expect(vi.mocked(runExecute)).toHaveBeenCalledWith(undefined, {
      issue: '42',
      inPipeline: true,
      commitScope: undefined,
      retryLimit: undefined,
      retryForever: undefined,
    });
  });

  it('propaga --retry-limit e --retry-forever para a fase execute', async () => {
    const code = await runPipeline('42', 'auto', undefined, undefined, undefined, {
      retryLimit: 3,
      retryForever: true,
    });

    expect(code).toBe(0);
    expect(vi.mocked(runExecute)).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ issue: '42', retryLimit: 3, retryForever: true }),
    );
  });

  it('falha da resolução encerra o pipeline com o exit code do erro', async () => {
    vi.mocked(resolveIssue).mockRejectedValue(new IssueResolutionError('nowhere to be found', 2));

    const { code } = await runCaptured();

    expect(code).toBe(2);
    expect(vi.mocked(runPrd)).not.toHaveBeenCalled();
  });

  it('não fecha a Issue sem autorização explícita', async () => {
    const close = vi.fn(async () => {});
    vi.mocked(getProvider).mockReturnValue(makeProvider(close));

    const { code, lines } = await runCaptured();

    expect(code).toBe(0);
    expect(vi.mocked(getProvider)).toHaveBeenCalledWith('github');
    expect(close).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('Closing issue'))).toBe(false);
  });

  it('pula o fechamento, sem falhar, quando o provider não implementa close', async () => {
    vi.mocked(getProvider).mockReturnValue(makeProvider());

    const { code, lines } = await runCaptured();

    expect(code).toBe(0);
    expect(lines.some((l) => l.includes('Closing issue'))).toBe(false);
  });

  it('provider sem autorização de fechamento não é chamado', async () => {
    vi.mocked(getProvider).mockReturnValue(
      makeProvider(async () => {
        throw new Error('403');
      }),
    );

    const { code } = await runCaptured();

    expect(code).toBe(0);
  });

  it('origem local não consulta o PR pelo gh', async () => {
    vi.mocked(resolveIssue).mockResolvedValue(makeResolved({}, 'local'));

    const { code } = await runCaptured();

    expect(code).toBe(0);
    const ghPrCalls = vi
      .mocked(execa)
      .mock.calls.filter(
        ([file, args]) => file === 'gh' && Array.isArray(args) && args[0] === 'pr',
      );
    expect(ghPrCalls).toEqual([]);
    expect(vi.mocked(listPullRequests)).not.toHaveBeenCalled();
  });

  it('identificador local não numérico é publicado como issue.number null', async () => {
    vi.mocked(resolveIssue).mockResolvedValue(
      makeResolved({ id: 'auth-refactor', number: null }, 'local'),
    );
    setWebCliOverrides({ enabled: true, port: await getFreePort() });

    const code = await runPipeline('auth-refactor', 'auto');
    expect(code).toBe(0);

    const raw = await readFile((await globalPaths('auth-refactor')).sessionFile, 'utf-8');
    const snapshot = sessionSnapshotSchema.parse(JSON.parse(raw));
    expect(snapshot.issue.number).toBeNull();
  });

  it('recusa --background com --mode manual sem destacar nada', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      const code = await runPipeline('42', 'manual', undefined, undefined, undefined, {
        background: true,
      });
      expect(code).toBe(1);
      expect(lines.join('\n')).toMatch(/manual/);
    } finally {
      spy.mockRestore();
    }
  });

  it('sem flags, a checagem de pré-requisitos roda com a origem github', async () => {
    const { code } = await runCaptured();

    expect(code).toBe(0);
    expect(vi.mocked(runInit)).toHaveBeenCalledWith('github', { compact: true });
  });

  it('com --local, a checagem de pré-requisitos roda com a origem local (US-011)', async () => {
    setIssuesCliOverrides({ preferredProvider: 'local' });

    const { code } = await runCaptured();

    expect(code).toBe(0);
    expect(vi.mocked(runInit)).toHaveBeenCalledWith('local', { compact: true });
  });
});

/** Minimal plan the plan phase would have written. */
function makePlan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    project: 'issue-flow',
    issueNumber: 42,
    issueUrl: '',
    branchName: 'issue/42-sample',
    description: 'Sample',
    issueStatus: 'in_progress',
    completedAt: null,
    lastAttemptAt: null,
    lastError: null,
    correctionCycle: 0,
    maxCorrectionCycles: 3,
    pipeline: {
      prdCompleted: false,
      jsonCompleted: false,
      executionCompleted: false,
      reviewCompleted: false,
      prCreated: false,
    },
    userStories: [],
    ...overrides,
  };
}

describe('runPipeline — fase pr-review opcional (issue 25, US-009)', () => {
  let tmp: string;
  let originalCwd: string;
  let close: ReturnType<typeof vi.fn>;
  const savedEnv = new Map<string, string | undefined>();

  const writePlan = async (plan: TaskPlan): Promise<void> => {
    const paths = await globalPaths();
    await mkdir(paths.issueDir, { recursive: true });
    await writeFile(paths.tasksFile, JSON.stringify(plan, null, 2), 'utf-8');
  };

  const readPlan = async (): Promise<TaskPlan> =>
    JSON.parse(await readFile((await globalPaths()).tasksFile, 'utf-8')) as TaskPlan;

  /** Phases the renderer was actually asked to run (most recent invocation). */
  const renderedPhases = (): string[] => {
    const calls = vi.mocked(runPipelineWithRenderer).mock.calls;
    return calls[calls.length - 1]?.[0].phases ?? [];
  };

  const runCapturingLines = async (
    prReview?: boolean,
  ): Promise<{ code: number; lines: string[] }> => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      const code = await runPipeline('42', 'auto', undefined, undefined, prReview);
      return { code, lines };
    } finally {
      spy.mockRestore();
    }
  };

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmp = await mkdtemp(join(tmpdir(), 'issue-flow-run-pr-review-'));
    mockProjectRoot.current = tmp;
    process.chdir(tmp);
    for (const name of WEB_ENV_VARS) {
      savedEnv.set(name, process.env[name]);
      delete process.env[name];
    }
    setWebCliOverrides({});
    setIssuesCliOverrides({});
    vi.clearAllMocks();
    vi.mocked(resolveIssue).mockResolvedValue(makeResolved());
    close = vi.fn(async () => {});
    vi.mocked(getProvider).mockReturnValue(makeProvider(close));
    vi.mocked(runPrReview).mockResolvedValue(0);
  });

  afterEach(async () => {
    setWebCliOverrides({});
    setIssuesCliOverrides({});
    for (const [name, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    process.chdir(originalCwd);
    await rm(tmp, { recursive: true, force: true });
  });

  it('sem a flag: fases idênticas às atuais, fase não roda e a Issue fica aberta', async () => {
    const { code } = await runCapturingLines();

    expect(code).toBe(0);
    expect(renderedPhases()).toEqual(['prd', 'plan', 'execute', 'review', 'pr']);
    expect(vi.mocked(runPrReview)).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('com a flag: a fase entra ao final da ordem e roda sem confirmação', async () => {
    const { code } = await runCapturingLines(true);

    expect(code).toBe(0);
    expect(renderedPhases()).toEqual(['prd', 'plan', 'execute', 'review', 'pr', 'pr-review']);
    expect(vi.mocked(runPrReview)).toHaveBeenCalledWith(undefined, { issue: '42', yes: true });
    expect(close).not.toHaveBeenCalled();
  });

  it('veredito REQUEST_CHANGES: pipeline retorna 0, não fecha a Issue e destaca o aviso', async () => {
    await writePlan(makePlan({ issueStatus: 'in_progress', completedAt: null }));
    vi.mocked(runPrReview).mockResolvedValue(2);

    const { code, lines } = await runCapturingLines(true);

    expect(code).toBe(0);
    expect(close).not.toHaveBeenCalled();
    expect(lines.some((l) => l.includes('PR review requested changes'))).toBe(true);
    expect(lines.some((l) => l.includes('REQUEST_CHANGES'))).toBe(true);
    expect(lines.some((l) => l.includes('Pipeline complete'))).toBe(false);

    const plan = await readPlan();
    expect(plan.issueStatus).toBe('in_progress');
    expect(plan.completedAt).toBeNull();
    expect(plan.prReview?.enabled).toBe(true);
  });

  it('opt-in mid-pipeline (--from pr) persiste enabled para retomadas sem a flag', async () => {
    await writePlan(
      makePlan({
        pipeline: {
          prdCompleted: true,
          jsonCompleted: true,
          executionCompleted: true,
          reviewCompleted: true,
          prCreated: false,
        },
      }),
    );
    vi.mocked(runPrReview).mockResolvedValue(2);

    const first = await runPipeline('42', 'auto', 'pr', undefined, true);
    expect(first).toBe(0);
    expect((await readPlan()).prReview?.enabled).toBe(true);

    vi.mocked(runPrReview).mockClear();
    vi.mocked(runPrReview).mockResolvedValue(0);
    // Simulate the incomplete phase the previous REQUEST_CHANGES left behind.
    const afterReview = await readPlan();
    afterReview.pipeline.prCreated = true;
    afterReview.pipeline.prReviewCompleted = false;
    afterReview.prReview = {
      ...afterReview.prReview,
      enabled: true,
      rounds: afterReview.prReview?.rounds ?? 1,
      lastRecommendation: 'REQUEST_CHANGES',
    };
    await writePlan(afterReview);

    const second = await runPipeline('42', 'auto');
    expect(second).toBe(0);
    expect(vi.mocked(runPrReview)).toHaveBeenCalledTimes(1);
    expect(renderedPhases()).toContain('pr-review');
  });

  it('falha de execução da fase (código 1) derruba a pipeline', async () => {
    vi.mocked(runPrReview).mockResolvedValue(1);

    const { code } = await runCapturingLines(true);

    expect(code).toBe(1);
    expect(close).not.toHaveBeenCalled();
  });

  it('a opção é persistida em tasks.json logo após a fase plan', async () => {
    // `Once`, not a persistent implementation: `vi.clearAllMocks()` clears
    // calls but keeps implementations, so a lasting one would still be
    // installed in the next describe block — and now that every block writes
    // to the same resolved global path, it would overwrite that block's plan.
    vi.mocked(runPlan).mockImplementationOnce(async () => {
      await writePlan(makePlan());
      return 0;
    });

    const { code } = await runCapturingLines(true);

    expect(code).toBe(0);
    expect((await readPlan()).prReview?.enabled).toBe(true);
  });

  it('sem a flag, o valor persistido no plano liga a fase', async () => {
    await writePlan(makePlan({ prReview: { enabled: true, rounds: 0 } }));

    const { code } = await runCapturingLines();

    expect(code).toBe(0);
    expect(renderedPhases()).toContain('pr-review');
    expect(vi.mocked(runPrReview)).toHaveBeenCalledTimes(1);
  });

  it('--no-branch persistido descarta o opt-in em vez de falhar', async () => {
    await writePlan(makePlan({ noBranch: true, prReview: { enabled: true, rounds: 0 } }));

    const { code } = await runCapturingLines(true);

    expect(code).toBe(0);
    expect(renderedPhases()).toEqual(['prd', 'plan', 'execute', 'review']);
    expect(vi.mocked(runPrReview)).not.toHaveBeenCalled();
  });
});

describe('runPipeline — URL do PR no resumo final (issue 25, US-010)', () => {
  let tmp: string;
  let originalCwd: string;
  const savedEnv = new Map<string, string | undefined>();

  const writePlan = async (plan: TaskPlan): Promise<void> => {
    const paths = await globalPaths();

    await mkdir(paths.issueDir, { recursive: true });
    await writeFile(paths.tasksFile, JSON.stringify(plan, null, 2), 'utf-8');
  };

  /** The `PR:` line of the final summary, without the label. */
  const prLine = (lines: string[]): string | undefined =>
    lines
      .find((l) => l.trimStart().startsWith('PR:'))
      ?.replace(/^\s*PR:\s*/, '')
      .trim();

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmp = await mkdtemp(join(tmpdir(), 'issue-flow-run-pr-url-'));
    mockProjectRoot.current = tmp;
    mockBranch.current = 'issue/42-sample';
    process.chdir(tmp);
    for (const name of WEB_ENV_VARS) {
      savedEnv.set(name, process.env[name]);
      delete process.env[name];
    }
    setWebCliOverrides({});
    setIssuesCliOverrides({});
    vi.clearAllMocks();
    vi.mocked(resolveIssue).mockResolvedValue(makeResolved());
    vi.mocked(getProvider).mockReturnValue(makeProvider(vi.fn(async () => {})));
    vi.mocked(listPullRequests).mockResolvedValue([]);
  });

  afterEach(async () => {
    mockBranch.current = '';
    setWebCliOverrides({});
    setIssuesCliOverrides({});
    for (const [name, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    process.chdir(originalCwd);
    await rm(tmp, { recursive: true, force: true });
  });

  it('usa a URL persistida pela fase pr, sem consultar o gh', async () => {
    await writePlan(
      makePlan({
        pullRequest: {
          number: 184,
          url: 'https://github.com/acme/repo/pull/184',
          headBranch: 'issue/42-sample',
          createdAt: '2026-01-01T00:00:00Z',
        },
      }),
    );

    const { code, lines } = await runCaptured();

    expect(code).toBe(0);
    expect(prLine(lines)).toBe('https://github.com/acme/repo/pull/184');
    expect(vi.mocked(listPullRequests)).not.toHaveBeenCalled();
  });

  it('sem URL no plano, busca pela branch atual e usa o PR mais recente', async () => {
    await writePlan(makePlan());
    vi.mocked(listPullRequests).mockResolvedValue([
      { number: 12, url: 'https://github.com/acme/repo/pull/12', title: 'old' },
      { number: 184, url: 'https://github.com/acme/repo/pull/184', title: 'new' },
    ]);

    const { code, lines } = await runCaptured();

    expect(code).toBe(0);
    expect(vi.mocked(listPullRequests)).toHaveBeenCalledWith('issue/42-sample');
    expect(prLine(lines)).toBe('https://github.com/acme/repo/pull/184');
  });

  it('nenhum PR encontrado mantém unknown, sem exceção', async () => {
    vi.mocked(listPullRequests).mockRejectedValue(new Error('gh exploded'));

    const { code, lines } = await runCaptured();

    expect(code).toBe(0);
    expect(prLine(lines)).toBe('unknown');
  });

  it('branch indetectável (detached HEAD) não consulta o gh', async () => {
    mockBranch.current = '';

    const { code, lines } = await runCaptured();

    expect(code).toBe(0);
    expect(vi.mocked(listPullRequests)).not.toHaveBeenCalled();
    expect(prLine(lines)).toBe('unknown');
  });
});

describe('runPipeline — superfícies de UI e monitoramento (issue 25, US-011)', () => {
  let tmp: string;
  let originalCwd: string;
  const savedEnv = new Map<string, string | undefined>();

  const writePlan = async (plan: TaskPlan): Promise<void> => {
    const paths = await globalPaths();
    await mkdir(paths.issueDir, { recursive: true });
    await writeFile(paths.tasksFile, JSON.stringify(plan, null, 2), 'utf-8');
  };

  const runCapturingLines = async (
    prReview?: boolean,
  ): Promise<{ code: number; lines: string[] }> => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    try {
      const code = await runPipeline('42', 'auto', undefined, undefined, prReview);
      return { code, lines };
    } finally {
      spy.mockRestore();
    }
  };

  /** Session snapshot the web UI reads, after the run finished. */
  const readSnapshot = async () =>
    sessionSnapshotSchema.parse(
      JSON.parse(await readFile((await globalPaths()).sessionFile, 'utf-8')),
    );

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmp = await mkdtemp(join(tmpdir(), 'issue-flow-run-ui-'));
    mockProjectRoot.current = tmp;
    process.chdir(tmp);
    for (const name of WEB_ENV_VARS) {
      savedEnv.set(name, process.env[name]);
      delete process.env[name];
    }
    setWebCliOverrides({});
    setIssuesCliOverrides({});
    serverHandles.length = 0;
    vi.clearAllMocks();
    vi.mocked(resolveIssue).mockResolvedValue(makeResolved());
    vi.mocked(getProvider).mockReturnValue(makeProvider(vi.fn(async () => {})));
    vi.mocked(runPrReview).mockResolvedValue(0);
  });

  afterEach(async () => {
    await Promise.all(serverHandles.map((h) => h.close()));
    setWebCliOverrides({});
    setIssuesCliOverrides({});
    for (const [name, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    process.chdir(originalCwd);
    await rm(tmp, { recursive: true, force: true });
  });

  it('sem a flag, session.json continua listando apenas as fases padrão', async () => {
    setWebCliOverrides({ enabled: true, port: await getFreePort(), host: '127.0.0.1' });

    const { code } = await runCapturingLines();
    expect(code).toBe(0);

    const snapshot = await readSnapshot();
    expect(snapshot.phases.map((p) => p.name)).toEqual([
      'init',
      'prd',
      'plan',
      'execute',
      'review',
      'pr',
    ]);
    expect(snapshot.progress.phasesTotal).toBe(6);
  });

  it('com a flag, pr-review aparece em phases[] e entra no total de progresso', async () => {
    setWebCliOverrides({ enabled: true, port: await getFreePort(), host: '127.0.0.1' });

    const { code } = await runCapturingLines(true);
    expect(code).toBe(0);

    const snapshot = await readSnapshot();
    expect(snapshot.phases.map((p) => p.name)).toEqual([
      'init',
      'prd',
      'plan',
      'execute',
      'review',
      'pr',
      'pr-review',
    ]);
    // phasesTotal vem do session:start, então o denominador da UI web já
    // considera a fase opcional desde o começo da execução.
    expect(snapshot.progress.phasesTotal).toBe(7);
    expect(snapshot.phases.every((p) => p.status === 'completed')).toBe(true);
  });

  it('o resumo final exibe a recomendação e o caminho do relatório', async () => {
    await writePlan(
      makePlan({
        prReview: {
          enabled: true,
          rounds: 1,
          pullRequestNumber: 184,
          lastRecommendation: 'APPROVE_WITH_SUGGESTIONS',
          lastReviewedAt: '2026-01-01T00:00:00Z',
        },
      }),
    );
    const reviewDir = (await globalPaths()).prReviewDir;
    await mkdir(reviewDir, { recursive: true });
    await writeFile(
      join(reviewDir, 'index.json'),
      JSON.stringify({
        schemaVersion: 1,
        pullRequest: { number: 184, url: null, title: null, headBranch: null },
        rounds: [
          {
            round: 1,
            at: '2026-01-01T00:00:00Z',
            recommendation: 'APPROVE_WITH_SUGGESTIONS',
            headSha: null,
            reportPath: 'pr-184-round-1.md',
            findings: [],
          },
        ],
      }),
      'utf-8',
    );

    const { code, lines } = await runCapturingLines(true);

    expect(code).toBe(0);
    const summaryLine = (label: string): string | undefined =>
      lines
        .find((l) => l.trimStart().startsWith(label))
        ?.replace(new RegExp(`^\\s*${label}\\s*`), '')
        .trim();
    expect(summaryLine('Review:')).toBe('APPROVE_WITH_SUGGESTIONS');
    expect(summaryLine('Report:')).toBe(join(reviewDir, 'pr-184-round-1.md'));
  });

  it('sem a flag, o resumo final não ganha nenhuma linha nova', async () => {
    const { code, lines } = await runCapturingLines();

    expect(code).toBe(0);
    expect(lines.some((l) => l.trimStart().startsWith('Review:'))).toBe(false);
    expect(lines.some((l) => l.trimStart().startsWith('Report:'))).toBe(false);
  });
});

/** Minimal story the plan phase would have written. */
function makeStory(overrides: Partial<UserStory> = {}): UserStory {
  return {
    id: 'US-001',
    title: 'First story',
    description: 'Test story',
    acceptanceCriteria: ['Criterion 1'],
    priority: 1,
    passes: false,
    notes: '',
    ...overrides,
  };
}

describe('runPipeline — enriquecimento do snapshot no início da sessão (issue 29, US-003/US-004)', () => {
  let tmp: string;
  let originalCwd: string;
  const savedEnv = new Map<string, string | undefined>();

  const writePlan = async (plan: TaskPlan): Promise<void> => {
    const paths = await globalPaths();
    await mkdir(paths.issueDir, { recursive: true });
    await writeFile(paths.tasksFile, JSON.stringify(plan, null, 2), 'utf-8');
  };

  /**
   * Snapshot the web UI would see at its first poll: `/api/status` is read from
   * inside the very first phase runner, so anything asserted here was already
   * in the snapshot before a single phase did any work.
   */
  const snapshotAtFirstPhase = async (): Promise<SessionSnapshot> => {
    const box: { snapshot: SessionSnapshot | null } = { snapshot: null };
    vi.mocked(runPrd).mockImplementationOnce(async () => {
      const handle = serverHandles[0];
      expect(handle).toBeDefined();
      // The server now discovers this run's session through a polled
      // directory scan (US-003) instead of holding it in memory, so it can
      // briefly answer "no active session" right after startup — poll for it
      // instead of asserting on the very first fetch.
      let payload: unknown;
      const deadline = Date.now() + 2000;
      do {
        const res = await fetch(`${handle.url}/api/status`);
        if (res.status === 200) {
          payload = await res.json();
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      } while (Date.now() < deadline);
      box.snapshot = sessionSnapshotSchema.parse(payload);
      return 0;
    });

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runPipeline('42', 'auto')).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(box.snapshot).not.toBeNull();
    return box.snapshot as SessionSnapshot;
  };

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmp = await mkdtemp(join(tmpdir(), 'issue-flow-run-seed-'));
    mockProjectRoot.current = tmp;
    process.chdir(tmp);
    for (const name of WEB_ENV_VARS) {
      savedEnv.set(name, process.env[name]);
      delete process.env[name];
    }
    setWebCliOverrides({});
    setIssuesCliOverrides({});
    serverHandles.length = 0;
    vi.clearAllMocks();
    vi.mocked(resolveIssue).mockResolvedValue(makeResolved());
    vi.mocked(getProvider).mockReturnValue(makeProvider(vi.fn(async () => {})));
    setWebCliOverrides({ enabled: true, port: await getFreePort(), host: '127.0.0.1' });
  });

  afterEach(async () => {
    await Promise.all(serverHandles.map((h) => h.close()));
    setWebCliOverrides({});
    setIssuesCliOverrides({});
    for (const [name, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    process.chdir(originalCwd);
    await rm(tmp, { recursive: true, force: true });
  });

  it('com tasks.json em disco, as stories já estão no snapshot antes da primeira fase', async () => {
    await writePlan(
      makePlan({
        userStories: [
          makeStory({ id: 'US-001', passes: true }),
          makeStory({ id: 'US-002', title: 'Second', priority: 2, dependencies: ['US-001'] }),
        ],
      }),
    );

    const snapshot = await snapshotAtFirstPhase();

    expect(snapshot.stories.map((s) => s.id)).toEqual(['US-001', 'US-002']);
    expect(snapshot.progress.storiesTotal).toBe(2);
    expect(snapshot.progress.storiesCompleted).toBe(1);
    expect(snapshot.stories[1].dependencies).toEqual(['US-001']);
    // Já passava antes desta sessão: duração desconhecida, não zero.
    expect(snapshot.stories[0].completedAt).toBeNull();
    // O seed não mexe no progresso de fases: a porcentagem continua vindo delas.
    expect(snapshot.progress.phasesCompleted).toBe(1);
    expect(snapshot.progress.percent).toBeGreaterThan(0);
  });

  it('sem tasks.json, nada é semeado e o card fica vazio como antes', async () => {
    const snapshot = await snapshotAtFirstPhase();

    expect(snapshot.stories).toEqual([]);
    expect(snapshot.progress.storiesTotal).toBe(0);
  });

  it('com tasks.json sem user stories, nada é publicado', async () => {
    await writePlan(makePlan({ userStories: [] }));

    const snapshot = await snapshotAtFirstPhase();

    expect(snapshot.stories).toEqual([]);
    expect(snapshot.progress.storiesTotal).toBe(0);
  });

  it('a Issue resolvida já está no snapshot antes da primeira fase', async () => {
    vi.mocked(resolveIssue).mockResolvedValue(
      makeResolved({
        title: 'Enriquecer o snapshot do monitor',
        body: 'Corpo completo\ncom mais de uma linha',
        labels: ['enhancement', 'monitor'],
      }),
    );

    const snapshot = await snapshotAtFirstPhase();

    expect(snapshot.issue).toEqual({
      number: 42,
      url: 'https://github.com/acme/repo/issues/42',
      title: 'Enriquecer o snapshot do monitor',
      // Publicada na íntegra, sem truncamento.
      description: 'Corpo completo\ncom mais de uma linha',
      labels: ['enhancement', 'monitor'],
      state: 'open',
    });
  });

  it('com origem local sem remote, a URL vinda do plano é preservada', async () => {
    vi.mocked(resolveIssue).mockResolvedValue(makeResolved({ title: 'Local' }, 'local'));
    await writePlan(makePlan({ issueUrl: 'https://github.com/acme/repo/issues/42' }));

    const snapshot = await snapshotAtFirstPhase();

    expect(snapshot.issue.url).toBe('https://github.com/acme/repo/issues/42');
    expect(snapshot.issue.title).toBe('Local');
  });
});

describe('run ownership (US-017)', () => {
  let originalCwd: string;
  let tmp: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmp = await mkdtemp(join(tmpdir(), 'issue-flow-lock-run-'));
    mockProjectRoot.current = tmp;
    process.chdir(tmp);
    setWebCliOverrides({});
    setIssuesCliOverrides({});
    vi.clearAllMocks();
    vi.mocked(resolveIssue).mockResolvedValue(makeResolved());
    vi.mocked(getProvider).mockReturnValue(makeProvider(vi.fn(async () => {})));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tmp, { recursive: true, force: true });
  });

  it('refuses when another live process owns the project, naming it', async () => {
    const { runLockFile } = await resolveProjectPaths();
    await mkdir(dirname(runLockFile), { recursive: true });
    // pid 1 exists on every platform this runs on, and its heartbeat is now:
    // a live owner, which is precisely what must not be taken over.
    await writeFile(
      runLockFile,
      JSON.stringify({
        pid: 1,
        host: hostname(),
        target: '101',
        startedAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
      }),
      'utf-8',
    );

    const code = await runPipeline('42', 'auto');

    expect(code).toBe(1);
    // Not a single phase ran: the refusal happens before any work.
    expect(vi.mocked(runInit)).not.toHaveBeenCalled();
    // And the owner's lock is untouched.
    const still = JSON.parse(await readFile(runLockFile, 'utf-8'));
    expect(still).toMatchObject({ pid: 1, target: '101' });
  });

  it('releases the lock when the run finishes, so the next one starts clean', async () => {
    const { runLockFile } = await resolveProjectPaths();

    await expect(runPipeline('42', 'auto')).resolves.toBe(0);

    expect(existsSync(runLockFile)).toBe(false);
    await expect(runPipeline('42', 'auto')).resolves.toBe(0);
  });

  it('takes over a lock whose owner is gone and records it as interrupted', async () => {
    const { runLockFile } = await resolveProjectPaths();
    await mkdir(dirname(runLockFile), { recursive: true });
    await writeFile(
      runLockFile,
      JSON.stringify({
        pid: 0x7ffffffe,
        host: hostname(),
        target: '101',
        startedAt: '2026-08-30T03:00:00.000Z',
        lastHeartbeatAt: '2026-08-30T03:00:00.000Z',
      }),
      'utf-8',
    );

    await expect(runPipeline('42', 'auto')).resolves.toBe(0);

    // It ran, and the stale lock is gone rather than inherited.
    expect(vi.mocked(runInit)).toHaveBeenCalled();
    expect(existsSync(runLockFile)).toBe(false);
  });
});

describe('graceful shutdown (US-020)', () => {
  let originalCwd: string;
  let tmp: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmp = await mkdtemp(join(tmpdir(), 'issue-flow-shutdown-'));
    mockProjectRoot.current = tmp;
    process.chdir(tmp);
    setWebCliOverrides({});
    setIssuesCliOverrides({});
    vi.clearAllMocks();
    resetShutdownState();
    vi.mocked(resolveIssue).mockResolvedValue(makeResolved());
    vi.mocked(getProvider).mockReturnValue(makeProvider(vi.fn(async () => {})));
  });

  afterEach(async () => {
    resetShutdownState();
    process.chdir(originalCwd);
    await rm(tmp, { recursive: true, force: true });
  });

  it('checkpoints the issue as paused, and a later resume finds the same phases done', async () => {
    const paths = await globalPaths();
    await mkdir(paths.issueDir, { recursive: true });
    await writeFile(
      paths.tasksFile,
      JSON.stringify(
        makePlan({
          pipeline: {
            prdCompleted: true,
            jsonCompleted: true,
            executionCompleted: false,
            reviewCompleted: false,
            prCreated: false,
          },
        }),
        null,
        2,
      ),
      'utf-8',
    );

    // The pipeline blocks inside `execute`, which is where a real interrupt
    // lands: the agent is running and the plan is half written.
    let releaseExecute: () => void = () => {};
    const executing = new Promise<void>((resolve) => {
      releaseExecute = resolve;
    });
    let executeStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      executeStarted = resolve;
    });
    vi.mocked(runExecute).mockImplementation(async () => {
      executeStarted();
      await executing;
      return 0;
    });

    const pipeline = runPipeline('42', 'auto', 'execute');
    await started;

    const exits: number[] = [];
    await beginShutdown('SIGINT', {
      graceMs: 0,
      exit: (code) => void exits.push(code),
      notify: () => {},
    });

    // The checkpoint ran while the phase was still in flight.
    const paused = JSON.parse(await readFile(paths.tasksFile, 'utf-8')) as TaskPlan;
    expect(paused.runState?.status).toBe('paused');
    expect(paused.runState?.lastHeartbeatAt).not.toBeNull();
    // And the phases that had finished are still marked finished, which is what
    // makes the later resume pick up at `execute` instead of starting over.
    expect(paused.pipeline.prdCompleted).toBe(true);
    expect(paused.pipeline.jsonCompleted).toBe(true);
    expect(paused.pipeline.executionCompleted).toBe(false);
    expect(exits).toEqual([130]);

    releaseExecute();
    await pipeline;
  });

  it('publishes session:end and closes the journal, so nothing stays on running', async () => {
    // The journal is the surface that proves it without binding a web server:
    // it receives the same event stream, and it is closed by the `close` phase
    // of the shutdown.
    process.env.ISSUE_FLOW_RESILIENCE_JOURNAL = 'true';
    try {
      const paths = await globalPaths();
      await mkdir(paths.issueDir, { recursive: true });
      await writeFile(
        paths.tasksFile,
        JSON.stringify(
          makePlan({
            pipeline: {
              prdCompleted: true,
              jsonCompleted: true,
              executionCompleted: false,
              reviewCompleted: false,
              prCreated: false,
            },
          }),
          null,
          2,
        ),
        'utf-8',
      );

      let releaseExecute: () => void = () => {};
      const executing = new Promise<void>((resolve) => {
        releaseExecute = resolve;
      });
      let executeStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        executeStarted = resolve;
      });
      vi.mocked(runExecute).mockImplementation(async () => {
        executeStarted();
        await executing;
        return 0;
      });

      const pipeline = runPipeline('42', 'auto', 'execute');
      await started;

      await beginShutdown('SIGINT', { graceMs: 0, exit: () => {}, notify: () => {} });

      const journal = await readFile(paths.eventsFile, 'utf-8');
      const types = parseJournal(journal).map((entry) => entry.event.type);
      // The run said it ended. Without this, `session.json` (and every reader
      // of the stream) would show `running` forever.
      expect(types).toContain('session:end');

      releaseExecute();
      await pipeline;
    } finally {
      delete process.env.ISSUE_FLOW_RESILIENCE_JOURNAL;
    }
  });
});

/**
 * The entry half of §17's convergence, end to end: `--prompt` mints an Issue
 * of the `inline` origin and hands `run` its identifier. Everything after that
 * is the pipeline `run` always had — which is the point: there is no second
 * execution path with fewer guarantees.
 */
describe('runPipeline — free prompt as an inline Issue (§17)', () => {
  let tmp: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmp = await mkdtemp(join(tmpdir(), 'issue-flow-run-prompt-'));
    mockProjectRoot.current = tmp;
    process.chdir(tmp);
    setWebCliOverrides({});
    setIssuesCliOverrides({});
    vi.clearAllMocks();
    vi.mocked(getProvider).mockReturnValue(makeProvider());
  });

  afterEach(async () => {
    setWebCliOverrides({});
    setIssuesCliOverrides({});
    process.chdir(originalCwd);
    await rm(tmp, { recursive: true, force: true });
  });

  it('runs the whole pipeline on an Issue minted from the prompt', async () => {
    const seen: string[] = [];
    vi.mocked(resolveIssue).mockImplementation(async (id: string) => {
      seen.push(id);
      return makeResolved({ id, number: null, title: 'Fix the flaky cache test' }, 'inline');
    });

    const code = await runPipeline([], 'auto', undefined, true, undefined, {
      prompt: 'Fix the flaky cache test\n\nIt only fails on CI.',
    });

    expect(code).toBe(0);
    expect(seen[0]).toMatch(/^inline-[0-9a-f]{12}$/);
    // The phases are the ordinary ones: nothing about an inline demand
    // shortens the pipeline or skips the review.
    expect(vi.mocked(runPrd)).toHaveBeenCalled();
    expect(vi.mocked(runPlan)).toHaveBeenCalled();
    expect(vi.mocked(runExecute)).toHaveBeenCalled();
    expect(vi.mocked(runReview)).toHaveBeenCalled();
  });

  it('addresses the same Issue when the same demand is run twice', async () => {
    const seen: string[] = [];
    vi.mocked(resolveIssue).mockImplementation(async (id: string) => {
      seen.push(id);
      return makeResolved({ id, number: null }, 'inline');
    });

    await runPipeline([], 'auto', undefined, true, undefined, { prompt: 'Same demand' });
    await runPipeline([], 'auto', undefined, true, undefined, { prompt: '  Same demand  ' });

    expect(seen[0]).toBe(seen[1]);
  });

  it('refuses an invocation with no demand at all', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    try {
      expect(await runPipeline([], 'auto')).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(errors.join('\n')).toMatch(/--prompt/);
    expect(vi.mocked(resolveIssue)).not.toHaveBeenCalled();
  });

  it('refuses an issue number and a prompt in the same invocation', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runPipeline(['42'], 'auto', undefined, true, undefined, { prompt: 'x' })).toBe(
        1,
      );
    } finally {
      spy.mockRestore();
    }
    expect(vi.mocked(resolveIssue)).not.toHaveBeenCalled();
  });
});
