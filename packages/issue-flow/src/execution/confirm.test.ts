import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  buildQueueSummaryLines,
  buildScopeSummaryLine,
  confirmQueue,
  issueLabel,
  QueueConfirmationError,
} from './confirm.js';
import type { ExecutionPlan, ExecutionPlanIssue } from './types.js';

function entry(id: string, overrides: Partial<ExecutionPlanIssue> = {}): ExecutionPlanIssue {
  return {
    id,
    number: Number(id),
    title: `Issue ${id}`,
    url: null,
    source: 'github',
    position: Number(id),
    status: 'pending',
    origin: 'discovered',
    dependsOn: [],
    parent: null,
    priority: null,
    role: 'executable',
    externalDependencies: [],
    heuristic: false,
    failedPhase: null,
    lastError: null,
    attempts: 0,
    blockedReason: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function plan(issues: ExecutionPlanIssue[], overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    schemaVersion: 1,
    id: issues[0]?.id ?? '1',
    project: 'p',
    requested: [issues[0]?.id ?? '1'],
    branchName: null,
    noBranch: false,
    prReview: false,
    status: 'pending',
    createdAt: 'T',
    updatedAt: 'T',
    truncated: false,
    issues,
    excluded: [],
    ...overrides,
  };
}

/** Prompt driver: can buffer raw terminal bytes before the prompt exists. */
function streams(input = ''): {
  stdin: PassThrough;
  stdout: PassThrough;
  written: () => string;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let out = '';
  stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  if (input !== '') stdin.write(input);
  return { stdin, stdout, written: () => out };
}

describe('issueLabel', () => {
  it('uses the number when there is one and the id otherwise', () => {
    expect(issueLabel({ id: '50', number: 50 })).toBe('#50');
    expect(issueLabel({ id: 'auth-refactor', number: null })).toBe('auth-refactor');
  });
});

describe('buildScopeSummaryLine', () => {
  it('recaps the chosen scope in one line after the prompt', () => {
    const two = plan([
      entry('63', { position: 1, origin: 'requested' }),
      entry('64', { position: 2 }),
    ]);
    expect(buildScopeSummaryLine(two, 'all')).toBe('Scope: 2 issues from the hierarchy of #63.');
    expect(buildScopeSummaryLine(two, 'requested')).toBe('Scope: 1 requested issue(s).');
    expect(buildScopeSummaryLine(two, 'cancel')).toBeNull();
  });
});

describe('buildQueueSummaryLines', () => {
  it('reports the main issue, the total and the suggested order with reasons', () => {
    const lines = buildQueueSummaryLines(
      plan([
        entry('50', { position: 1, origin: 'requested', priority: 'high' }),
        entry('51', { position: 2, dependsOn: ['50'], parent: '50' }),
      ]),
    );

    expect(lines[0]).toContain('Main issue:');
    expect(lines[0]).toContain('#50 Issue 50');
    expect(lines[1]).toContain('Total issues: 2');
    expect(lines[3]).toBe('    1. #50 Issue 50 (requested, high)');
    expect(lines[4]).toBe('    2. #51 Issue 51 (after #50, sub-issue of #50)');
  });

  it('flags a heuristic relation and explains the marker once', () => {
    const lines = buildQueueSummaryLines(
      plan([entry('50', { position: 1 }), entry('51', { position: 2, heuristic: true })]),
    );

    expect(lines.some((line) => line.endsWith(' ~'))).toBe(true);
    expect(lines.at(-1)).toContain('false positive');
  });

  it('warns when the discovery was truncated', () => {
    const lines = buildQueueSummaryLines(plan([entry('50', { position: 1 })], { truncated: true }));
    expect(lines.at(-1)).toContain('hit its limit');
  });
});

describe('confirmQueue', () => {
  const twoIssues = plan([
    entry('50', { position: 1, origin: 'requested' }),
    entry('51', { position: 2 }),
  ]);

  it('runs the whole hierarchy with --yes, without prompting', async () => {
    const { stdin, stdout } = streams();
    const info = vi.fn();

    await expect(confirmQueue(twoIssues, 1, { yes: true, stdin, stdout, info })).resolves.toBe(
      'all',
    );
    expect(info).toHaveBeenCalledWith(expect.stringContaining('--yes'));
  });

  it('runs only the informed issues with --only, without prompting', async () => {
    const { stdin, stdout } = streams();
    await expect(confirmQueue(twoIssues, 1, { only: true, stdin, stdout })).resolves.toBe(
      'requested',
    );
  });

  it('fails explicitly in a non-interactive terminal with no flag', async () => {
    const { stdin, stdout } = streams();

    await expect(confirmQueue(twoIssues, 1, { interactive: false, stdin, stdout })).rejects.toThrow(
      QueueConfirmationError,
    );
  });

  it('prints the summary before asking', async () => {
    const { stdin, stdout, written } = streams('\r');
    await confirmQueue(twoIssues, 1, { interactive: true, stdin, stdout });

    expect(written()).toContain('Total issues: 2');
    expect(written()).toContain('Which scope should run?');
  });

  it('maps buffered arrow-key selections and Enter to every normal-queue scope', async () => {
    for (const [input, expected] of [
      ['\u001b[A\r', 'requested'],
      ['\r', 'all'],
      ['\u001b[B\r', 'cancel'],
      ['\u001b', 'cancel'],
    ] as const) {
      const { stdin, stdout } = streams(input);
      await expect(confirmQueue(twoIssues, 1, { interactive: true, stdin, stdout })).resolves.toBe(
        expected,
      );
    }
  });

  it('offers every container scope and initially recommends cascade', async () => {
    const container = plan([
      entry('87', { position: 1, origin: 'requested', role: 'container' }),
      entry('62', { position: 2, parent: '87' }),
    ]);
    for (const [input, expected] of [
      ['\r', 'cascade'],
      ['\u001b[B\r', 'all'],
      ['\u001b[B\u001b[B\r', 'requested'],
      ['\u001b[B\u001b[B\u001b[B\r', 'cancel'],
    ] as const) {
      const { stdin, stdout } = streams(input);
      await expect(confirmQueue(container, 1, { interactive: true, stdin, stdout })).resolves.toBe(
        expected,
      );
    }
  });

  it('does not interpret numeric line input as a container selection', async () => {
    const container = plan([
      entry('87', { position: 1, origin: 'requested', role: 'container' }),
      entry('62', { position: 2, parent: '87' }),
    ]);
    const { stdin, stdout } = streams('2\n');
    const selection = confirmQueue(container, 1, { interactive: true, stdin, stdout });
    setImmediate(() => stdin.write('\u001b'));

    await expect(selection).resolves.not.toBe('all');
  });

  it('fails a non-interactive container without a flag instead of running it alone', async () => {
    const container = plan([
      entry('87', { position: 1, origin: 'requested', role: 'container' }),
      entry('62', { position: 2, parent: '87' }),
    ]);
    const { stdin, stdout } = streams();
    await expect(
      confirmQueue(container, 1, { interactive: false, singleRequest: true, stdin, stdout }),
    ).rejects.toThrow(/--cascade/);
  });

  it('treats --yes on a container as --cascade', async () => {
    const container = plan([
      entry('87', { position: 1, origin: 'requested', role: 'container' }),
      entry('62', { position: 2, parent: '87' }),
    ]);
    const { stdin, stdout } = streams();
    await expect(confirmQueue(container, 1, { yes: true, stdin, stdout })).resolves.toBe('cascade');
  });

  it('treats an exhausted input as a cancellation, never as consent', async () => {
    const { stdin, stdout } = streams();
    stdin.end();

    await expect(confirmQueue(twoIssues, 1, { interactive: true, stdin, stdout })).resolves.toBe(
      'cancel',
    );
  });

  it('treats an aborted prompt as cancellation, never as the initial scope', async () => {
    const { stdin, stdout } = streams();
    const controller = new AbortController();
    const confirmation = confirmQueue(twoIssues, 1, {
      interactive: true,
      stdin,
      stdout,
      signal: controller.signal,
    });
    controller.abort();

    await expect(confirmation).resolves.toBe('cancel');
  });
});
