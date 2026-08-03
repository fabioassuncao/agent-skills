import type { IssueProvider } from './provider.js';
import type { IssueSource } from './types.js';

/**
 * Registry of Issue providers.
 *
 * Adding an origin is creating a provider file and registering one line here
 * (or from the caller's side), so nothing in src/commands/ needs to know the
 * list of sources.
 */
const providers = new Map<IssueSource, IssueProvider>();

/**
 * Register a provider under its own `name`.
 *
 * Registering the same source twice replaces the previous entry, which is what
 * lets tests substitute a real provider with a fake one.
 */
export function registerProvider(provider: IssueProvider): void {
  providers.set(provider.name, provider);
}

/** Sources currently registered, in registration order. */
export function getRegisteredSources(): IssueSource[] {
  return [...providers.keys()];
}

/**
 * Look up a provider by origin.
 *
 * @throws when the origin is not registered, listing what is available so the
 * caller knows which sources they can pick instead.
 */
export function getProvider(source: IssueSource): IssueProvider {
  const provider = providers.get(source);
  if (provider === undefined) {
    const available = getRegisteredSources();
    const hint =
      available.length > 0
        ? `Available sources: ${available.join(', ')}.`
        : 'No Issue providers are registered.';
    throw new Error(`Unknown Issue source: '${source}'. ${hint}`);
  }
  return provider;
}

/** Drop every registration. Intended for test isolation. */
export function clearProviders(): void {
  providers.clear();
}
