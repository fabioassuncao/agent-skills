import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { type AddressInfo, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

// getIssueDir() shells out to `git rev-parse --show-toplevel` (via utils/git.ts)
// to anchor issues/<N>/ to the repo root instead of process.cwd(). Every test
// below chdir's into a fresh tmpdir that is not itself a git repo, so that
// call must be stubbed to answer with the same tmpdir — mutated per test via
// mockProjectRoot.current — for issueDir to resolve to the join(tmp, 'issues',
// ...) path the assertions already expect. Every other execa invocation keeps
// the previous harmless default.
const mockProjectRoot = vi.hoisted(() => ({ current: '' }));
vi.mock('execa', () => ({
  execa: vi.fn(async (file: string, args: string[] = []) => {
    if (file === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      return { stdout: mockProjectRoot.current, exitCode: 0 };
    }
    return { stdout: '' };
  }),
}));
vi.mock('../core/session-git.js', () => ({ publishGitState: vi.fn(async () => {}) }));

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

import { execa } from 'execa';
import type { IssueProvider } from '../issues/provider.js';
import { getProvider } from '../issues/registry.js';
import { IssueResolutionError, resolveIssue } from '../issues/resolver.js';
import type { Issue, IssueSource, ResolvedIssue } from '../issues/types.js';
import { startWebServer } from '../web/server.js';
import { runExecute } from './execute.js';
import { runInit } from './init.js';
import { runPlan } from './plan.js';
import { runPr } from './pr.js';
import { runPrd } from './prd.js';
import { runReview } from './review.js';
import { runPipeline } from './run.js';

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
    expect(existsSync(join(tmp, 'issues', '42', 'session.json'))).toBe(false);
    // O modo desligado não cria nenhum arquivo: o diretório issues/ nem existe.
    expect(existsSync(join(tmp, 'issues'))).toBe(false);
  });

  it('saída do terminal é idêntica com e sem --web (exceto a URL do servidor)', async () => {
    const { code: offCode, lines: offLines } = await runCaptured();
    expect(offCode).toBe(0);

    await mkdir(join(tmp, 'issues', '42'), { recursive: true });
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

  it('com --web: ao término, issues/N/session.json contém o estado final', async () => {
    await mkdir(join(tmp, 'issues', '42'), { recursive: true });
    setWebCliOverrides({ enabled: true, port: await getFreePort() });

    const { code } = await runCaptured();
    expect(code).toBe(0);

    const raw = await readFile(join(tmp, 'issues', '42', 'session.json'), 'utf-8');
    const snapshot = sessionSnapshotSchema.parse(JSON.parse(raw));
    expect(snapshot.status).toBe('completed');
    expect(snapshot.issue.number).toBe(42);
    expect(snapshot.endedAt).not.toBeNull();
    expect(snapshot.phases.length).toBeGreaterThan(0);
    expect(snapshot.phases.every((p) => p.status === 'completed')).toBe(true);
  });

  it('matar o servidor durante a execução não afeta o pipeline', async () => {
    await mkdir(join(tmp, 'issues', '42'), { recursive: true });
    setWebCliOverrides({ enabled: true, port: await getFreePort() });

    vi.mocked(runExecute).mockImplementationOnce(async () => {
      const handle = serverHandles[0];
      expect(handle).toBeDefined();
      const res = await fetch(`${handle.url}/api/status`);
      expect(res.status).toBe(200);
      // Simula o servidor morrendo no meio da execução.
      await handle.close();
      await expect(fetch(`${handle.url}/api/status`)).rejects.toThrow();
      return 0;
    });

    const { code } = await runCaptured();
    expect(code).toBe(0);

    // O publisher é independente do servidor: o estado final ainda é gravado.
    const raw = await readFile(join(tmp, 'issues', '42', 'session.json'), 'utf-8');
    const snapshot = sessionSnapshotSchema.parse(JSON.parse(raw));
    expect(snapshot.status).toBe('completed');
  });

  it('resolve a Issue uma única vez e propaga a decisão a todas as fases', async () => {
    const { code } = await runCaptured();

    expect(code).toBe(0);
    expect(vi.mocked(resolveIssue)).toHaveBeenCalledTimes(1);

    const resolved = await vi.mocked(resolveIssue).mock.results[0]?.value;
    expect(vi.mocked(runPrd)).toHaveBeenCalledWith('42', resolved);
    expect(vi.mocked(runPlan)).toHaveBeenCalledWith('42', resolved);
    expect(vi.mocked(runReview)).toHaveBeenCalledWith('42', resolved);
    expect(vi.mocked(runPr)).toHaveBeenCalledWith('42', resolved);
  });

  it('falha da resolução encerra o pipeline com o exit code do erro', async () => {
    vi.mocked(resolveIssue).mockRejectedValue(new IssueResolutionError('nowhere to be found', 2));

    const { code } = await runCaptured();

    expect(code).toBe(2);
    expect(vi.mocked(runPrd)).not.toHaveBeenCalled();
  });

  it('fecha a Issue pelo provider da origem resolvida', async () => {
    const close = vi.fn(async () => {});
    vi.mocked(getProvider).mockReturnValue(makeProvider(close));

    const { code, lines } = await runCaptured();

    expect(code).toBe(0);
    expect(vi.mocked(getProvider)).toHaveBeenCalledWith('github');
    expect(close).toHaveBeenCalledWith('42');
    expect(lines.some((l) => l.includes('Closing issue'))).toBe(true);
  });

  it('pula o fechamento, sem falhar, quando o provider não implementa close', async () => {
    vi.mocked(getProvider).mockReturnValue(makeProvider());

    const { code, lines } = await runCaptured();

    expect(code).toBe(0);
    expect(lines.some((l) => l.includes('Closing issue'))).toBe(false);
  });

  it('falha ao fechar continua não-fatal', async () => {
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
  });

  it('identificador local não numérico é publicado como issue.number null', async () => {
    vi.mocked(resolveIssue).mockResolvedValue(
      makeResolved({ id: 'auth-refactor', number: null }, 'local'),
    );
    await mkdir(join(tmp, 'issues', 'auth-refactor'), { recursive: true });
    setWebCliOverrides({ enabled: true, port: await getFreePort() });

    const code = await runPipeline('auth-refactor', 'auto');
    expect(code).toBe(0);

    const raw = await readFile(join(tmp, 'issues', 'auth-refactor', 'session.json'), 'utf-8');
    const snapshot = sessionSnapshotSchema.parse(JSON.parse(raw));
    expect(snapshot.issue.number).toBeNull();
  });

  it('sem flags, a checagem de pré-requisitos roda com a origem github', async () => {
    const { code } = await runCaptured();

    expect(code).toBe(0);
    expect(vi.mocked(runInit)).toHaveBeenCalledWith('github');
  });

  it('com --local, a checagem de pré-requisitos roda com a origem local (US-011)', async () => {
    setIssuesCliOverrides({ preferredProvider: 'local' });

    const { code } = await runCaptured();

    expect(code).toBe(0);
    expect(vi.mocked(runInit)).toHaveBeenCalledWith('local');
  });
});
