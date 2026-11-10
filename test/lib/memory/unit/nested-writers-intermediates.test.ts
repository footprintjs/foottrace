/**
 * A nested write whose path runs THROUGH a value that is not a container (a number, a string,
 * null). The record's own writer (`pathOps · nativeSet`, and so every replayed bundle) replaces
 * that value with a container. The nested writers and the heap's direct writes walked into it and
 * failed with whatever TypeError the engine happened to raise. One rule now: the write wins.
 */
import { describe, expect, it } from 'vitest';

import { nativeSet } from '../../../../src/lib/memory/pathOps.js';
import { SharedMemory } from '../../../../src/lib/memory/SharedMemory.js';
import { setNestedValue, updateNestedValue } from '../../../../src/lib/memory/utils.js';

const THROUGH: ReadonlyArray<[string, unknown]> = [
  ['a number', 5],
  ['a string', 'x'],
  ['null', null],
  ['false', false],
];

describe('a nested write through a value that is not a container', () => {
  it.each(THROUGH)('setNestedValue replaces %s with a container, as nativeSet does', (_name, value) => {
    expect(setNestedValue({ a: value, keep: 1 }, [], ['a'], 'b', 1)).toEqual({ a: { b: 1 }, keep: 1 });
    expect(nativeSet({ a: value, keep: 1 }, ['a', 'b'], 1)).toEqual({ a: { b: 1 }, keep: 1 });
  });

  it.each(THROUGH)('updateNestedValue replaces %s with a container', (_name, value) => {
    expect(updateNestedValue({ a: value }, [], ['a'], 'b', { n: 1 })).toEqual({ a: { b: { n: 1 } } });
  });

  it('replaces only the value in the way: deeper and under an address', () => {
    expect(setNestedValue({ a: { b: 7, c: 1 } }, [], ['a', 'b'], 'leaf', 1)).toEqual({
      a: { b: { leaf: 1 }, c: 1 },
    });
    expect(setNestedValue({ runs: { p1: 3 } }, ['runs', 'p1'], [], 'k', 1)).toEqual({ runs: { p1: { k: 1 } } });
  });

  it('seeds the container AT the address from the defaults when it replaces a value there', () => {
    const out = setNestedValue({ runs: { p1: 3 } }, ['runs', 'p1'], [], 'k', 1, { seeded: true });
    expect(out).toEqual({ runs: { p1: { seeded: true, k: 1 } } });
  });

  it('keeps an existing container and what it holds', () => {
    const branch = { leaf: 1 };
    const root = { branch };
    setNestedValue(root, [], ['branch'], 'other', 2);
    expect(root.branch).toBe(branch);
    expect(root).toEqual({ branch: { leaf: 1, other: 2 } });
  });

  it('the heap writes the same state, as a new generation', () => {
    const memory = new SharedMemory(undefined, { a: 5, keep: { n: 1 } });
    const before = memory.getState();
    memory.setValue([], ['a'], 'b', 1);
    expect(memory.getState()).toEqual({ a: { b: 1 }, keep: { n: 1 } });
    expect(before).toEqual({ a: 5, keep: { n: 1 } }); // the generation it replaced is untouched
    memory.updateValue([], ['a', 'b2'], 'list', [1]);
    expect(memory.getState()).toEqual({ a: { b: 1, b2: { list: [1] } }, keep: { n: 1 } });
  });
});
