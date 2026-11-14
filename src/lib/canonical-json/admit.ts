import { deepFreeze } from '../capture/freeze.js';
import type { CanonicalLimits } from './limits.js';
import { CanonicalJsonError } from './types.js';
import type { JsonValue } from './types.js';

const encoder = new TextEncoder();
export const utf8Bytes = (text: string): number => encoder.encode(text).byteLength;

/** Validate Unicode before UTF-8 encoding could replace a lone surrogate. */
export function wellFormed(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new CanonicalJsonError('unicode');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new CanonicalJsonError('unicode');
  }
}

/** Copy own DATA descriptors only. No getter, coercion or executable toJSON is consulted. */
export function ownJson(input: unknown, limits: CanonicalLimits): JsonValue {
  let nodes = 0,
    fields = 0,
    strings = 0;
  const active = new Set<object>();
  const string = (value: string): void => {
    if (value.length > limits.maxStringBytes - strings) throw new CanonicalJsonError('string-bytes');
    wellFormed(value);
    strings += utf8Bytes(value);
    if (strings > limits.maxStringBytes) throw new CanonicalJsonError('string-bytes');
  };
  const read = (value: unknown, depth: number): JsonValue => {
    if (++nodes > limits.maxNodes) throw new CanonicalJsonError('nodes');
    if (depth > limits.maxDepth) throw new CanonicalJsonError('depth');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new CanonicalJsonError('unsupported');
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === 'string') {
      string(value);
      return value;
    }
    if (typeof value !== 'object') throw new CanonicalJsonError('unsupported');
    if (active.has(value)) throw new CanonicalJsonError('cycle');
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      throw new CanonicalJsonError('unsupported');
    const keys = Reflect.ownKeys(value);
    const count = keys.length - (array ? 1 : 0);
    if (count > limits.maxFields - fields) throw new CanonicalJsonError('fields');
    fields += count;
    const result: JsonValue[] | { [key: string]: JsonValue } = array ? [] : Object.create(null);
    let length = 0;
    if (array) {
      const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (!descriptor || !('value' in descriptor) || !Number.isSafeInteger(descriptor.value))
        throw new CanonicalJsonError('unreadable');
      length = descriptor.value;
      if (length !== count) throw new CanonicalJsonError('unsupported');
      if (length > limits.maxNodes - nodes) throw new CanonicalJsonError('nodes');
    }
    active.add(value);
    try {
      for (const key of keys) {
        if (array && key === 'length') continue;
        if (typeof key !== 'string') throw new CanonicalJsonError('unsupported');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
          throw new CanonicalJsonError('unsupported');
        if (array) {
          const index = Number(key);
          if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key)
            throw new CanonicalJsonError('unsupported');
          (result as JsonValue[])[index] = read(descriptor.value, depth + 1);
        } else {
          string(key);
          (result as { [key: string]: JsonValue })[key] = read(descriptor.value, depth + 1);
        }
      }
    } finally {
      active.delete(value);
    }
    return result;
  };
  return deepFreeze(read(input, 0));
}
