import { ownJson, utf8Bytes } from './admit.js';
import { canonicalLimits } from './limits.js';
import { CanonicalJsonError, canonicalFailure } from './types.js';
import type { CanonicalJsonOptions, JsonValue } from './types.js';

export interface CanonicalSnapshot {
  readonly value: JsonValue;
  readonly text: string;
  readonly bytes: number;
}

/** Internal owned snapshot; all admission and serialization finish before a caller can await. */
export function canonicalSnapshot(input: unknown, options?: CanonicalJsonOptions): CanonicalSnapshot {
  const limits = canonicalLimits(options);
  try {
    const value = ownJson(input, limits);
    const parts: string[] = [];
    let bytes = 0,
      sortWork = 0;
    const emit = (text: string): void => {
      bytes += utf8Bytes(text);
      if (bytes > limits.maxBytes) throw new CanonicalJsonError('output-bytes');
      parts.push(text);
    };
    const write = (node: JsonValue): void => {
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
        if (sortWork > limits.maxSortWork) throw new CanonicalJsonError('sort-work');
        return a < b ? -1 : a > b ? 1 : 0;
      });
      emit('{');
      for (let i = 0; i < keys.length; i++) {
        if (i) emit(',');
        emit(JSON.stringify(keys[i]));
        emit(':');
        write((node as { readonly [key: string]: JsonValue })[keys[i]]);
      }
      emit('}');
    };
    write(value);
    return { value, text: parts.join(''), bytes };
  } catch (error) {
    throw canonicalFailure(error);
  }
}

/**
 * RFC 8785 canonical text of a bounded owned-JSON value. Never calls toJSON or a getter.
 * Finite binary64 numbers and well-formed Unicode only; no normalization or partial output.
 * Proxy descriptor traps may run; a host must isolate a trap that never returns.
 */
export function canonicalizeJson(value: unknown, options?: CanonicalJsonOptions): string {
  return canonicalSnapshot(value, options).text;
}
