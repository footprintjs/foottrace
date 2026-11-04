import { describe, expect, it } from 'vitest';
import { normalisePath, pathSegments } from './codec.js';

describe('pathSegments — the supported way to read a TraceEntry.path', () => {
  it('is the inverse of normalisePath', () => {
    for (const path of [['order'], ['order', 'lines'], ['runs', 'r1', 'order', 'lines']]) {
      expect(pathSegments(normalisePath(path))).toEqual(path);
    }
  });

  it('a single-segment path needs no special case', () => {
    expect(pathSegments('order')).toEqual(['order']);
  });

  it('keeps a state key that literally contains a dot in ONE segment', () => {
    // This is the ambiguity DELIM exists to prevent: `$setValue('a.b', v)`
    // creates one top-level key named `a.b`, which a dot separator could not
    // be told apart from the nested path ['a', 'b'].
    expect(pathSegments(normalisePath(['a.b']))).toEqual(['a.b']);
    expect(pathSegments(normalisePath(['a', 'b']))).toEqual(['a', 'b']);
  });

  it('numeric segments come back as strings, matching how paths are joined', () => {
    expect(pathSegments(normalisePath(['lines', 0, 'qty']))).toEqual(['lines', '0', 'qty']);
  });
});
