import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadless } from './headless.js';
import { setVerbose } from './verbose.js';

// Mock execa
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';

type ExecaResult = Awaited<ReturnType<typeof execa>>;

const mockExeca = vi.mocked(execa);

describe('runHeadless', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns parsed JSON result on success', async () => {
    mockExeca.mockResolvedValue({
      stdout: JSON.stringify({
        result: 'Analysis complete',
        cost_usd: 0.05,
        num_input_tokens: 1000,
        num_output_tokens: 500,
      }),
      stderr: '',
      exitCode: 0,
    } as unknown as ExecaResult);

    const result = await runHeadless({ prompt: 'test prompt' });

    expect(result.success).toBe(true);
    expect(result.result).toBe('Analysis complete');
    expect(result.cost).toEqual({ inputTokens: 1000, outputTokens: 500 });
    expect(result.error).toBeNull();

    expect(mockExeca).toHaveBeenCalledWith(
      'claude',
      ['-p', 'test prompt', '--output-format', 'json', '--max-turns', '10'],
      expect.objectContaining({ reject: false }),
    );
  });

  it('returns error result on non-zero exit code', async () => {
    mockExeca.mockResolvedValue({
      stdout: '',
      stderr: 'Authentication required',
      exitCode: 1,
    } as unknown as ExecaResult);

    const result = await runHeadless({ prompt: 'test prompt' });

    expect(result.success).toBe(false);
    expect(result.result).toBe('');
    expect(result.error).toBe('Authentication required');
  });

  it('handles timeout gracefully', async () => {
    mockExeca.mockRejectedValue(new Error('timed out after 5000ms'));

    const result = await runHeadless({ prompt: 'test', timeout: 5000 });

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('passes allowedTools when specified', async () => {
    mockExeca.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok' }),
      stderr: '',
      exitCode: 0,
    } as unknown as ExecaResult);

    await runHeadless({
      prompt: 'test',
      allowedTools: ['Read', 'Write'],
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--allowedTools', 'Read', '--allowedTools', 'Write']),
      expect.anything(),
    );
  });

  it('passes one --add-dir pair per directory', async () => {
    mockExeca.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok' }),
      stderr: '',
      exitCode: 0,
    } as unknown as ExecaResult);

    await runHeadless({
      prompt: 'test',
      addDirs: ['/home/u/.issue-flow/projects/p/issues/42', '/tmp/extra'],
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'claude',
      [
        '-p',
        'test',
        '--output-format',
        'json',
        '--max-turns',
        '10',
        '--add-dir',
        '/home/u/.issue-flow/projects/p/issues/42',
        '--add-dir',
        '/tmp/extra',
      ],
      expect.anything(),
    );
  });

  it('omits --add-dir entirely when addDirs is absent or empty', async () => {
    mockExeca.mockResolvedValue({
      stdout: JSON.stringify({ result: 'ok' }),
      stderr: '',
      exitCode: 0,
    } as unknown as ExecaResult);

    const baseline = ['-p', 'test', '--output-format', 'json', '--max-turns', '10'];

    await runHeadless({ prompt: 'test' });
    expect(mockExeca).toHaveBeenLastCalledWith('claude', baseline, expect.anything());

    await runHeadless({ prompt: 'test', addDirs: [] });
    expect(mockExeca).toHaveBeenLastCalledWith('claude', baseline, expect.anything());
  });

  it('handles non-JSON output gracefully', async () => {
    mockExeca.mockResolvedValue({
      stdout: 'plain text output',
      stderr: '',
      exitCode: 0,
    } as unknown as ExecaResult);

    const result = await runHeadless({ prompt: 'test' });

    expect(result.success).toBe(true);
    expect(result.result).toBe('plain text output');
  });

  it('returns raw output when outputFormat is text', async () => {
    mockExeca.mockResolvedValue({
      stdout: 'raw text output',
      stderr: '',
      exitCode: 0,
    } as unknown as ExecaResult);

    const result = await runHeadless({ prompt: 'test', outputFormat: 'text' });

    expect(result.success).toBe(true);
    expect(result.result).toBe('raw text output');
  });
});

describe('runHeadless (verbose)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setVerbose(true);
    mockExeca.mockResolvedValue({
      stdout: undefined,
      stderr: '',
      exitCode: 0,
    } as unknown as ExecaResult);
  });

  afterEach(() => {
    setVerbose(false);
  });

  const noop = () => {};

  it('passes one --add-dir pair per directory', async () => {
    await runHeadless({
      prompt: 'test',
      addDirs: ['/home/u/.issue-flow/projects/p/issues/42'],
      onOutput: noop,
    });

    expect(mockExeca).toHaveBeenCalledWith(
      'claude',
      [
        '-p',
        'test',
        '--output-format',
        'stream-json',
        '--verbose',
        '--max-turns',
        '10',
        '--add-dir',
        '/home/u/.issue-flow/projects/p/issues/42',
      ],
      expect.anything(),
    );
  });

  it('omits --add-dir entirely when addDirs is absent', async () => {
    await runHeadless({ prompt: 'test', onOutput: noop });

    expect(mockExeca).toHaveBeenCalledWith(
      'claude',
      ['-p', 'test', '--output-format', 'stream-json', '--verbose', '--max-turns', '10'],
      expect.anything(),
    );
  });
});
