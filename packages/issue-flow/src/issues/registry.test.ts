import { beforeEach, describe, expect, it } from 'vitest';
import { hashIssueContent } from './hash.js';
import type { IssueProvider } from './provider.js';
import { clearProviders, getProvider, getRegisteredSources, registerProvider } from './registry.js';
import type { Issue, IssueDraft, IssueSource } from './types.js';

function makeIssue(id: string, source: IssueSource): Issue {
  return {
    id,
    number: Number.parseInt(id, 10) || null,
    title: `Issue ${id}`,
    body: 'Body',
    labels: [],
    state: 'open',
    source,
    remoteRef: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    contentHash: hashIssueContent(`Issue ${id}`, 'Body'),
  };
}

/** Read-only provider: implements the required surface, no `close`. */
function makeProvider(name: IssueSource): IssueProvider {
  return {
    name,
    async isAvailable() {
      return true;
    },
    async get(id: string) {
      return makeIssue(id, name);
    },
    async create(draft: IssueDraft) {
      return { ...makeIssue('1', name), ...draft };
    },
  };
}

describe('registry', () => {
  beforeEach(() => {
    clearProviders();
  });

  it('retrieves a registered provider by source', () => {
    const github = makeProvider('github');
    registerProvider(github);

    expect(getProvider('github')).toBe(github);
  });

  it('keys the provider by its own name', () => {
    registerProvider(makeProvider('local'));

    expect(getRegisteredSources()).toEqual(['local']);
    expect(getProvider('local').name).toBe('local');
  });

  it('keeps providers of different sources apart', () => {
    const github = makeProvider('github');
    const local = makeProvider('local');
    registerProvider(github);
    registerProvider(local);

    expect(getProvider('github')).toBe(github);
    expect(getProvider('local')).toBe(local);
    expect(getRegisteredSources()).toEqual(['github', 'local']);
  });

  it('replaces a previous registration for the same source', () => {
    registerProvider(makeProvider('github'));
    const replacement = makeProvider('github');
    registerProvider(replacement);

    expect(getProvider('github')).toBe(replacement);
    expect(getRegisteredSources()).toEqual(['github']);
  });

  it('throws for an unregistered source, listing the available ones', () => {
    registerProvider(makeProvider('local'));

    expect(() => getProvider('github')).toThrow(/Unknown Issue source: 'github'/);
    expect(() => getProvider('github')).toThrow(/Available sources: local/);
  });

  it('says so explicitly when nothing is registered', () => {
    expect(() => getProvider('github')).toThrow(/No Issue providers are registered/);
  });

  it('accepts a provider without close and exposes it as optional', async () => {
    const readOnly = makeProvider('local');
    registerProvider(readOnly);

    const provider = getProvider('local');
    expect(provider.close).toBeUndefined();
    await expect(Promise.resolve(provider.close?.('1'))).resolves.toBeUndefined();
  });

  it('exposes close when the provider implements it', async () => {
    const closed: string[] = [];
    registerProvider({
      ...makeProvider('local'),
      async close(id: string) {
        closed.push(id);
      },
    });

    await getProvider('local').close?.('7');
    expect(closed).toEqual(['7']);
  });

  it('reports no sources after clearing', () => {
    registerProvider(makeProvider('github'));
    clearProviders();

    expect(getRegisteredSources()).toEqual([]);
  });
});
