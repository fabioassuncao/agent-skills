import type { ClassifiedFailure } from '../resilience/errors.js';
import type { Issue, IssueDraft, IssueRelations, IssueSource } from './types.js';

/**
 * The richer form of `isAvailable()`: whether the origin can be used, and —
 * when it cannot — the classified reason and the action a human would take.
 *
 * It exists because `boolean` throws away the only distinction the resilience
 * layer cares about: a provider that is unreachable (retryable, transient) and
 * a provider that is unauthenticated (never retryable, needs a person) both
 * answered `false`, and the caller could only report "provider unavailable".
 */
export interface ProviderAvailability {
  available: boolean;
  /** Why not. Absent when `available` is true, or when the origin cannot say. */
  failure?: ClassifiedFailure;
  /** What a human has to do about it, e.g. `Run \`gh auth login\``. */
  action?: string;
}

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
   * Same question, with the reason attached. Optional: an origin that cannot
   * classify its own unavailability simply omits it, and callers fall back to
   * `isAvailable()` (`provider.checkAvailability?.()`).
   *
   * Never throws either — an unusable provider *reports*, it does not raise.
   */
  checkAvailability?(): Promise<ProviderAvailability>;

  /**
   * Whether this identifier is unambiguously this origin's.
   *
   * Optional, and answering `true` is a strong statement: the resolver then
   * queries **only** the origins that claim the identifier, and leaves every
   * other one alone. It exists because an origin can own a namespace no other
   * one could ever produce — `inline-<hash>` is minted by Issue Flow itself —
   * and asking GitHub about such an identifier costs a network round-trip and
   * a warning about a failure that was never a failure.
   *
   * An origin whose identifiers could collide with another's (a plain number)
   * must **not** implement this: the divergence machinery is what settles
   * those, and claiming one would silence it. Pure and synchronous; never
   * throws.
   */
  claims?(id: string): boolean;

  /**
   * Fetch an Issue by its provider-scoped identifier.
   *
   * Returns `null` when the Issue does not exist. Throws only on real failures
   * (network, authentication, corrupted data), so callers can tell "absent"
   * from "broken".
   */
  get(id: string): Promise<Issue | null>;

  /** Persist a new Issue and return it with ids, timestamps and content hash. */
  create(draft: IssueDraft, options?: { localOnly?: boolean }): Promise<Issue>;

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
