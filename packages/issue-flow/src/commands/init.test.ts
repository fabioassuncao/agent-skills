import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import {
  promptInitialAgentChoice,
  runInit,
  shouldOfferAgentPrompt,
  summarizePreflight,
} from './init.js';

type GhState = 'ok' | 'missing' | 'failed' | 'unauthenticated';

interface FakeEnv {
  claude?: boolean;
  gh?: GhState;
  git?: boolean | 'not-a-repo';
}

/** Stub every binary runInit probes, one state per tool. */
function mockEnv({ claude = true, gh = 'ok', git = true }: FakeEnv = {}): void {
  vi.mocked(execa).mockImplementation((async (file: string, args: string[] = []) => {
    if (file === 'claude') {
      if (!claude) throw new Error('spawn claude ENOENT');
      return { exitCode: 0, stdout: '2.0.0 (Claude Code)' };
    }
    if (file === 'gh') {
      if (gh === 'missing') throw new Error('spawn gh ENOENT');
      if (gh === 'failed') return { exitCode: 1, stdout: '' };
      if (args[0] === 'auth') {
        return { exitCode: gh === 'unauthenticated' ? 1 : 0, stdout: '' };
      }
      return { exitCode: 0, stdout: 'gh version 2.60.0' };
    }
    if (file === 'git') {
      if (git === false) throw new Error('spawn git ENOENT');
      if (args[0] === 'rev-parse') {
        return { exitCode: git === 'not-a-repo' ? 1 : 0, stdout: 'true' };
      }
      return { exitCode: 0, stdout: 'git version 2.45.0' };
    }
    throw new Error(`unexpected command: ${file}`);
  }) as unknown as typeof execa);
}

/** Run init capturing every terminal line (emit falls back to console.log). */
async function runCaptured(source?: string): Promise<{
  code: number;
  output: string;
}> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    // `checkOnly`: this file is about the prerequisite probes. The convention
    // half is exercised in its own block below, and letting it run here would
    // resolve a policy against whatever the mocked `git rev-parse` returns.
    const code =
      source === undefined
        ? await runInit(undefined, { checkOnly: true })
        : await runInit(source, { checkOnly: true });
    return { code, output: lines.join('\n') };
  } finally {
    spy.mockRestore();
  }
}

describe('runInit — origem GitHub (comportamento atual)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('aprova o ambiente quando claude, gh e git estão disponíveis', async () => {
    mockEnv();
    const { code, output } = await runCaptured();

    expect(code).toBe(0);
    expect(output).toContain('gh CLI: gh version 2.60.0 (authenticated)');
    expect(output).toContain('All prerequisites met. Ready to run the pipeline.');
  });

  it('reprova por ausência de gh, com a mensagem e o hint de sempre', async () => {
    mockEnv({ gh: 'missing' });
    const { code, output } = await runCaptured();

    expect(code).toBe(1);
    expect(output).toContain('gh CLI: gh not found');
    expect(output).toContain('Install GitHub CLI: https://cli.github.com/');
    expect(output).toContain('Some prerequisites are missing.');
    expect(output).not.toContain('not required for local issues');
  });

  it('reprova por gh não autenticado', async () => {
    mockEnv({ gh: 'unauthenticated' });
    const { code, output } = await runCaptured();

    expect(code).toBe(1);
    expect(output).toContain('(not authenticated)');
    expect(output).toContain('Run: gh auth login');
  });

  it('o default sem argumento é idêntico a passar github explicitamente', async () => {
    mockEnv({ gh: 'missing' });
    const withoutArg = await runCaptured();
    const withArg = await runCaptured('github');

    expect(withArg.code).toBe(withoutArg.code);
    expect(withArg.output).toBe(withoutArg.output);
  });
});

describe('runInit — origem local (US-011)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gh ausente vira aviso e não reprova o ambiente', async () => {
    mockEnv({ gh: 'missing' });
    const { code, output } = await runCaptured('local');

    expect(code).toBe(0);
    expect(output).toContain('gh CLI: gh not found (not required for local issues)');
    expect(output).toContain('All prerequisites met. Ready to run the pipeline.');
    expect(output).not.toContain('Some prerequisites are missing.');
  });

  it('gh não autenticado também é apenas um aviso', async () => {
    mockEnv({ gh: 'unauthenticated' });
    const { code, output } = await runCaptured('local');

    expect(code).toBe(0);
    expect(output).toContain('(not authenticated) (not required for local issues)');
  });

  it('gh disponível continua sendo reportado como sucesso', async () => {
    mockEnv();
    const { code, output } = await runCaptured('local');

    expect(code).toBe(0);
    expect(output).toContain('gh CLI: gh version 2.60.0 (authenticated)');
    expect(output).not.toContain('not required for local issues');
  });

  it('claude continua bloqueante', async () => {
    mockEnv({ claude: false, gh: 'missing' });
    const { code, output } = await runCaptured('local');

    expect(code).toBe(1);
    expect(output).toContain('claude CLI: claude not found');
    expect(output).toContain('Some prerequisites are missing.');
  });

  it('git continua bloqueante, inclusive fora de um repositório', async () => {
    const missing = await (async () => {
      mockEnv({ git: false, gh: 'missing' });
      return runCaptured('local');
    })();
    expect(missing.code).toBe(1);
    expect(missing.output).toContain('git: git not found');

    vi.clearAllMocks();
    mockEnv({ git: 'not-a-repo', gh: 'missing' });
    const outsideRepo = await runCaptured('local');
    expect(outsideRepo.code).toBe(1);
    expect(outsideRepo.output).toContain('(not a git repository)');
  });
});

describe('runInit — origem registrada por um provider novo (US-014)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gh só bloqueia a origem github: uma origem nova não é reprovada por ele', async () => {
    mockEnv({ gh: 'missing' });
    const { code, output } = await runCaptured('memory');

    expect(code).toBe(0);
    expect(output).toContain('gh CLI: gh not found (not required for memory issues)');
  });

  it('claude e git seguem bloqueantes para a origem nova', async () => {
    mockEnv({ claude: false, gh: 'missing' });
    const { code, output } = await runCaptured('memory');

    expect(code).toBe(1);
    expect(output).toContain('claude CLI: claude not found');
  });
});

describe('summarizePreflight', () => {
  it('collapses checks and conventions into one clean line', () => {
    expect(
      summarizePreflight([{ passed: true }, { passed: true }], {
        actions: [{ kind: 'keep' }, { kind: 'keep' }, { kind: 'keep' }],
      }),
    ).toBe('Preflight: environment ok · 3 conventions kept · nothing to create');
  });
});

describe('first-run agent prompt', () => {
  it('is suppressed when active routing owns the per-phase choice', () => {
    expect(shouldOfferAgentPrompt(false, 'active')).toBe(false);
  });

  it('is preserved for non-active routing without an explicit agent', () => {
    expect(shouldOfferAgentPrompt(false, 'shadow')).toBe(true);
    expect(shouldOfferAgentPrompt(false, 'recommend')).toBe(true);
  });

  it('is suppressed by an explicit agent in every routing mode', () => {
    expect(shouldOfferAgentPrompt(true, 'shadow')).toBe(false);
  });

  it('is suppressed by flags and by a non-interactive terminal policy', () => {
    expect(shouldOfferAgentPrompt(false, 'shadow', { json: true })).toBe(false);
    expect(shouldOfferAgentPrompt(false, 'shadow', { noAgentPrompt: true })).toBe(false);
    expect(shouldOfferAgentPrompt(false, 'shadow', { interactive: false })).toBe(false);
  });

  it('initially selects Claude and accepts a buffered arrow-key choice for Codex', async () => {
    const first = new PassThrough();
    const firstOutput = new PassThrough();
    first.write('\r');
    await expect(
      promptInitialAgentChoice({ stdin: first, stdout: firstOutput, info: vi.fn() }),
    ).resolves.toBe('claude');

    const second = new PassThrough();
    const secondOutput = new PassThrough();
    second.write('\u001b[B\r');
    await expect(
      promptInitialAgentChoice({ stdin: second, stdout: secondOutput, info: vi.fn() }),
    ).resolves.toBe('codex');
  });

  it('does not persist a fallback when the prompt is cancelled', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const persist = vi.fn(async () => '/unused/config.json');
    stdin.write('\u001b');

    await expect(
      promptInitialAgentChoice({ apply: true, stdin, stdout, persist }),
    ).resolves.toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });

  it('does not persist a fallback on EOF or AbortSignal', async () => {
    const persist = vi.fn(async () => '/unused/config.json');
    const eofInput = new PassThrough();
    eofInput.end();

    await expect(
      promptInitialAgentChoice({
        apply: true,
        stdin: eofInput,
        stdout: new PassThrough(),
        persist,
      }),
    ).resolves.toBeNull();

    const abortInput = new PassThrough();
    const controller = new AbortController();
    const choice = promptInitialAgentChoice({
      apply: true,
      stdin: abortInput,
      stdout: new PassThrough(),
      signal: controller.signal,
      persist,
    });
    controller.abort();

    await expect(choice).resolves.toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });
});

describe('runInit — a metade de convenções', () => {
  beforeEach(() => {
    mockEnv();
  });

  it('em compact resume o preflight numa linha e não despeja o relatório', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });

    try {
      const code = await runInit('github', { compact: true });
      const text = lines.join('\n');
      expect(code).toBe(0);
      expect(text).not.toContain('Repository conventions');
      expect(text).not.toContain('Checking prerequisites');
    } finally {
      spy.mockRestore();
    }
  });

  it('reporta as convenções por padrão, sem escrever nada', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });

    try {
      const code = await runInit('github');

      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('Repository conventions');
    } finally {
      spy.mockRestore();
    }
  });

  it('nunca altera o exit code por causa de uma convenção ausente', async () => {
    // A repository missing a template is not a broken environment. Failing here
    // would break every script that treats `init` as a prerequisite gate.
    mockEnv({ claude: false });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      expect(await runInit('github')).toBe(1);
      expect(await runInit('github', { checkOnly: true })).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('emite JSON estável e versionado para a skill', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });

    try {
      await runInit('github', { json: true });

      const payload = JSON.parse(lines.join('\n')) as Record<string, unknown>;
      expect(payload.schemaVersion).toBe(1);
      expect(Array.isArray(payload.prerequisites)).toBe(true);
      expect(Array.isArray(payload.actions)).toBe(true);
      // Not applied, so nothing was written.
      expect(payload.applied).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
