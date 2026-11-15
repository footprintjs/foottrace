import { ownJson } from './admit.js';
import { utf8Bytes } from './utf8.js';
import { OwnedJsonError, ownedJsonFailureCode } from './types.js';
import type { OwnedJsonBounds, OwnedJsonSnapshot, OwnedJsonValue } from './types.js';

/** Private shared core: callers supply concrete validated bounds before admission. */
export function ownedJsonSnapshot(input: unknown, limits: OwnedJsonBounds): OwnedJsonSnapshot {
  try {
    const value = ownJson(input, limits);
    const parts: string[] = [];
    let bytes = 0,
      sortWork = 0;
    const emit = (text: string): void => {
      bytes += utf8Bytes(text);
      if (bytes > limits.maxBytes) throw new OwnedJsonError('output-bytes');
      parts.push(text);
    };
    const write = (node: OwnedJsonValue): void => {
      if (node === null || typeof node !== 'object') {
        emit(JSON.stringify(node));
        return;
      }
      if (Array.isArray(node)) {
        emit('[');
        for (let i = 0; i < node.length; i++) {
          if (i) emit(',');
          write(node[i]);
        }
        emit(']');
        return;
      }
      const keys = Object.keys(node).sort((a, b) => {
        sortWork += 1 + Math.min(a.length, b.length);
        if (sortWork > limits.maxSortWork) throw new OwnedJsonError('sort-work');
        return a < b ? -1 : a > b ? 1 : 0;
      });
      emit('{');
      for (let i = 0; i < keys.length; i++) {
        if (i) emit(',');
        emit(JSON.stringify(keys[i]));
        emit(':');
        write((node as { readonly [key: string]: OwnedJsonValue })[keys[i]]);
      }
      emit('}');
    };
    write(value);
    return { value, text: parts.join(''), bytes };
  } catch (error) {
    throw new OwnedJsonError(ownedJsonFailureCode(error));
  }
}
