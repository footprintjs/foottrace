import { isOwnedJsonErrorCode, ownedJsonFailureCode } from '../owned-json/types.js';
import type { OwnedJsonValue, OwnedJsonErrorCode } from '../owned-json/types.js';

/** The strict JSON domain. Admission returns an owned, frozen value. */
export type JsonValue = OwnedJsonValue;

export interface CanonicalJsonOptions {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxFields?: number;
  readonly maxStringBytes?: number;
  readonly maxSortWork?: number;
  readonly maxBytes?: number;
}
export type CanonicalJsonErrorCode = OwnedJsonErrorCode;

/** A fixed coded refusal: never includes payloads, names, paths or caught exception text. */
export class CanonicalJsonError extends Error {
  readonly code: CanonicalJsonErrorCode;
  constructor(code: CanonicalJsonErrorCode) {
    const safe = isOwnedJsonErrorCode(code) ? code : 'unreadable';
    super('Canonical JSON refused: ' + safe);
    this.code = safe;
    this.name = 'CanonicalJsonError';
  }
}
/** Copy a known code, never trust an incoming Error instance or invoke its code accessor. */
export function canonicalFailure(error: unknown): CanonicalJsonError {
  return new CanonicalJsonError(ownedJsonFailureCode(error));
}
