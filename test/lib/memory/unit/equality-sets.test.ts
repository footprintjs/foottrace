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

describe('deepEqual — a pair is compared once, whichever way a set search goes', () => {
  /**
   * `depth` levels, each a set of two objects that share the level below. The innermost object counts
   * how often it is read, so the tests count comparisons and need no clock. `flip` lists the two
   * objects of each level in the other order, so the first candidate tried is the wrong one.
   */
  function shared(depth: number, leaf: number, flip = false) {
    const counter = { reads: 0 };
    const innermost = Object.defineProperty({}, 'v', {
      enumerable: true,
      get() {
        counter.reads++;
        return leaf;
      },
    });
    let level: unknown = new Set([innermost]);
    for (let d = 0; d < depth; d++) {
      const below = level;
      const pair = [
        { n: below, t: 1 },
        { n: below, t: 2 },
      ];
      level = new Set(flip ? pair.reverse() : pair);
    }
    return { value: level, counter };
  }
  const DEPTH = 16; // comparing the innermost pair once per path would be 2^16 comparisons

  it('equal values: a pair proven equal inside a try that fails is not compared again', () => {
    const a = shared(DEPTH, 0);
    const b = shared(DEPTH, 0, true);
    expect(deepEqual(a.value, b.value)).toBe(true);
    expect(a.counter.reads).toBeLessThanOrEqual(4);
  });

  it('different values: a pair found different is not compared again', () => {
    const a = shared(DEPTH, 0);
    const b = shared(DEPTH, 1);
    expect(deepEqual(a.value, b.value)).toBe(false);
    expect(a.counter.reads).toBeLessThanOrEqual(4);
  });

  it('a value that shares one object many times, with no set at all, is walked once', () => {
    const counter = { reads: 0 };
    const leaf = () =>
      Object.defineProperty({}, 'v', {
        enumerable: true,
        get() {
          counter.reads++;
          return 1;
        },
      });
    const diamonds = (inner: object) => {
      let level: object = inner;
      for (let d = 0; d < DEPTH; d++) level = { left: level, right: level };
      return level;
    };
    expect(deepEqual(diamonds(leaf()), diamonds(leaf()))).toBe(true);
    expect(counter.reads).toBeLessThanOrEqual(4);
  });
});

describe('deepEqual — values that point back at themselves', () => {
  it('two rings of the same shape are equal, and a ring with one different link is not', () => {
    const ring = (values: number[]) => {
      const nodes = values.map((v) => ({ v, next: null as unknown }));
      nodes.forEach((node, i) => (node.next = nodes[(i + 1) % nodes.length]));
      return nodes[0];
    };
    expect(deepEqual(ring([1, 2, 3]), ring([1, 2, 3]))).toBe(true);
    expect(deepEqual(ring([1, 2, 3]), ring([1, 2, 4]))).toBe(false);
    // The same ring unrolled twice has the same structure: every walk from the start reads the same values.
    expect(deepEqual(ring([1, 2]), ring([1, 2, 1, 2]))).toBe(true);
  });

  it('an equal answer that rested on a pair still being compared is not kept when that pair fails', () => {
    // inner(a) and inner(b) look equal only while their owners are assumed equal; the owners differ in `tail`.
    const make = (tail: number) => {
      const owner: Record<string, unknown> = {};
      const inner = { back: owner };
      owner.first = new Set([inner]);
      owner.tail = tail;
      return { owner, inner };
    };
    const a = make(1);
    const b = make(2);
    expect(deepEqual([a.owner, a.inner], [b.owner, b.inner])).toBe(false);
    expect(deepEqual(a.inner, b.inner)).toBe(false);
  });

  it('a "different" that rested on a wrong guess about a pair above it is not kept as a fact', () => {
    // A and B are equal: A = { {p: h1}, {p: h2x} }, B = { {p: h2}, {p: h1x} }, where h1 ~ h1x and
    // h2x ~ h2 exactly because A ~ B. But h1 and h2 differ (their `tail`).
    const A = new Set<unknown>();
    const B = new Set<unknown>();
    const h1 = { s: A, tail: 1 };
    const h2 = { s: B, tail: 2 };
    const h1x = { s: B, tail: 1 };
    const h2x = { s: A, tail: 2 };
    A.add({ p: h1 }).add({ p: h2x });
    B.add({ p: h2 }).add({ p: h1x });
    expect(deepEqual(A, B)).toBe(true);
    expect(deepEqual(h1, h2)).toBe(false);

    // Comparing h1 with h2 walks into (A, B) while (h1, h2) is still assumed equal. Under that wrong
    // assumption the set search pairs {p: h1} with {p: h2}, cannot pair the rest, and answers
    // "different" for (A, B). That answer must not be remembered: (A, B) is asked again below,
    // where the right answer is "equal".
    const a = new Set<unknown>([{ probe: h1 }, { probe: h2x }, { w: A }]);
    const b = new Set<unknown>([{ probe: h2 }, { probe: h1x }, { w: B }]);
    expect(deepEqual(a, b)).toBe(true);
  });

  it('a map that holds a set that holds the map', () => {
    const make = (extra: number) => {
      const map = new Map<string, unknown>();
      map.set('k', new Set([map]));
      map.set('n', extra);
      return map;
    };
    expect(deepEqual(make(1), make(1))).toBe(true);
    expect(deepEqual(make(1), make(2))).toBe(false);
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
