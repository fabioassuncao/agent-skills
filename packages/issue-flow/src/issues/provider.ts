import type { Issue, IssueDraft, IssueSource } from './types.js';

/**
 * Contract every Issue origin implements.
 *
 * Only `isAvailable`, `get` and `create` are required: a read-only origin can
 * throw from `create` and skip `close` entirely. Callers must treat every
 * optional method as absent (`provider.close?.(id)`) rather than assuming it
 * exists.
 */
export interface IssueProvider {
  /** Origin this provider serves. Doubles as its registry key. */
  readonly name: IssueSource;

  /**
   * Whether the provider can be used right now (CLI installed, authenticated,
   * directory writable). Never throws: an unusable provider reports `false`.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Fetch an Issue by its provider-scoped identifier.
   *
   * Returns `null` when the Issue does not exist. Throws only on real failures
   * (network, authentication, corrupted data), so callers can tell "absent"
   * from "broken".
   */
  get(id: string): Promise<Issue | null>;

  /** Persist a new Issue and return it with ids, timestamps and content hash. */
  create(draft: IssueDraft): Promise<Issue>;

  /** Move an Issue to the `closed` state. Optional: read-only origins omit it. */
  close?(id: string): Promise<void>;
}
