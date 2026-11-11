/**
 * `deepEqual` against an independent judge, on values that SHARE sub-objects and hold sets.
 *
 * A value is built from a small list of nodes; a node's children are earlier nodes, so one object
 * can sit in many places (and in several sets). The judge never walks the built value: it writes each
 * node of the plan as a canonical string (a set as the sorted list of its distinct children), and two
 * values are equal exactly when their roots' strings are. The two share no code with `equality.ts`.
 *
 * This is the case a set makes hard: its members are tried against candidates that do not match, and
 * what a failed try learned must not be read later as "equal". A cycle is out of scope here (the
 * judge needs a finite string); `unit/equality-sets.test.ts` covers values that point back at themselves.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { deepEqual } from '../../../../src/lib/memory/equality.js';

type Node =
  | { readonly kind: 'leaf'; readonly value: number }
  | { readonly kind: 'array' | 'set' | 'object'; readonly kids: readonly number[] };

/** A plan of 1 to 9 nodes; node `i` may only name nodes before it, so the plan has no cycle. */
const planArb: fc.Arbitrary<Node[]> = fc
  .array(
    fc.record({
      kind: fc.constantFrom('leaf', 'array', 'set', 'object'),
      value: fc.integer({ min: 0, max: 2 }),
      picks: fc.array(fc.nat(), { maxLength: 3 }),
    }),
    { minLength: 1, maxLength: 9 },
  )
  .map((raw) =>
    raw.map((spec, i): Node => {
      if (spec.kind === 'leaf' || i === 0) return { kind: 'leaf', value: spec.value };
      return { kind: spec.kind as 'array' | 'set' | 'object', kids: spec.picks.map((pick) => pick % i) };
    }),
  );

/** Build the value of every node; a child is the SAME object wherever the plan names it. */
function build(plan: readonly Node[]): unknown {
  const built: unknown[] = [];
  for (const node of plan) {
    if (node.kind === 'leaf') built.push({ leaf: node.value });
    else if (node.kind === 'array') built.push(node.kids.map((kid) => built[kid]));
    else if (node.kind === 'set') built.push(new Set(node.kids.map((kid) => built[kid])));
    else built.push(Object.fromEntries(node.kids.map((kid, at) => [`k${at}`, built[kid]])));
  }
  return built[built.length - 1];
}

/** The judge: one canonical string per node of the plan. A set holds each child once, in no order. */
function canon(plan: readonly Node[]): string {
  const text: string[] = [];
  for (const node of plan) {
    if (node.kind === 'leaf') text.push(`L${node.value}`);
    else if (node.kind === 'array') text.push(`[${node.kids.map((kid) => text[kid]).join(',')}]`);
    else if (node.kind === 'object') text.push(`{${node.kids.map((kid, at) => `k${at}:${text[kid]}`).join(',')}}`);
    else {
      const members = [...new Set(node.kids)].map((kid) => text[kid]).sort();
      text.push(`S(${members.join('|')})`);
    }
  }
  return text[text.length - 1];
}

/**
 * A near copy of `plan`: every set lists its children in a new order (which changes nothing: a set
 * has none), then up to two small changes: a leaf value moved, or one child of one node pointed at
 * another node. The new order is what makes a set try the wrong candidate first.
 */
const nearCopyArb = planArb.chain((plan) =>
  fc
    .record({
      orders: fc.array(fc.array(fc.nat(), { minLength: 3, maxLength: 3 }), {
        minLength: plan.length,
        maxLength: plan.length,
      }),
      changes: fc.array(fc.record({ at: fc.nat(), by: fc.integer({ min: 1, max: 2 }) }), { maxLength: 2 }),
    })
    .map(({ orders, changes }) => {
      const copy: Node[] = plan.map((node, i) => {
        if (node.kind !== 'set') return node;
        const ranked = node.kids.map((kid, at) => ({ kid, rank: orders[i][at % 3] + at / 10 }));
        return { kind: 'set', kids: ranked.sort((x, y) => x.rank - y.rank).map((entry) => entry.kid) };
      });
      for (const { at, by } of changes) {
        const index = at % copy.length;
        const node = copy[index];
        if (node.kind === 'leaf') copy[index] = { kind: 'leaf', value: (node.value + by) % 3 };
        else if (node.kids.length > 0) {
          const kids = node.kids.slice();
          const slot = by % kids.length;
          kids[slot] = (kids[slot] + by) % index;
          copy[index] = { kind: node.kind, kids };
        }
      }
      return [plan, copy] as const;
    }),
);

describe('property: deepEqual agrees with an independent judge on shared values that hold sets', () => {
  it('two independent values', () => {
    fc.assert(
      fc.property(planArb, planArb, (a, b) => {
        expect(deepEqual(build(a), build(b))).toBe(canon(a) === canon(b));
      }),
      { numRuns: 2000 },
    );
  });

  it('a value and a near copy of it (the cases that are almost equal)', () => {
    fc.assert(
      fc.property(nearCopyArb, ([a, b]) => {
        expect(deepEqual(build(a), build(b))).toBe(canon(a) === canon(b));
        expect(deepEqual(build(b), build(a))).toBe(canon(a) === canon(b));
      }),
      { numRuns: 5000 },
    );
  });

  it('a value and a second build of the same plan are equal', () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        expect(deepEqual(build(plan), build(plan))).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });
});
