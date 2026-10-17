import type { GapCode } from './codes.js';

/**
 * Existing check wire words; a disposition records a producer assertion, not authorization.
 * `unreachable` means the check could not run; its reason identifies why.
 */
export type RequirementCheckDisposition = 'checked-pass' | 'checked-fail' | 'unreachable' | 'not-applicable';

/** References to a real check and its retained evidence. No synthetic attempt is required or invented. */
export interface RequirementCheck {
  readonly checkRef: string;
  readonly disposition: RequirementCheckDisposition;
  readonly reason?: GapCode;
  /** A namespaced adapter detail ID, never a message, subject or payload. */
  readonly detail?: string;
  readonly evidenceRefs: readonly string[];
  readonly attemptRefs: readonly string[];
}

interface RequirementBinding {
  /** This result's identity, not the enclosing artifact reference minted by storage. */
  readonly id: string;
  /** Reference to the requirement definition or policy. */
  readonly requirementRef: string;
  readonly findingRef: string;
  readonly windowRef: string;
  readonly affects: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly checks: readonly RequirementCheck[];
  /** References into a host-owned closed action registry; never executable tool names or arguments. */
  readonly actionRefs: readonly string[];
  /** A namespaced adapter detail ID, never a message, subject or payload. */
  readonly detail?: string;
  /** Source validity and learned time are separate opaque references; no freshness inference is made. */
  readonly validTimeRef?: string;
  readonly learnedTimeRef?: string;
}

/**
 * A producer assertion. Structural admission does not verify its source, scope, bindings, validity or truth.
 * Hosts must verify those facts and must not let a satisfied record override an unresolved affected claim.
 */
export type RequirementResult = RequirementBinding &
  (
    | { readonly state: 'satisfied'; readonly reason?: never }
    | { readonly state: 'unresolved'; readonly reason: GapCode }
  );
