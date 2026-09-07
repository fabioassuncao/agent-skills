import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedAgentSessionContext } from '../agents/session/context.js';
import {
  autoNameConfigRoute,
  type IntegrationsApiDeps,
  listLinearIssuesRoute,
  postWorktreeToLinearRoute,
  setAutoRemoveOnMergeRoute,
  setLinearAutoCreateRoute,
} from './integrations-api.js';

describe('integration API handlers', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(env: NodeJS.ProcessEnv = {}): Promise<{
    root: string;
    deps: IntegrationsApiDeps;
    postConversation: ReturnType<typeof vi.fn>;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'issue-flow-integrations-api-'));
    roots.push(root);
    const postConversation = vi.fn(async () => ({
      issueId: 'ENG-9',
      issueUrl: 'https://linear/ENG-9',
      commentUrl: null,
      attachmentUrl: 'https://linear/attachment/9',
    }));
    return {
      root,
      postConversation,
      deps: {
        writable: true,
        env,
        resolveRuntime: async () => ({ projectRoot: root }) as ResolvedAgentSessionContext,
        createLinearClient: () => ({
          fetchAssignedIssues: async () => [],
          postConversation,
        }),
        readConversation: async () => ({
          markdown: '# Conversa\n\nconteúdo',
          attachment: {
            issueFlowConversation: 1,
            branch: 'feat/a',
            baseBranch: 'main',
            agent: 'codex',
            createdAt: '2026-09-06T00:00:00.000Z',
            conversation: [],
          },
        }),
      },
    };
  }

  it('reports explicit disabled, missing-key and ready availability without network', async () => {
    const missing = await fixture();
    expect(await listLinearIssuesRoute(missing.deps, null)).toEqual({
      status: 200,
      body: { availability: 'missing_api_key', issues: [] },
    });

    await writeFile(
      join(missing.root, '.issue-flow.json'),
      JSON.stringify({ linear: { enabled: false } }),
    );
    expect(await listLinearIssuesRoute(missing.deps, null)).toEqual({
      status: 200,
      body: { availability: 'disabled', issues: [] },
    });

    const ready = await fixture({ LINEAR_API_KEY: 'secret' });
    expect(await listLinearIssuesRoute(ready.deps, null)).toEqual({
      status: 200,
      body: { availability: 'ready', issues: [] },
    });
  });

  it('gates mutations and validates bodies before persistence', async () => {
    const { root, deps } = await fixture();
    expect(
      await setLinearAutoCreateRoute({ ...deps, writable: false }, null, { enabled: true }),
    ).toMatchObject({ status: 403 });
    expect(await setLinearAutoCreateRoute(deps, null, { enabled: 'yes' })).toMatchObject({
      status: 400,
    });
    expect(await setLinearAutoCreateRoute(deps, null, { enabled: true })).toEqual({
      status: 200,
      body: { ok: true, enabled: true },
    });
    expect(await setAutoRemoveOnMergeRoute(deps, null, { enabled: true })).toEqual({
      status: 200,
      body: { ok: true, enabled: true },
    });
    expect(JSON.parse(await readFile(join(root, '.issue-flow.json'), 'utf8'))).toEqual({
      linear: { autoCreateWorktrees: true },
      github: { autoRemoveOnMerge: true },
    });
  });

  it('redacts a credential repeated by a remote-safe Linear read', async () => {
    const { deps } = await fixture({ LINEAR_API_KEY: 'remote-secret-value' });
    const response = await listLinearIssuesRoute(
      {
        ...deps,
        writable: false,
        createLinearClient: () => ({
          fetchAssignedIssues: async () => {
            throw new Error('upstream echoed remote-secret-value');
          },
          postConversation: vi.fn(),
        }),
      },
      null,
    );

    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).toContain('[redacted]');
    expect(JSON.stringify(response.body)).not.toContain('remote-secret-value');

    const dataResponse = await listLinearIssuesRoute(
      {
        ...deps,
        writable: false,
        createLinearClient: () => ({
          fetchAssignedIssues: async () =>
            [
              {
                id: 'id-1',
                identifier: 'ENG-1',
                title: 'Título normal',
                description: 'Descrição remote-secret-value',
                priority: 1,
                priorityLabel: 'Urgente',
                url: 'https://linear/remote-secret-value',
                branchName: 'eng-1',
                dueDate: null,
                updatedAt: '2026-09-06T00:00:00Z',
                state: { name: 'Todo', color: '#fff', type: 'unstarted' },
                team: { name: 'Engineering', key: 'ENG' },
                labels: [],
                project: null,
              },
            ] as never,
          postConversation: vi.fn(),
        }),
      },
      null,
    );
    expect(dataResponse.status).toBe(200);
    expect(JSON.stringify(dataResponse.body)).toContain('[redacted]');
    expect(JSON.stringify(dataResponse.body)).not.toContain('remote-secret-value');
    expect(JSON.stringify(dataResponse.body)).toContain('Título normal');
  });

  it('rejects writes whose effective value is pinned by the environment', async () => {
    const { deps } = await fixture({
      ISSUE_FLOW_LINEAR_AUTO_CREATE: 'true',
      ISSUE_FLOW_GITHUB_AUTO_REMOVE_ON_MERGE: 'true',
    });
    expect(await setLinearAutoCreateRoute(deps, null, { enabled: false })).toMatchObject({
      status: 409,
    });
    expect(await setAutoRemoveOnMergeRoute(deps, null, { enabled: false })).toMatchObject({
      status: 409,
    });
  });

  it('posts the canonical conversation and exposes canonical auto-name constants', async () => {
    const { root, deps, postConversation } = await fixture({ LINEAR_API_KEY: 'secret' });
    postConversation.mockResolvedValueOnce({
      issueId: 'ENG-9',
      issueUrl: 'https://linear/secret/ENG-9',
      commentUrl: 'https://linear/secret/comment',
      attachmentUrl: 'https://linear/secret/attachment',
    });
    const response = await postWorktreeToLinearRoute(deps, null, 'feat/a', {
      target: { kind: 'team', teamKey: 'ENG', title: 'Sessão A' },
    });
    expect(response).toMatchObject({ status: 200, body: { ok: true, issueId: 'ENG-9' } });
    expect(JSON.stringify(response.body)).not.toContain('secret');
    expect(JSON.stringify(response.body)).toContain('[redacted]');
    expect(postConversation).toHaveBeenCalledWith(
      { kind: 'team', teamKey: 'ENG', title: 'Sessão A' },
      {
        branch: 'feat/a',
        markdown: '# Conversa\n\nconteúdo',
        attachment: expect.objectContaining({ issueFlowConversation: 1, branch: 'feat/a' }),
      },
    );

    await writeFile(join(root, '.issue-flow.json'), JSON.stringify({ autoName: true }));
    const autoName = await autoNameConfigRoute(deps, null);
    expect(autoName).toMatchObject({
      status: 200,
      body: {
        autoName: {
          maxLength: expect.any(Number),
          timeoutMs: expect.any(Number),
          systemPrompt: expect.any(String),
        },
      },
    });
  });

  it('reports auto-name as not configured when no project runtime is served', async () => {
    await expect(autoNameConfigRoute(null, null)).resolves.toMatchObject({ status: 501 });
  });
});
