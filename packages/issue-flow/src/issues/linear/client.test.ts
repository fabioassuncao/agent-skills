import { describe, expect, it, vi } from 'vitest';
import {
  type ConversationExportPayload,
  parseConversationExportPayload,
} from '../../agents/session/export.js';
import { containsLinearCredential, createLinearClient, LINEAR_GRAPHQL_URL } from './client.js';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function attachment(branch = 'feat/x'): ConversationExportPayload {
  return {
    issueFlowConversation: 1,
    branch,
    baseBranch: 'main',
    agent: 'codex',
    createdAt: '2026-09-06T00:00:00.000Z',
    conversation: [
      {
        id: 'message-1',
        turnId: 'turn-1',
        order: 0,
        kind: 'text',
        role: 'user',
        text: '# Conversa',
        status: 'completed',
        createdAt: '2026-09-06T00:00:00.000Z',
      },
    ],
  };
}

describe('Linear client', () => {
  it('uses only the injected fetch and maps assigned issues', async () => {
    const request = vi.fn(async () =>
      json({
        data: {
          viewer: {
            assignedIssues: {
              nodes: [
                {
                  id: 'id-1',
                  identifier: 'ENG-1',
                  title: 'Corrigir sessão',
                  description: 'normal text with secret%252Dkey embedded',
                  priority: 2,
                  priorityLabel: 'High',
                  url: 'https://linear.app/acme/%73%65%63%72%65%74%2D%6B%65%79/ENG-1',
                  branchName: 'eng-1-corrigir-sessao',
                  dueDate: null,
                  updatedAt: '2026-09-06T00:00:00Z',
                  state: { name: 'Todo', color: '#aaa', type: 'unstarted' },
                  team: { name: 'Engineering', key: 'ENG' },
                  labels: { nodes: [{ name: 'issue-flow', color: '#fff' }] },
                  project: { name: 'Monitor' },
                },
              ],
            },
          },
        },
      }),
    );
    const issues = await createLinearClient({
      apiKey: 'secret-key',
      fetch: request,
    }).fetchAssignedIssues();

    expect(issues[0]).toMatchObject({ identifier: 'ENG-1', project: 'Monitor' });
    expect(issues[0]?.description).toBe('[redacted]');
    expect(issues[0]?.title).toBe('Corrigir sessão');
    expect(issues[0]?.url).toBe('[redacted]');
    expect(issues[0]?.project).toBe('Monitor');
    expect(request).toHaveBeenCalledOnce();
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(LINEAR_GRAPHQL_URL);
    expect(init.headers).toMatchObject({ authorization: 'secret-key' });
    expect(init.body).not.toContain('secret-key');
  });

  it('posts to an existing issue and never includes the credential in failures', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          data: {
            issue: {
              id: 'uuid',
              identifier: 'ENG-2',
              title: 'T',
              url: 'https://linear/2?token=never-print-me',
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        json({
          data: {
            fileUpload: {
              success: true,
              uploadFile: {
                uploadUrl: 'https://storage.googleapis.com/linear-upload/1',
                assetUrl: 'https://asset/never-print-me/1',
                headers: [],
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(
        json({
          data: {
            attachmentCreate: {
              success: true,
              attachment: { id: 'a1', url: 'https://linear/never-print-me/a1' },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        json({
          data: {
            commentCreate: {
              success: true,
              comment: { id: 'c1', url: 'https://linear/never-print-me/c1' },
            },
          },
        }),
      );
    const client = createLinearClient({ apiKey: 'never-print-me', fetch: request });
    await expect(
      client.postConversation(
        { kind: 'issue', issueId: 'ENG-2' },
        { branch: 'feat/x', markdown: '# Conversa', attachment: attachment() },
      ),
    ).resolves.toEqual({
      issueId: 'ENG-2',
      issueUrl: '[redacted]',
      commentUrl: '[redacted]',
      attachmentUrl: '[redacted]',
    });

    expect(request).toHaveBeenCalledTimes(5);
    const uploaded = String(request.mock.calls[2]?.[1]?.body);
    expect(parseConversationExportPayload(JSON.parse(uploaded))).not.toBeNull();
    expect(uploaded).toContain('# Conversa');
    expect(request.mock.calls[2]?.[0]).toBe('https://storage.googleapis.com/linear-upload/1');
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      method: 'PUT',
      redirect: 'error',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
        'x-goog-content-length-range': expect.stringMatching(/^\d+,\d+$/),
      }),
    });
    expect(String(request.mock.calls[4]?.[1]?.body)).toContain('issue-flow-state:feat/x');
    expect(String(request.mock.calls[3]?.[1]?.body)).not.toContain('never-print-me');

    const failing = createLinearClient({
      apiKey: 'never-print-me',
      fetch: async () => json({ errors: [{ message: 'denied for never-print-me' }] }),
    });
    const failure = await failing.fetchAssignedIssues().catch((error: unknown) => error as Error);
    expect(failure.message).toBe('[redacted]');
    expect(failure.message).not.toContain('never-print-me');
  });

  it('creates an issue with the transcript through the selected team', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ data: { teams: { nodes: [{ id: 'team-id', key: 'ENG', name: 'Engineering' }] } } }),
      )
      .mockResolvedValueOnce(json({ data: { viewer: { id: 'viewer-id' } } }))
      .mockResolvedValueOnce(
        json({
          data: {
            team: {
              states: {
                nodes: [
                  { id: 'started-id', name: 'Started', type: 'started' },
                  { id: 'progress-id', name: 'In Progress', type: 'started' },
                ],
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        json({
          data: {
            issueCreate: {
              success: true,
              issue: { id: 'i3', identifier: 'ENG-3', title: 'Sessão', url: 'https://linear/3' },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        json({
          data: {
            fileUpload: {
              success: true,
              uploadFile: {
                uploadUrl: 'https://bucket.storage.googleapis.com/linear-upload/3',
                assetUrl: 'https://asset/3',
                headers: [],
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(
        json({
          data: {
            attachmentCreate: { success: true, attachment: { id: 'a3', url: 'https://linear/a3' } },
          },
        }),
      )
      .mockResolvedValueOnce(
        json({
          data: {
            commentCreate: { success: true, comment: { id: 'c3', url: 'https://linear/c3' } },
          },
        }),
      );
    const result = await createLinearClient({ apiKey: 'key', fetch: request }).postConversation(
      { kind: 'team', teamKey: 'ENG', title: 'Sessão' },
      {
        branch: 'feat/session',
        markdown: 'transcrição completa',
        attachment: attachment('feat/session'),
      },
    );

    expect(result).toEqual({
      issueId: 'ENG-3',
      issueUrl: 'https://linear/3',
      commentUrl: 'https://linear/c3',
      attachmentUrl: 'https://linear/a3',
    });
    const createBody = String(request.mock.calls[3]?.[1]?.body);
    expect(createBody).toContain('"assigneeId":"viewer-id"');
    expect(createBody).toContain('"stateId":"progress-id"');
    expect(String(request.mock.calls[5]?.[1]?.body)).toContain('"issueFlowConversation": 1');
  });

  it.each([
    ['key', 'http://storage.googleapis.com/upload'],
    ['key', 'https://127.0.0.1/upload'],
    ['key', 'https://10.0.0.1/upload'],
    ['key', 'https://storage.googleapis.com.evil.example/upload'],
    ['key', 'https://storage.googleapis.com/upload?token=key'],
    ['key', 'https://storage.googleapis.com/upload?token=%6B%65%79'],
    ['key', 'https://user@storage.googleapis.com/upload'],
    ['key', 'https://storage.googleapis.com:8443/upload'],
    ['linear/key', 'https://storage.googleapis.com/linear%2Fkey'],
    ['linear/key', 'https://storage.googleapis.com/upload?token=linear%252Fkey'],
    ['linear/key', 'https://storage.googleapis.com/%6c%69%6e%65%61%72%2f%6b%65%79/upload'],
    ['linear/key', 'https://storage.googleapis.com/%6C%69%6E%65%61%72%2F%6B%65%79/upload'],
    ['linear/key', 'https://storage.googleapis.com/%ZZlinear%252Fkey/upload'],
  ])('rejects an untrusted upload URL without fetching it: %s', async (apiKey, uploadUrl) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          data: { issue: { id: 'uuid', identifier: 'ENG-2', title: 'T', url: 'https://linear/2' } },
        }),
      )
      .mockResolvedValueOnce(
        json({
          data: {
            fileUpload: {
              success: true,
              uploadFile: { uploadUrl, assetUrl: 'https://asset/1', headers: [] },
            },
          },
        }),
      );

    await expect(
      createLinearClient({ apiKey, fetch: request }).postConversation(
        { kind: 'issue', issueId: 'ENG-2' },
        { branch: 'feat/x', markdown: '# Conversa', attachment: attachment() },
      ),
    ).rejects.toThrow('untrusted attachment upload URL');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    'linear%2Fkey',
    'linear%252Fkey',
    '%6c%69%6e%65%61%72%2f%6b%65%79',
    '%6C%69%6E%65%61%72%2F%6B%65%79',
    '%ZZlinear%252Fkey',
  ])('detects encoded credentials through malformed or nested layers: %s', (value) => {
    expect(containsLinearCredential(value, 'linear/key')).toBe(true);
  });

  it.each([
    { key: 'Authorization', value: 'Bearer attacker' },
    { key: 'Cookie', value: 'session=attacker' },
    { key: 'Proxy-Authorization', value: 'Basic attacker' },
    { key: 'x-goog-meta-key', value: 'linear-api-key' },
    { key: 'x-goog-meta-note', value: 'safe\r\nInjected: yes' },
  ])('rejects unsafe upload header $key before the upload', async (header) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          data: { issue: { id: 'uuid', identifier: 'ENG-2', title: 'T', url: 'https://linear/2' } },
        }),
      )
      .mockResolvedValueOnce(
        json({
          data: {
            fileUpload: {
              success: true,
              uploadFile: {
                uploadUrl: 'https://storage.googleapis.com/upload',
                assetUrl: 'https://asset/1',
                headers: [header],
              },
            },
          },
        }),
      );

    await expect(
      createLinearClient({ apiKey: 'linear-api-key', fetch: request }).postConversation(
        { kind: 'issue', issueId: 'ENG-2' },
        { branch: 'feat/x', markdown: '# Conversa', attachment: attachment() },
      ),
    ).rejects.toThrow('unsafe attachment upload headers');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('refuses upload redirects', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          data: { issue: { id: 'uuid', identifier: 'ENG-2', title: 'T', url: 'https://linear/2' } },
        }),
      )
      .mockResolvedValueOnce(
        json({
          data: {
            fileUpload: {
              success: true,
              uploadFile: {
                uploadUrl: 'https://storage.googleapis.com/upload',
                assetUrl: 'https://asset/1',
                headers: [],
              },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response('', { status: 302, headers: { location: 'http://127.0.0.1' } }),
      );

    await expect(
      createLinearClient({ apiKey: 'key', fetch: request }).postConversation(
        { kind: 'issue', issueId: 'ENG-2' },
        { branch: 'feat/x', markdown: '# Conversa', attachment: attachment() },
      ),
    ).rejects.toThrow('HTTP 302');
    expect(request.mock.calls[2]?.[1]?.redirect).toBe('error');
    expect(request).toHaveBeenCalledTimes(3);
  });
});
