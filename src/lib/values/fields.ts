import { ValueTableError, valueFailure } from './types.js';
import type { ValueTableErrorCode } from './types.js';

/** Closed own-data fields. Descriptor traps can run; their errors never escape with arbitrary text. */
export function valueFields(
  input: unknown,
  allowed: readonly string[],
  required = allowed,
  code: ValueTableErrorCode = 'invalid-table',
): Record<string, unknown> {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ValueTableError(code);
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== null && prototype !== Object.prototype) throw new ValueTableError(code);
    const keys = Reflect.ownKeys(input);
    if (keys.length > allowed.length) throw new ValueTableError(code);
    const out: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string' || !allowed.includes(key)) throw new ValueTableError(code);
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new ValueTableError(code);
      out[key] = descriptor.value;
    }
    if (required.some((key) => !Object.hasOwn(out, key))) throw new ValueTableError(code);
    return out;
  } catch {
    throw new ValueTableError(code);
  }
}

export function valueRows(input: unknown, maxEntries: number): unknown[] {
  try {
    if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype)
      throw new ValueTableError('invalid-table');
    const length = Object.getOwnPropertyDescriptor(input, 'length');
    if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0)
      throw new ValueTableError('invalid-table');
    if (length.value > maxEntries) throw new ValueTableError('table-limit');
    if (Reflect.ownKeys(input).length !== length.value + 1) throw new ValueTableError('invalid-table');
    const out: unknown[] = [];
    for (let i = 0; i < length.value; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(i));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new ValueTableError('invalid-table');
      out.push(descriptor.value);
    }
    return out;
  } catch (error) {
    throw valueFailure(error);
  }
}
