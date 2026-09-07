// biome-ignore-all lint/suspicious/noTemplateCurlyInString: placeholders are user data.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AgentsApiDeps,
  createAgentRoute,
  deleteAgentRoute,
  listAgentsRoute,
  matchAgentResource,
  updateAgentRoute,
  validateAgentRoute,
} from './agents-api.js';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'issue-flow-agents-api-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function deps(writable = true): AgentsApiDeps {
  return {
    writable,
    resolveProject: async (projectId) => (projectId === 'missing' ? null : { projectRoot: root }),
  };
}

describe('agents API handlers', () => {
  it('lists built-ins and custom agents through a read-only dependency', async () => {
    await createAgentRoute(deps(), null, { label: 'Gemini', startCommand: 'gemini' });
    const response = await listAgentsRoute(deps(false), null);
    expect(response.status).toBe(200);
    expect(
      (response.body as { agents: Array<{ id: string }> }).agents.map((agent) => agent.id),
    ).toEqual(['claude', 'codex', 'cursor', 'antigravity', 'opencode', 'gemini']);
  });

  it('validates without writing', () => {
    expect(validateAgentRoute({ label: 'Gemini CLI', startCommand: 'gemini' })).toEqual({
      status: 200,
      body: { normalizedId: 'gemini-cli', warnings: expect.any(Array) },
    });
    expect(validateAgentRoute({ label: '', startCommand: '' }).status).toBe(400);
    expect(validateAgentRoute({ label: 'Broken', startCommand: `tool 'unterminated` })).toEqual({
      status: 400,
      body: { error: expect.stringContaining('unclosed quote') },
    });
    expect(validateAgentRoute({ label: 'Broken', startCommand: 'tool trailing\\' })).toEqual({
      status: 400,
      body: { error: expect.stringContaining('incomplete escape') },
    });
  });

  it('creates, updates, and deletes one persisted custom agent', async () => {
    const created = await createAgentRoute(deps(), null, {
      label: 'Gemini CLI',
      startCommand: 'gemini "${PROMPT}"',
    });
    expect(created.status).toBe(200);
    expect((created.body as { agent: { id: string } }).agent.id).toBe('gemini-cli');

    const updated = await updateAgentRoute(deps(), null, 'gemini-cli', {
      label: 'Gemini Pro',
      startCommand: 'gemini pro',
      resumeCommand: 'gemini resume',
    });
    expect(updated.status).toBe(200);
    expect((updated.body as { agent: { label: string } }).agent.label).toBe('Gemini Pro');

    expect((await deleteAgentRoute(deps(), null, 'gemini-cli')).status).toBe(200);
    expect((await listAgentsRoute(deps(), null)).body).not.toMatchObject({
      agents: expect.arrayContaining([expect.objectContaining({ id: 'gemini-cli' })]),
    });
    expect(
      JSON.parse(await readFile(join(root, '.issue-flow.json'), 'utf8')).agents['gemini-cli'],
    ).toBeNull();
  });

  it('rejects collisions, built-in changes, unknown ids, and unknown projects', async () => {
    expect(
      (await createAgentRoute(deps(), null, { label: 'Claude', startCommand: 'x' })).status,
    ).toBe(409);
    expect(
      (await updateAgentRoute(deps(), null, 'claude', { label: 'X', startCommand: 'x' })).status,
    ).toBe(400);
    expect((await deleteAgentRoute(deps(), null, 'codex')).status).toBe(400);
    expect(
      (await updateAgentRoute(deps(), null, 'missing', { label: 'X', startCommand: 'x' })).status,
    ).toBe(404);
    expect((await listAgentsRoute(deps(), 'missing')).status).toBe(501);
  });

  it('refuses every mutation through a read-only dependency', async () => {
    expect(
      (await createAgentRoute(deps(false), null, { label: 'X', startCommand: 'x' })).status,
    ).toBe(403);
    expect(
      (await updateAgentRoute(deps(false), null, 'x', { label: 'X', startCommand: 'x' })).status,
    ).toBe(403);
    expect((await deleteAgentRoute(deps(false), null, 'x')).status).toBe(403);
  });

  it('redacts command templates from remote-safe reads', async () => {
    await createAgentRoute(deps(), null, {
      label: 'Secret Agent',
      startCommand: 'secret --token literal',
      resumeCommand: '',
    });
    const response = await listAgentsRoute(deps(false), null);
    const agent = (
      response.body as { agents: Array<{ id: string; startCommand: string | null }> }
    ).agents.find((entry) => entry.id === 'secret-agent');
    expect(agent?.startCommand).toBeNull();
  });

  it('matches only a canonical decoded id and reports invalid encoding', () => {
    expect(matchAgentResource('/api/agents/gemini-cli')).toEqual({ id: 'gemini-cli' });
    expect(matchAgentResource('/api/agents/gemini%2Fcli')).toEqual({
      error: 'Invalid custom agent id: gemini/cli',
    });
    expect(matchAgentResource('/api/agents/%ZZ')).toEqual({
      error: 'Invalid percent-encoding in custom agent id.',
    });
    expect(matchAgentResource('/api/agents/gemini/edit')).toBeNull();
  });
});
