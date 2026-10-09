/** Public helper contracts preserve the distinct record and ID grammars and record value laws. */
import { describe, expect, it } from 'vitest';

import {
  deepEqual,
  idPathSegments,
  isExecutionKey,
  joinPath,
  serveRecord,
  splitStageId,
  stageIdOf,
  subflowSegmentsOf,
} from '../../src/index';
import {
  isDeniedSegment,
  nativeGet,
  nativeHas,
  normaliseStateKey,
  pathSegments,
  setNestedValue,
  updateNestedValue,
} from '../../src/paths';
import { deepFreeze, freezeRecord, LOG_PLACEHOLDER } from '../../src/write';

describe('public helper contracts', () => {
  it('keeps ID paths and record paths distinct, including empty and dotted keys', () => {
    expect(idPathSegments('/a//b/')).toEqual(['a', 'b']);
    expect(pathSegments(normaliseStateKey(['a.b', '', 'c/d']))).toEqual(['a.b', '', 'c/d']);
    expect(pathSegments('')).toEqual(['']);
    expect(idPathSegments('')).toEqual([]);
    expect(normaliseStateKey('a.b')).toBe('a.b');
    const state = { 'a.b': { c: 1 }, a: { b: { c: 2 } } };
    expect(nativeGet(state, pathSegments(normaliseStateKey(['a.b', 'c'])))).toBe(1);
    expect(nativeGet(state, 'a.b.c')).toBe(2);
  });

  it('reads the full stage ID and local stage ID without confusing them', () => {
    const id = joinPath('sf-a', 'sf-b', 'stage') + '#12';
    expect(stageIdOf(id)).toBe('sf-a/sf-b/stage');
    expect(splitStageId(stageIdOf(id)).localStageId).toBe('stage');
    expect(subflowSegmentsOf(id)).toEqual(['sf-a', 'sf-b']);
    expect(isExecutionKey(id)).toBe(true);
    expect(isExecutionKey('stage#not-an-index')).toBe(true); // delimiter presence, not validation
  });

  it('nativeHas tests own existence while nativeGet refuses denied selectors', () => {
    const state = JSON.parse('{"constructor":1,"__proto__":2,"prototype":3}');
    state.empty = undefined;
    for (const key of ['constructor', '__proto__', 'prototype']) {
      expect(isDeniedSegment(key)).toBe(true);
      expect(nativeHas(state, [key])).toBe(true);
      expect(nativeGet(state, [key], 'absent')).toBe('absent');
    }
    expect(nativeHas(state, ['empty'])).toBe(true);
    expect(nativeGet(state, ['empty'], 'absent')).toBe('absent');
    expect(nativeHas({}, 'toString')).toBe(false);
  });

  it('nested helpers retain whole-selector refusal and their existing merge law', () => {
    const state: Record<string, unknown> = {};
    setNestedValue(state, [], ['pending', '__proto__'], 'value', 1);
    expect(state).toEqual({});
    setNestedValue(state, [], [], 'a.b', [1]);
    updateNestedValue(state, [], [], 'a.b', [2]);
    expect(state).toEqual({ 'a.b': [1, 2] });
    updateNestedValue(state, [], [], 'a.b', []);
    expect(state).toEqual({ 'a.b': [] });
    expect(LOG_PLACEHOLDER).toBe('REDACTED');
  });

  it('equality follows recorded-state semantics, including opaque-copy mode', () => {
    expect(deepEqual({}, { missing: undefined })).toBe(true);
    expect(deepEqual(0, -0)).toBe(true);
    expect(deepEqual(Object.assign([1], { note: 2 }), [1])).toBe(true);
    const map = new Map([[{}, 1]]);
    expect(deepEqual(map, structuredClone(map))).toBe(false);
    const opaque = new Blob(['one']);
    expect(deepEqual(opaque, new Blob(['one']))).toBe(false);
    expect(deepEqual(opaque, structuredClone(opaque), 'copies')).toBe(true);
  });

  it('freezes writer-owned containers and serves a new copy of unsealable values', () => {
    const state = { when: new Date(5), safe: { value: 1 } };
    expect(freezeRecord(state)).toBe(state);
    expect(Object.isFrozen(state.safe)).toBe(true);
    const held = serveRecord(state);
    held.when.setTime(9);
    expect(serveRecord(state).when.getTime()).toBe(5);
    expect(held.safe).toBe(state.safe);
    const unregistered = { when: new Date(0) };
    expect(serveRecord(unregistered)).toBe(unregistered);
  });

  it('deepFreeze is an ownership guard, not a guarantee of sealed native internals', () => {
    const nested = Object.freeze({ live: { n: 1 } });
    const state = deepFreeze({ nested, when: new Date(5), bytes: new Uint8Array([1]) });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(nested.live)).toBe(false);
    expect(Object.isFrozen(state.bytes)).toBe(false);
    state.when.setTime(8);
    expect(state.when.getTime()).toBe(8);
  });
});
