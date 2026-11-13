/** The strict JSON domain. Admission returns an owned, frozen value. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface CanonicalJsonOptions {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxFields?: number;
  readonly maxStringBytes?: number;
  readonly maxSortWork?: number;
  readonly maxBytes?: number;
}
export type CanonicalJsonErrorCode =
  | 'options'
  | 'unsupported'
  | 'unicode'
  | 'cycle'
  | 'unreadable'
  | 'depth'
  | 'nodes'
  | 'fields'
  | 'string-bytes'
  | 'sort-work'
  | 'output-bytes';

const codes: readonly string[] = [
  'options',
  'unsupported',
  'unicode',
  'cycle',
  'unreadable',
  'depth',
  'nodes',
  'fields',
  'string-bytes',
  'sort-work',
  'output-bytes',
];
/** A fixed coded refusal: never includes payloads, names, paths or caught exception text. */
export class CanonicalJsonError extends Error {
  readonly code: CanonicalJsonErrorCode;
  constructor(code: CanonicalJsonErrorCode) {
    const safe = codes.includes(code) ? code : 'unreadable';
    super('Canonical JSON refused: ' + safe);
    this.code = safe;
    this.name = 'CanonicalJsonError';
  }
}
/** Copy a known code, never trust an incoming Error instance or invoke its code accessor. */
export function canonicalFailure(error: unknown): CanonicalJsonError {
  let code: CanonicalJsonErrorCode = 'unreadable';
  try {
    const own =
      error !== null && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    if (own && 'value' in own && typeof own.value === 'string' && codes.includes(own.value))
      code = own.value as CanonicalJsonErrorCode;
  } catch {
    /* A thrown object's traps do not get a second disclosure channel. */
  }
  return new CanonicalJsonError(code);
}
