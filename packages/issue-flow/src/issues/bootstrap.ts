import { githubIssueProvider } from './providers/github.js';
import { inlineIssueProvider } from './providers/inline.js';
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
  // The origin of `issue-flow run --prompt` (§17). It answers only for its own
  // `inline-<hash>` identifiers, so registering it costs every other
  // resolution a shape test and no I/O at all.
  if (!registered.has('inline')) {
    registerProvider(inlineIssueProvider);
  }
}
