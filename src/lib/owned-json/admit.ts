import { deepFreeze } from '../capture/freeze.js';
import { OwnedJsonError } from './types.js';
import type { OwnedJsonBounds, OwnedJsonValue } from './types.js';
import { utf8Bytes } from './utf8.js';

/** Reject lone surrogates before using the well-formed-string UTF-8 counter. */
export function wellFormed(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new OwnedJsonError('unicode');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new OwnedJsonError('unicode');
  }
}

/** Copy own DATA descriptors only. No getter, coercion or executable toJSON is consulted. */
export function ownJson(input: unknown, limits: OwnedJsonBounds): OwnedJsonValue {
  let nodes = 0,
    fields = 0,
    strings = 0;
  const active = new Set<object>();
  const string = (value: string): void => {
    if (value.length > limits.maxStringBytes - strings) throw new OwnedJsonError('string-bytes');
    wellFormed(value);
    strings += utf8Bytes(value);
    if (strings > limits.maxStringBytes) throw new OwnedJsonError('string-bytes');
  };
  const read = (value: unknown, depth: number): OwnedJsonValue => {
    if (++nodes > limits.maxNodes) throw new OwnedJsonError('nodes');
    if (depth > limits.maxDepth) throw new OwnedJsonError('depth');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new OwnedJsonError('unsupported');
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === 'string') {
      string(value);
      return value;
    }
    if (typeof value !== 'object') throw new OwnedJsonError('unsupported');
    if (active.has(value)) throw new OwnedJsonError('cycle');
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw new OwnedJsonError('unsupported');
    const keys = Reflect.ownKeys(value);
    const count = keys.length - (array ? 1 : 0);
    if (count > limits.maxFields - fields) throw new OwnedJsonError('fields');
    fields += count;
    const result: OwnedJsonValue[] | { [key: string]: OwnedJsonValue } = array ? [] : Object.create(null);
    let length = 0;
    if (array) {
      const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (!descriptor || !('value' in descriptor) || !Number.isSafeInteger(descriptor.value))
        throw new OwnedJsonError('unreadable');
      length = descriptor.value;
      if (length !== count) throw new OwnedJsonError('unsupported');
      if (length > limits.maxNodes - nodes) throw new OwnedJsonError('nodes');
    }
    active.add(value);
    try {
      for (const key of keys) {
        if (array && key === 'length') continue;
        if (typeof key !== 'string') throw new OwnedJsonError('unsupported');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) throw new OwnedJsonError('unsupported');
        if (array) {
          const index = Number(key);
          if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key)
            throw new OwnedJsonError('unsupported');
          (result as OwnedJsonValue[])[index] = read(descriptor.value, depth + 1);
        } else {
          string(key);
          (result as { [key: string]: OwnedJsonValue })[key] = read(descriptor.value, depth + 1);
        }
      }
    } finally {
      active.delete(value);
    }
    return result;
  };
  return deepFreeze(read(input, 0));
}
