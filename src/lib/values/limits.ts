import { utf8Bytes, wellFormed } from '../canonical-json/admit.js';
import { valueFields } from './fields.js';
import { ValueTableError } from './types.js';
import type { ValueTableLimits } from './types.js';

export const VALUE_TABLE_DEFAULTS: Readonly<ValueTableLimits> = Object.freeze({
  maxEntries: 1024,
  maxBytes: 4_194_304,
  maxValueBytes: 262_144,
  maxAttempts: 16_384,
  maxDigestBytes: 8_388_608,
  maxInFlight: 8,
  digestTimeoutMs: 1000,
});
export const VALUE_TABLE_CEILINGS: Readonly<ValueTableLimits> = Object.freeze({
  maxEntries: 16_384,
  maxBytes: 67_108_864,
  maxValueBytes: 4_194_304,
  maxAttempts: 1_048_576,
  maxDigestBytes: 67_108_864,
  maxInFlight: 64,
  digestTimeoutMs: 10_000,
});
export function valueLimits(input?: Partial<ValueTableLimits>): ValueTableLimits {
  const out = { ...VALUE_TABLE_DEFAULTS };
  if (input === undefined) return out;
  const fields = valueFields(input, Object.keys(out), [], 'invalid-options');
  for (const key of Object.keys(fields) as (keyof ValueTableLimits)[]) {
    const value = fields[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > VALUE_TABLE_CEILINGS[key])
      throw new ValueTableError('invalid-options');
    out[key] = value;
  }
  return out;
}
export function readableLabel(input: unknown): input is string {
  if (
    typeof input !== 'string' ||
    input.length < 1 ||
    input.length > 80 ||
    !input.trim() ||
    /[\u0000-\u001f\u007f]/.test(input)
  )
    return false;
  try {
    wellFormed(input);
    return utf8Bytes(input) <= 80;
  } catch {
    return false;
  }
}
export const valueId = (input: unknown): input is string =>
  typeof input === 'string' && /^sha256:[a-f0-9]{64}$/.test(input);
