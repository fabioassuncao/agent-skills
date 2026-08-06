import type { Issue, IssueDraft, IssueRelations, IssueSource } from './types.js';

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

  /**
   * Hierarchy and dependencies of an Issue, for the multi-issue pipeline.
   *
   * Optional exactly like `close`: an origin with no notion of related Issues
   * simply omits it, and callers must probe for it
   * (`provider.fetchRelations?.(id)`) instead of assuming it exists.
   *
   * Implementations degrade rather than throw when one of their sources is
   * unavailable: an origin that can answer about sub-issues but not about
   * dependencies returns what it knows, with the other field empty. Throwing is
   * reserved for a failure that makes the whole answer untrustworthy.
   */
  fetchRelations?(id: string): Promise<IssueRelations>;
}
