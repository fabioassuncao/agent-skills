import { githubIssueProvider } from './providers/github.js';
import { localFileIssueProvider } from './providers/local.js';
import { getRegisteredSources, registerProvider } from './registry.js';

/**
 * Register the providers that ship with issue-flow.
 *
 * Idempotent and non-destructive: an origin that is already registered is left
 * untouched, so a test (or a future plugin) can install its own provider before
 * the first `resolveIssue` call without having it replaced by the built-in one.
 */
export function ensureProvidersRegistered(): void {
  const registered = new Set(getRegisteredSources());

  if (!registered.has('github')) {
    registerProvider(githubIssueProvider);
  }
  if (!registered.has('local')) {
    registerProvider(localFileIssueProvider);
  }
}
