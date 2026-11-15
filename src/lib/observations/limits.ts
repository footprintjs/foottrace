import { fields } from './fields.js';
import { ObservationError } from './types.js';
import type { ObservationLimits } from './types.js';

/** Policy ceilings, not measured preparation-memory or performance promises. */
export const OBSERVATION_LIMITS: Readonly<Required<ObservationLimits>> = Object.freeze({
  maxRows: 256,
  maxBytes: 131072,
  maxRowBytes: 4096,
});
export const OBSERVATION_VERSION = 1;
export const OBSERVATION_MAX_FACTS = 16;
export type ObservationBounds = typeof OBSERVATION_LIMITS;
export const OBSERVATION_OMISSIONS = Object.freeze(['invalid-data', 'row-limit', 'byte-limit'] as const);
export function observationLimits(input?: ObservationLimits): ObservationBounds {
  if (input === undefined) return OBSERVATION_LIMITS;
  const given = fields(input, Object.keys(OBSERVATION_LIMITS), [], 'invalid-options');
  const result = { ...OBSERVATION_LIMITS };
  for (const key of Object.keys(given) as (keyof ObservationBounds)[]) {
    const value = given[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > OBSERVATION_LIMITS[key])
      throw new ObservationError('invalid-options');
    result[key] = value;
  }
  return Object.freeze(result);
}
