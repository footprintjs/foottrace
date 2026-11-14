import { CanonicalJsonError } from './types.js';
import type { CanonicalJsonOptions } from './types.js';

export const CANONICAL_JSON_DEFAULTS = Object.freeze({
  maxDepth: 64,
  maxNodes: 10_000,
  maxFields: 10_000,
  maxStringBytes: 1_048_576,
  maxSortWork: 200_000,
  maxBytes: 1_048_576,
});
export const CANONICAL_JSON_CEILINGS = Object.freeze({
  maxDepth: 128,
  maxNodes: 100_000,
  maxFields: 100_000,
  maxStringBytes: 4_194_304,
  maxSortWork: 2_000_000,
  maxBytes: 4_194_304,
});
export type CanonicalLimits = { -readonly [K in keyof Required<CanonicalJsonOptions>]: number };

export function canonicalLimits(input?: CanonicalJsonOptions): CanonicalLimits {
  const result: CanonicalLimits = { ...CANONICAL_JSON_DEFAULTS };
  if (input === undefined) return result;
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new CanonicalJsonError('options');
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== null && prototype !== Object.prototype) throw new CanonicalJsonError('options');
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== 'string' || !Object.hasOwn(result, key)) throw new CanonicalJsonError('options');
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      const value = descriptor && 'value' in descriptor ? descriptor.value : undefined;
      const name = key as keyof CanonicalLimits;
      if (!Number.isSafeInteger(value) || value < 1 || value > CANONICAL_JSON_CEILINGS[name])
        throw new CanonicalJsonError('options');
      result[name] = value;
    }
    return result;
  } catch {
    throw new CanonicalJsonError('options');
  }
}
