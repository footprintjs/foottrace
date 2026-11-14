import { ownedJsonSnapshot } from '../owned-json/snapshot.js';
import { canonicalLimits } from './limits.js';
import { canonicalFailure } from './types.js';
import type { CanonicalJsonOptions, JsonValue } from './types.js';

export interface CanonicalSnapshot {
  readonly value: JsonValue;
  readonly text: string;
  readonly bytes: number;
}

/** Public canonical policy and fixed refusal translation around the private shared core. */
export function canonicalSnapshot(input: unknown, options?: CanonicalJsonOptions): CanonicalSnapshot {
  const limits = canonicalLimits(options);
  try {
    return ownedJsonSnapshot(input, limits);
  } catch (error) {
    throw canonicalFailure(error);
  }
}

/**
 * RFC 8785 canonical text of a bounded owned-JSON value. Never calls toJSON or a getter.
 * Finite binary64 numbers and well-formed Unicode only; no normalization or partial output.
 * Proxy descriptor traps may run; a host must isolate a trap that never returns.
 */
export function canonicalizeJson(value: unknown, options?: CanonicalJsonOptions): string {
  return canonicalSnapshot(value, options).text;
}
