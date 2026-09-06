import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearRunners, registerRunner } from '../agents/registry.js';
import type {
  AgentEvent,
  AgentInvocation,
  AgentRunner,
  AgentRunResult,
  ResolvedAgentSettings,
} from '../agents/types.js';
import { CLAUDE_CAPABILITIES } from '../agents/types.js';
import { createHeadlessRuntime } from './headless.js';
import { createRuntime } from './index.js';

/**
 * Phase 3 of the WebMux absorption introduced the runtime contract. Its
 * completion criterion is that nothing changes: `headless` is the default, it
 * is what every release before it did, and a repository with no tmux, no docker
 * and no worktree keeps working (ADR-03).
 *
 * These tests defend exactly that — that the seam is a seam and not a layer.
 */
describe('headless runtime', () => {
  const calls: Array<{ invocation: AgentInvocation; settings: ResolvedAgentSettings }> = [];
  let result: AgentRunResult;
  let emit: (event: AgentEvent) => void = () => {};
  let release: (() => void) | null = null;

  function settings(): ResolvedAgentSettings {
    return {
      provider: 'claude',
      model: null,
      claude: {},
      codex: {},
      cursor: {},
      antigravity: {},
      opencode: {},
      origin: { provider: 'default', model: 'default' },
    } as ResolvedAgentSettings;
  }

  function invocation(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
    return {
      prompt: 'do it',
      phase: 'execute',
      timeout: 0,
      permission: 'autonomous',
      ...overrides,
    };
  }

  beforeEach(() => {
    calls.length = 0;
    release = null;
    result = {
      success: true,
      result: 'done',
      rawOutput: '',
      exitCode: 0,
      usage: null,
      error: null,
      agent: { provider: 'claude', model: null },
    };
    const runner: AgentRunner = {
      id: 'claude',
      capabilities: CLAUDE_CAPABILITIES,
      versionCommand: () => ({ command: 'claude', args: ['--version'] }),
      run: async (inv, resolved) => {
        calls.push({ invocation: inv, settings: resolved });
        emit = (event) => inv.onEvent?.(event);
        if (release !== null) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return result;
      },
    };
    clearRunners();
    registerRunner(runner);
  });

  afterEach(() => {
    clearRunners();
  });

  it('prepares the repository itself, on a branch, touching nothing', async () => {
    const runtime = createHeadlessRuntime();
    const context = await runtime.prepare({ projectRoot: '/repo' });

    expect(context).toEqual({
      mode: 'headless',
      workdir: '/repo',
      isolation: 'branch',
      env: {},
      services: [],
    });
    // Disposing is a no-op for the same reason: nothing was created, and a
    // headless dispose that touched the repository would be the dependency
    // ADR-03 forbids.
    await expect(runtime.dispose(context)).resolves.toBeUndefined();
  });

  // The whole point of phase 3: the mode changes where and how, never what.
  it('hands the invocation to the runner exactly as it was built', async () => {
    const runtime = createHeadlessRuntime();
    const context = await runtime.prepare({ projectRoot: '/repo' });
    const original = invocation({ maxTurns: 12, addDirs: ['/other'] });

    const handle = await runtime.launch(context, original, settings());
    await handle.result();

    const seen = calls[0]?.invocation;
    expect(seen?.prompt).toBe('do it');
    expect(seen?.maxTurns).toBe(12);
    expect(seen?.addDirs).toEqual(['/other']);
    // Not relocated: pinning `workingDirectory` here would put an explicit cwd
    // on a spawn that never had one.
    expect(seen?.workingDirectory).toBeUndefined();
    expect(calls[0]?.settings.provider).toBe('claude');
  });

  it('keeps an explicit working directory the caller asked for', async () => {
    const runtime = createHeadlessRuntime();
    const context = await runtime.prepare({ projectRoot: '/repo' });

    const handle = await runtime.launch(
      context,
      invocation({ workingDirectory: '/elsewhere' }),
      settings(),
    );
    await handle.result();

    expect(calls[0]?.invocation.workingDirectory).toBe('/elsewhere');
  });

  it('returns the runner result unchanged and resolves the same value twice', async () => {
    const runtime = createHeadlessRuntime();
    const context = await runtime.prepare({ projectRoot: '/repo' });
    const handle = await runtime.launch(context, invocation(), settings());

    await expect(handle.result()).resolves.toBe(result);
    await expect(handle.result()).resolves.toBe(result);
    expect(handle.provider).toBe('claude');
    expect(handle.context).toBe(context);
  });

  it('propagates a runner that throws, without leaving an unhandled rejection', async () => {
    clearRunners();
    registerRunner({
      id: 'claude',
      capabilities: CLAUDE_CAPABILITIES,
      versionCommand: () => ({ command: 'claude', args: ['--version'] }),
      run: async () => {
        throw new Error('runner exploded');
      },
    });
    const runtime = createHeadlessRuntime();
    const context = await runtime.prepare({ projectRoot: '/repo' });
    const handle = await runtime.launch(context, invocation(), settings());

    await expect(handle.result()).rejects.toThrow('runner exploded');
  });

  it('observes the normalised event stream and ends it with the invocation', async () => {
    release = () => {};
    const runtime = createHeadlessRuntime();
    const context = await runtime.prepare({ projectRoot: '/repo' });
    const seen: AgentEvent[] = [];
    const handle = await runtime.launch(context, invocation(), settings());

    const draining = (async () => {
      for await (const event of runtime.observe(handle)) seen.push(event);
    })();

    emit({ kind: 'text', text: 'hello' });
    emit({ kind: 'tool', name: 'Bash' });
    release?.();
    await handle.result();
    await draining;

    expect(seen).toEqual([
      { kind: 'text', text: 'hello' },
      { kind: 'tool', name: 'Bash' },
    ]);
  });

  it("still calls the caller's own onEvent while observing", async () => {
    const runtime = createHeadlessRuntime();
    const context = await runtime.prepare({ projectRoot: '/repo' });
    const seen: AgentEvent[] = [];
    const handle = await runtime.launch(
      context,
      invocation({ onEvent: (event) => seen.push(event) }),
      settings(),
    );
    emit({ kind: 'text', text: 'hello' });
    await handle.result();

    expect(seen).toEqual([{ kind: 'text', text: 'hello' }]);
  });

  it('declares what it cannot do rather than pretending', async () => {
    const runtime = createHeadlessRuntime();
    expect(runtime.capabilities).toEqual({
      interactivePrompt: false,
      interrupt: false,
      livesBeyondInvocation: false,
      isolation: 'branch',
    });

    const context = await runtime.prepare({ projectRoot: '/repo' });
    const handle = await runtime.launch(context, invocation(), settings());
    // Both resolve; neither claims to have done anything.
    await expect(runtime.send(handle, 'more')).resolves.toBeUndefined();
    await expect(runtime.interrupt(handle)).resolves.toBeUndefined();
    await handle.result();
  });
});

describe('createRuntime', () => {
  it('builds the default mode', () => {
    expect(createRuntime('headless').mode).toBe('headless');
  });

  // The two worktree modes exist since the runtime-modes phase. Building one
  // costs nothing: they resolve their wiring on the first `prepare()`, from the
  // `projectRoot` it is given, so a machine that never uses them never pays for
  // tmux or docker being looked at.
  it('builds the two worktree modes without touching a repository', () => {
    expect(createRuntime('interactive').mode).toBe('interactive');
    expect(createRuntime('sandbox').mode).toBe('sandbox');
  });

  // A mode that silently fell back to headless would report an isolation it
  // never provided, and isolation is the only reason to ask for another mode.
  // The refusal moved to where it can name what is missing — `prepare()` — and
  // is asserted in `interactive.test.ts` and `sandbox.test.ts`.
  it('never answers a worktree mode with the headless runtime', () => {
    expect(createRuntime('interactive').capabilities.isolation).toBe('worktree');
    expect(createRuntime('sandbox').capabilities.isolation).toBe('worktree');
    expect(createRuntime('headless').capabilities.isolation).toBe('branch');
  });
});
