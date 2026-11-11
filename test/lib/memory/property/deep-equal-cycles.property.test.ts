/**
 * `deepEqual` against an independent judge, on values that point back at themselves.
 *
 * A value is built from a small list of nodes whose children may be ANY node of the list, so a plan
 * can hold cycles, shared nodes, and sets whose members lead back to their owner. Two such values
 * are equal when no walk from their roots can tell them apart. The judge decides that without
 * walking pairs at all: it sorts the nodes of both plans into classes and keeps splitting a class
 * while two of its nodes differ in kind, in value, or in the classes of their children (in order for
 * an array or an object, as an unordered collection for a set). When nothing splits any more, two
 * nodes are equal exactly when they share a class. It shares no code with `equality.ts`.
 *
 * `deepEqual` gets there the other way: it assumes a pair it is still comparing is equal, keeps what
 * it found on such an assumption apart from what it knows, and settles the first when the pair is
 * settled. This property is what holds that bookkeeping to the right answer in both directions.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { deepEqual } from '../../../../src/lib/memory/equality.js';

/**
 * Thousands of generated cases: seconds under coverage on a shared CI machine, where the default
 * 5 s limit is too close. The limit is on the clock only; the number of cases is fixed.
 */
const PROPERTY_TIME_LIMIT_MS = 120_000;

type Kind = 'leaf' | 'array' | 'set' | 'object';
interface Node {
  readonly kind: Kind;
  readonly value: number;
  readonly kids: readonly number[];
}

/**
 * A plan of 2 to 10 nodes; a node may name any node, itself included. The last node is the root.
 * Mostly objects and sets with two or three children: the shapes where a set must choose between
 * members that look alike until a walk comes back round.
 */
const planArb: fc.Arbitrary<Node[]> = fc
  .array(
    fc.record({
      kind: fc.constantFrom<Kind>('leaf', 'array', 'set', 'set', 'set', 'object', 'object', 'object', 'object'),
      value: fc.integer({ min: 0, max: 1 }),
      picks: fc.array(fc.nat(), { minLength: 1, maxLength: 3 }),
    }),
    { minLength: 2, maxLength: 10 },
  )
  .map((raw) =>
    raw.map(
      (spec): Node => ({
        kind: spec.kind,
        value: spec.value,
        kids: spec.kind === 'leaf' ? [] : spec.picks.map((pick) => pick % raw.length),
      }),
    ),
  );

/** Build every node's value first, then link them, so a child can be a later node or the node itself. */
function build(plan: readonly Node[]): unknown {
  const built = plan.map((node): unknown => {
    if (node.kind === 'leaf') return { leaf: node.value };
    if (node.kind === 'array') return [];
    if (node.kind === 'set') return new Set<unknown>();
    return {};
  });
  plan.forEach((node, i) => {
    const kids = node.kids.map((kid) => built[kid]);
    if (node.kind === 'array') (built[i] as unknown[]).push(...kids);
    else if (node.kind === 'set') for (const kid of kids) (built[i] as Set<unknown>).add(kid);
    else if (node.kind === 'object') kids.forEach((kid, at) => ((built[i] as Record<string, unknown>)[`k${at}`] = kid));
  });
  return built[built.length - 1];
}

/** The judge: are the roots of `a` and `b` in one class once no class can be split any further? */
function judge(a: readonly Node[], b: readonly Node[]): boolean {
  const nodes = [...a, ...b.map((node) => ({ ...node, kids: node.kids.map((kid) => kid + a.length) }))];
  let classOf = nodes.map(() => 0);
  for (;;) {
    const names = new Map<string, number>();
    const next = nodes.map((node) => {
      const kidClasses =
        node.kind === 'set'
          ? [...new Set(node.kids)].map((kid) => classOf[kid]).sort((x, y) => x - y)
          : node.kids.map((kid) => classOf[kid]);
      const signature = `${node.kind}:${node.kind === 'leaf' ? node.value : ''}:${kidClasses.join(',')}`;
      if (!names.has(signature)) names.set(signature, names.size);
      return names.get(signature) as number;
    });
    const settled = new Set(next).size === new Set(classOf).size;
    classOf = next;
    if (settled) break;
  }
  return classOf[a.length - 1] === classOf[nodes.length - 1];
}

/**
 * A near copy: the same plan with its nodes renumbered (all but the root, which stays last) and every
 * set listing its children in a new order, neither of which changes the value, then up to two small
 * changes, which may.
 */
const nearCopyArb = planArb.chain((plan) =>
  fc
    .record({
      orders: fc.array(fc.array(fc.nat(), { minLength: 3, maxLength: 3 }), {
        minLength: plan.length,
        maxLength: plan.length,
      }),
      renumber: fc.shuffledSubarray(
        plan.slice(0, -1).map((_, i) => i),
        { minLength: plan.length - 1 },
      ),
      changes: fc.array(fc.record({ at: fc.nat(), by: fc.integer({ min: 1, max: 3 }) }), { maxLength: 2 }),
    })
    .map(({ orders, renumber, changes }) => {
      // `renumber[newIndex]` is the old index that moves there; the root keeps the last place.
      const from = [...renumber, plan.length - 1];
      const to = from.map((_, old) => from.indexOf(old));
      const copy: Node[] = from.map((old, i) => {
        const node = plan[old];
        const kids = node.kids.map((kid) => to[kid]);
        if (node.kind !== 'set') return { ...node, kids };
        const ranked = kids.map((kid, at) => ({ kid, rank: orders[i][at % 3] + at / 10 }));
        return { ...node, kids: ranked.sort((x, y) => x.rank - y.rank).map((entry) => entry.kid) };
      });
      for (const { at, by } of changes) {
        const index = at % copy.length;
        const node = copy[index];
        if (node.kind === 'leaf') copy[index] = { ...node, value: (node.value + by) % 2 };
        else if (node.kids.length > 0) {
          const kids = node.kids.slice();
          const slot = by % kids.length;
          kids[slot] = (kids[slot] + by) % copy.length;
          copy[index] = { ...node, kids };
        }
      }
      return [plan, copy] as const;
    }),
);

describe('property: deepEqual agrees with an independent judge on values that point back at themselves', () => {
  it(
    'a value and a near copy of it, asked both ways round',
    () => {
      fc.assert(
        fc.property(nearCopyArb, ([a, b]) => {
          const equal = judge(a, b);
          expect(deepEqual(build(a), build(b))).toBe(equal);
          expect(deepEqual(build(b), build(a))).toBe(equal);
        }),
        { numRuns: 20000 },
      );
    },
    PROPERTY_TIME_LIMIT_MS,
  );

  it(
    'two independent values',
    () => {
      fc.assert(
        fc.property(planArb, planArb, (a, b) => {
          expect(deepEqual(build(a), build(b))).toBe(judge(a, b));
        }),
        { numRuns: 5000 },
      );
    },
    PROPERTY_TIME_LIMIT_MS,
  );

  it(
    'a value and a second build of the same plan are equal, and so is the value and itself',
    () => {
      fc.assert(
        fc.property(planArb, (plan) => {
          const value = build(plan);
          expect(deepEqual(value, build(plan))).toBe(true);
          expect(deepEqual(value, value)).toBe(true);
        }),
        { numRuns: 2000 },
      );
    },
    PROPERTY_TIME_LIMIT_MS,
  );
});
