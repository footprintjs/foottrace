/**
 * `deepEqual` on sets. A set is compared member by member in any order, so the search tries a
 * member against candidates that do not match. A try that fails must leave nothing behind: the
 * pairs it met are otherwise remembered as "already known equal", and a later comparison of the
 * same two objects is answered `true`. The net-change filter then drops a real change.
 */
import { describe, expect, it } from 'vitest';

import { deepEqual } from '../../../../src/lib/memory/equality.js';
import { TransactionBuffer } from '../../../../src/lib/memory/TransactionBuffer.js';

describe('deepEqual — a failed try inside a set leaves no memory', () => {
  it('two different objects stay different after a set tried and refused to pair them', () => {
    const o1 = { v: 1 };
    const o2 = { v: 2 };
    // In the sets, o1 is first tried against o2 (no match) and then pairs with { v: 1 }.
    const a = [new Set([o1, { v: 2 }]), o1];
    const b = [new Set([o2, { v: 1 }]), o2];
    expect(deepEqual(o1, o2)).toBe(false);
    expect(deepEqual(a, b)).toBe(false);
  });

  it('the pairs met deeper inside a failed try are forgotten too', () => {
    const inner1 = { v: 1 };
    const inner2 = { v: 2 };
    const a = [
      new Set([
        { same: 0, box: inner1 },
        { same: 0, box: { v: 2 } },
      ]),
      inner1,
    ];
    const b = [
      new Set([
        { same: 0, box: inner2 },
        { same: 0, box: { v: 1 } },
      ]),
      inner2,
    ];
    expect(deepEqual(a, b)).toBe(false);
  });

  it('a failed try inside a set that is itself being tried is forgotten with it', () => {
    const o1 = { v: 1 };
    const o2 = { v: 2 };
    const a = [new Set([new Set([o1, { v: 2 }])]), o1];
    const b = [new Set([new Set([o2, { v: 1 }])]), o2];
    expect(deepEqual(a, b)).toBe(false);
  });

  it('the net-change filter records the change such a value hides', () => {
    const o1 = { v: 1 };
    const o2 = { v: 2 };
    const before = { k: [new Set([o1, { v: 2 }]), o1] };
    const buffer = new TransactionBuffer(before, 'full');
    buffer.set(['k'], [new Set([o2, { v: 1 }]), o2]);
    expect(buffer.commit().trace.map((row) => row.path)).toEqual(['k']);
  });
});

describe('deepEqual — sets, the rules that stay', () => {
  it('order does not matter, for primitives and for objects', () => {
    expect(deepEqual(new Set([1, 'a', null]), new Set([null, 1, 'a']))).toBe(true);
    expect(deepEqual(new Set([{ v: 1 }, { v: 2 }]), new Set([{ v: 2 }, { v: 1 }]))).toBe(true);
  });

  it('a primitive member has no structural twin', () => {
    expect(deepEqual(new Set([1, 2]), new Set([1, 3]))).toBe(false);
    expect(deepEqual(new Set([NaN, 0]), new Set([-0, NaN]))).toBe(true);
    expect(deepEqual(new Set(['1']), new Set([1]))).toBe(false);
  });

  it('two equal members of one set cannot both claim the same member of the other', () => {
    expect(deepEqual(new Set([{ v: 1 }, { v: 1 }]), new Set([{ v: 1 }, { v: 2 }]))).toBe(false);
  });

  it('a member both sets hold by reference pairs with itself, and the rest pair by content', () => {
    const shared = { v: 1 };
    expect(deepEqual(new Set([{ v: 1 }, shared]), new Set([shared, { v: 1 }]))).toBe(true);
    expect(deepEqual(new Set([{ v: 1 }, shared]), new Set([shared, { v: 2 }]))).toBe(false);
  });

  it('a set that holds itself still ends, and compares by structure', () => {
    const a = new Set<unknown>([1]);
    a.add(a);
    const b = new Set<unknown>([1]);
    b.add(b);
    expect(deepEqual(a, b)).toBe(true);
    const c = new Set<unknown>([2]);
    c.add(c);
    expect(deepEqual(a, c)).toBe(false);
  });

  it('a large set of primitives is compared in one pass (no quadratic scan)', () => {
    const n = 200_000;
    const a = new Set<number>();
    const b = new Set<number>();
    for (let i = 0; i < n; i++) a.add(i);
    for (let i = n - 1; i >= 0; i--) b.add(i);
    const started = performance.now();
    expect(deepEqual(a, b)).toBe(true);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
