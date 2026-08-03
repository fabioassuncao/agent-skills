import { beforeEach, describe, expect, it } from 'vitest';
import { ensureProvidersRegistered } from './bootstrap.js';
import type { IssueProvider } from './provider.js';
import { clearProviders, getProvider, getRegisteredSources, registerProvider } from './registry.js';

const fakeGitHub: IssueProvider = {
  name: 'github',
  isAvailable: async () => true,
  get: async () => null,
  create: async () => {
    throw new Error('not implemented');
  },
};

describe('ensureProvidersRegistered', () => {
  beforeEach(() => {
    clearProviders();
  });

  it('registers the built-in providers', () => {
    ensureProvidersRegistered();

    expect(getRegisteredSources().sort()).toEqual(['github', 'local']);
    expect(getProvider('github').name).toBe('github');
    expect(getProvider('local').name).toBe('local');
  });

  it('is idempotent', () => {
    ensureProvidersRegistered();
    const first = getProvider('local');
    ensureProvidersRegistered();

    expect(getProvider('local')).toBe(first);
  });

  it('never replaces a provider registered by the caller', () => {
    registerProvider(fakeGitHub);
    ensureProvidersRegistered();

    expect(getProvider('github')).toBe(fakeGitHub);
    expect(getProvider('local').name).toBe('local');
  });
});
