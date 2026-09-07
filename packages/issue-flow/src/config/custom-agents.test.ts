// biome-ignore-all lint/suspicious/noTemplateCurlyInString: placeholders are user data.
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCustomAgentsConfig, persistCustomAgent, removeCustomAgent } from './custom-agents.js';

const roots: string[] = [];

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('custom-agent configuration', () => {
  it('overlays project agents on the global layer and honors tombstones', async () => {
    const globalRoot = await temp('issue-flow-agent-global-');
    const projectRoot = await temp('issue-flow-agent-project-');
    await writeFile(
      join(globalRoot, 'config.json'),
      JSON.stringify({
        agents: {
          inherited: { label: 'Global', startCommand: 'global' },
          replaced: { label: 'Old', startCommand: 'old' },
        },
      }),
    );
    await writeFile(
      join(projectRoot, '.issue-flow.json'),
      JSON.stringify({
        agents: {
          inherited: null,
          replaced: { label: 'New', startCommand: 'new' },
        },
      }),
    );

    await expect(loadCustomAgentsConfig({ globalRoot, projectRoot })).resolves.toEqual({
      replaced: { id: 'replaced', label: 'New', startCommand: 'new' },
    });
  });

  it('persists atomically while preserving unrelated project settings', async () => {
    const projectRoot = await temp('issue-flow-agent-write-');
    await writeFile(
      join(projectRoot, '.issue-flow.json'),
      `${JSON.stringify({ runtime: { profile: 'sandbox' } }, null, 2)}\n`,
    );

    await persistCustomAgent(projectRoot, {
      id: 'gemini-cli',
      label: 'Gemini CLI',
      startCommand: 'gemini "${PROMPT}"',
      resumeCommand: 'gemini resume',
    });

    const parsed = JSON.parse(await readFile(join(projectRoot, '.issue-flow.json'), 'utf8'));
    expect(parsed.runtime).toEqual({ profile: 'sandbox' });
    expect(parsed.agents['gemini-cli']).toEqual({
      label: 'Gemini CLI',
      startCommand: 'gemini "${PROMPT}"',
      resumeCommand: 'gemini resume',
    });
  });

  it('writes a tombstone when an agent is removed', async () => {
    const projectRoot = await temp('issue-flow-agent-remove-');
    await persistCustomAgent(projectRoot, {
      id: 'gemini',
      label: 'Gemini',
      startCommand: 'gemini',
    });
    await removeCustomAgent(projectRoot, 'gemini');

    const parsed = JSON.parse(await readFile(join(projectRoot, '.issue-flow.json'), 'utf8'));
    expect(parsed.agents.gemini).toBeNull();
  });

  it('refuses to overwrite malformed project JSON', async () => {
    const projectRoot = await temp('issue-flow-agent-invalid-');
    await writeFile(join(projectRoot, '.issue-flow.json'), '{broken');
    await expect(
      persistCustomAgent(projectRoot, { id: 'x', label: 'X', startCommand: 'x' }),
    ).rejects.toThrow('invalid JSON');
    await expect(readFile(join(projectRoot, '.issue-flow.json'), 'utf8')).resolves.toBe('{broken');
  });

  it('keeps valid global entries when a sibling is malformed or has a dangerous id', async () => {
    const globalRoot = await temp('issue-flow-agent-tolerant-');
    const warnings: string[] = [];
    await writeFile(
      join(globalRoot, 'config.json'),
      JSON.stringify({
        telemetry: { enabled: false },
        agents: {
          valid: { label: 'Valid', startCommand: 'valid' },
          broken: { label: '', startCommand: 42 },
          ['__proto__']: { label: 'Prototype', startCommand: 'bad' },
        },
      }),
    );

    const loaded = await loadCustomAgentsConfig({
      globalRoot,
      warn: (message) => warnings.push(message),
    });
    expect(loaded.valid).toEqual({ id: 'valid', label: 'Valid', startCommand: 'valid' });
    expect(Object.hasOwn(loaded, 'broken')).toBe(false);
    expect(Object.hasOwn(loaded, '__proto__')).toBe(false);
    expect(warnings).toEqual(expect.arrayContaining([expect.stringContaining('broken')]));
  });

  it('serializes concurrent read-modify-write operations without losing agents', async () => {
    const projectRoot = await temp('issue-flow-agent-concurrent-');
    await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        persistCustomAgent(projectRoot, {
          id: `agent-${index}`,
          label: `Agent ${index}`,
          startCommand: `agent-${index}`,
        }),
      ),
    );

    const parsed = JSON.parse(await readFile(join(projectRoot, '.issue-flow.json'), 'utf8'));
    expect(Object.keys(parsed.agents)).toHaveLength(16);
    expect(await readdir(projectRoot)).toEqual(['.issue-flow.json']);
  });

  it('rejects non-canonical ids before using them as object keys', async () => {
    const projectRoot = await temp('issue-flow-agent-id-');
    await expect(
      persistCustomAgent(projectRoot, { id: '__proto__', label: 'Bad', startCommand: 'bad' }),
    ).rejects.toThrow('Invalid custom agent id');
  });
});
