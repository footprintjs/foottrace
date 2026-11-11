/**
 * parentEdges.ts — which edges a child keeps to one parent for one key, whatever order the walk
 * meets the links in.
 *
 * The walk back meets links one at a time. Its answer used to depend on the order for one pair: a
 * possible link the record's rows made, then a certain link to the same parent, left two edges; the
 * other way round, one. Nothing pinned it (swapping two lines of the walk changed the answer and
 * every test still passed: the second reader of the change that added `'built-on-view'` did that).
 *
 * Test types: property (every order of every small set of links, against a statement of the rule
 * that knows no order), scenario (the record the reader found it on, through the public walk).
 */
import { describe, expect, it } from 'vitest';

import { causalChain, flattenCausalDAG, keysReadFromMap } from '../../../src';
import type { CommitBundle } from '../../../src';
import { type LinkMarks, takeLink } from '../../../src/lib/memory/parentEdges';

const D = '\u001f';
/** The seven links one child can have to one parent for one key. */
const LINKS: Record<string, LinkMarks> = {
  read: {},
  'read, as it began': { overlap: 'replaced-while-running' },
  'read, while it ran': { overlap: 'written-while-running' },
  fold: { builtOn: 'partial-write' },
  view: { builtOn: 'built-on-view' },
  'view, as it began': { builtOn: 'built-on-view', overlap: 'replaced-while-running' },
  'view, while it ran': { builtOn: 'built-on-view', overlap: 'written-while-running' },
};
const NAMES = Object.keys(LINKS);
const shown = (edge: LinkMarks) => `${edge.builtOn ?? 'read'}${edge.overlap ? ` (${edge.overlap})` : ''}`;

/** The walk's side: take each link in turn, and add an edge when the rule says so. */
function edgesAfter(order: readonly string[]): string[] {
  const edges: LinkMarks[] = [];
  for (const name of order) if (takeLink(edges, () => true, LINKS[name])) edges.push({ ...LINKS[name] });
  return edges.map(shown).sort();
}

/** The rule, said with no order: what a SET of links leaves. */
function ruleFor(links: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const certain = links.has('read')
    ? 'read'
    : links.has('fold')
    ? 'partial-write'
    : links.has('view')
    ? 'built-on-view'
    : undefined;
  if (certain !== undefined) out.push(certain);
  // A possible read is kept beside anything.
  for (const name of ['read, as it began', 'read, while it ran']) if (links.has(name)) out.push(shown(LINKS[name]));
  // A possible edge the rows made is kept only while nothing certain names the parent.
  if (certain === undefined)
    for (const name of ['view, as it began', 'view, while it ran']) if (links.has(name)) out.push(shown(LINKS[name]));
  return out.sort();
}

describe('the edges to one parent do not depend on the order the links are met in', () => {
  it('every sequence of up to four links leaves what its SET of links says (2,800 sequences)', () => {
    let sequences = 0;
    const grow = (order: string[]): void => {
      sequences++;
      expect(edgesAfter(order), order.join(' → ')).toEqual(ruleFor(new Set(order)));
      if (order.length < 4) for (const name of NAMES) grow([...order, name]);
    };
    grow([]);
    expect(sequences).toBe(1 + 7 + 49 + 343 + 2401);
  });

  it('the pair that depended on the order: a possible view link and the fold, either way round', () => {
    expect(edgesAfter(['view, while it ran', 'fold'])).toEqual(['partial-write']);
    expect(edgesAfter(['fold', 'view, while it ran'])).toEqual(['partial-write']);
  });

  it('only the edges of the same parent, kind and key are touched', () => {
    const edges: (LinkMarks & { parent: string })[] = [
      { parent: 'other', builtOn: 'built-on-view', overlap: 'written-while-running' },
      { parent: 'p', builtOn: 'built-on-view', overlap: 'written-while-running' },
    ];
    expect(takeLink(edges, (edge) => edge.parent === 'p', { builtOn: 'partial-write' })).toBe(true);
    expect(edges).toEqual([{ parent: 'other', builtOn: 'built-on-view', overlap: 'written-while-running' }]);
  });
});

describe('the record it was found on, through the public walk', () => {
  // start sets `a`; p merges into `a`; fill holds a row INSIDE `a` that the writer built on its view;
  // use reads `a`. The record does not show whether p's commit was in fill's view (p says no index, in
  // a hole of the indices). So fill owes the walk two things for `a`: the write its row was folded
  // onto, which is p for certain, and what its view could have held, which is start or p.
  const row = (path: string, verb: 'set' | 'merge', extra: object = {}) => ({ path, verb, ...extra });
  const bundle = (id: string, idx: number | undefined, trace: CommitBundle['trace'], extra: object = {}) =>
    ({
      ...(idx !== undefined && { idx }),
      stage: id,
      stageId: id,
      runtimeStageId: `${id}#0`,
      trace,
      redactedPaths: [],
      overwrite: {},
      updates: {},
      ...extra,
    } as CommitBundle);
  const log = [
    bundle('start', 10, [row('a', 'set')]),
    bundle('p', undefined, [row('a', 'merge')]),
    bundle('fill', 13, [row(`a${D}b`, 'set', { builtOnView: true })], { viewAt: 12 }),
    bundle('use', 14, [row('out', 'set')]),
  ];

  it('one edge from fill to p, and it is the certain one; start stays a possible source of the view', () => {
    const root = causalChain(log, 'use#0', keysReadFromMap({ 'use#0': ['a'] }).lookup)!;
    const edges = flattenCausalDAG(root).flatMap((node) =>
      node.parentEdges.map(
        (edge) =>
          `${node.stageId} <- ${edge.parent.stageId} via ${edge.key}` +
          (edge.builtOn ? ` [${edge.builtOn}]` : '') +
          (edge.overlap ? ` (${edge.overlap})` : ''),
      ),
    );
    expect(edges.sort()).toEqual(
      [
        'use <- fill via a',
        'fill <- p via a [partial-write]',
        'fill <- start via a [built-on-view] (replaced-while-running)',
        'p <- start via a [partial-write]',
      ].sort(),
    );
  });
});
