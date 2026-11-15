import { ownData } from '../evidence/admission.js';
import { ObservationError } from './types.js';
import type { ObservationErrorCode } from './types.js';

const descriptors = { translateTrapErrors: true, requireOwnValue: true };
export const own = (value: unknown, key: string): unknown =>
  ownData(value, key, () => new ObservationError('invalid-data'), descriptors);

/** Only named own data is selected. Descriptor traps may run; getters/iterators are never called. */
export function fields(
  input: unknown,
  allowed: readonly string[],
  required = allowed,
  code: ObservationErrorCode = 'invalid-data',
): Record<string, unknown> {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ObservationError(code);
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== null && prototype !== Object.prototype) throw new ObservationError(code);
    const keys = Reflect.ownKeys(input);
    if (keys.length > allowed.length) throw new ObservationError(code);
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string' || !allowed.includes(key)) throw new ObservationError(code);
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable) throw new ObservationError(code);
      result[key] = own(input, key);
    }
    if (required.some((key) => !Object.hasOwn(result, key))) throw new ObservationError(code);
    return result;
  } catch {
    throw new ObservationError(code);
  }
}

export function arrayLength(value: unknown): number {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
      throw new ObservationError('invalid-data');
    const length = own(value, 'length');
    if (!Number.isSafeInteger(length) || (length as number) < 0) throw new ObservationError('invalid-data');
    return length as number;
  } catch {
    throw new ObservationError('invalid-data');
  }
}
