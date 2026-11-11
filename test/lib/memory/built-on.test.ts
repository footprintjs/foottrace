/**
 * A value built in steps: a write that does not replace a value is not the end of the walk back.
 *
 * `Start` sets a box. `Fill` merges a field into it WITHOUT reading it. `Use` reads the box. What `Use`
 * read is made of both writes, yet the walk back named `Fill` and stopped: `Start` was left out, with
 * no note. The same held for a list appended to and for a row on a path inside the key. One rule now
 * answers it (`memory/builtOn.ts`): a write that did not REPLACE the value was folded onto what the
 * last write before it had left, in commit order, and the walk goes on to that commit.
 *
 * Test types: unit (the rule: what replaces, what a write was built on), scenario (the real writer,
 * then the backward walk and the slice), boundary (the start of the log, two bundles of one step,
 * budgets, a step that also read the key, steps side by side).
 */
import { describe, expect, it } from 'vitest';

import {
  causalChain,
  flattenCausalDAG,
  formatCausalChain,
  formatTimeline,
  forwardSliceForKey,
  keysReadFromMap,
  keyTimeline,
  sliceForKey,
  sliceToJSON,
} from '../../../src';
import type { CausalNode, CommitBundle, KeyMoment, KeyTimeline } from '../../../src';
import { builtDirectlyOn, builtOnBefore, replacesValue } from '../../../src/lib/memory/builtOn';
import { lastWriterPosition } from '../../../src/lib/memory/commitLogUtils';
import { EventLog, RecordFrame, SharedMemory } from '../../../src/write';

type Verb = 'set' | 'merge' | 'append' | 'delete';

function world(seed: Record<string, unknown> = {}) {
  const state = new SharedMemory(undefined, seed);
  const log = new EventLog(seed);
  return { state, log, frame: (address: string[] = []) => new RecordFrame(state, log, address) };
}
function commit(frame: RecordFrame, id: string, phase?: 'exit' | 'repeat'): void {
  frame.commit(() => ({ stage: id, stageId: id, runtimeStageId: `${id}#0`, ...(phase && { phase }) }));
  frame.release();
}
/** One step that writes root keys and reads nothing. (`append` is a row verb, never one a step stages.) */
function writes(
  w: ReturnType<typeof world>,
  id: string,
  rows: Array<[path: string[], value: unknown, verb: Exclude<Verb, 'append'>]>,
): void {
  const frame = w.frame();
  for (const [path, value, verb] of rows) frame.write(path, value, verb);
  commit(frame, id);
}
/** Every edge of a walk, child first: `child <- parent via key`, with its marks. */
const edgesOf = (root: CausalNode) =>
  flattenCausalDAG(root).flatMap((node) =>
    node.parentEdges.map(
      (edge) =>
        `${node.stageId} <- ${edge.parent.stageId} via ${edge.key}` +
        (edge.builtOn ? ' [built on]' : '') +
        (edge.basis ? ` [${edge.basis}]` : '') +
        (edge.overlap ? ` (${edge.overlap})` : ''),
    ),
  );
/** The `'from-initial-state'` note of a timeline, word for word: it names the write it is said of. */
const FOLDED_ON_PRE_RUN_WORDS = (key: string, at: number) =>
  `'${key}' was first written at commit ${at}, by a write that did not replace it — the value there rests on ` +
  'what the key held before the run, which the commit log cannot see, so the writes listed may be only part of ' +
  'it until one replaces the key.';
const walk = (log: CommitBundle[], id: string, reads: Record<string, string[]>, options = {}) =>
  causalChain(log, `${id}#0`, keysReadFromMap(reads).lookup, options)!;

/** The run of the finding: Start sets, Fill adds to both values without reading them, Use reads both. */
function builtInSteps() {
  const w = world();
  writes(w, 'start', [
    [['box'], { a: 1 }, 'set'],
    [['list'], ['first'], 'set'],
  ]);
  writes(w, 'fill', [
    [['box'], { b: 2 }, 'merge'],
    [['list'], ['second'], 'merge'],
  ]);
  const use = w.frame();
  const seen = [use.read([], 'box'), use.read([], 'list')];
  use.write(['final'], JSON.stringify(seen), 'set');
  commit(use, 'use');
  return { log: w.log.list(), state: w.state.getState(), reads: { 'use#0': ['box', 'list'] } };
}

describe('the rule: does a commit replace the value of a key', () => {
  const bundle = (...rows: Array<[path: string, verb: string]>) => ({
    trace: rows.map(([path, verb]) => ({ path, verb })),
  });
  const D = '\u001F';

  it.each([
    ['a set on the key', bundle(['box', 'set']), 'box', true],
    ['a delete on the key', bundle(['box', 'delete']), 'box', true],
    ['a set on a container around the key', bundle(['cfg', 'set']), `cfg${D}a`, true],
    ['a delete of a container around the key', bundle(['cfg', 'delete']), `cfg${D}a${D}b`, true],
    ['a merge on the key', bundle(['box', 'merge']), 'box', false],
    ['an append on the key', bundle(['list', 'append']), 'list', false],
    ['a set on a path inside the key', bundle([`box${D}a`, 'set']), 'box', false],
    ['a delete on a path inside the key', bundle([`box${D}a`, 'delete']), 'box', false],
    ['a merge on a container around the key', bundle(['cfg', 'merge']), `cfg${D}a`, false],
    ['a set on another key', bundle(['other', 'set']), 'box', false],
    ['a set on a key that only starts the same', bundle(['boxes', 'set']), 'box', false],
    ['a verb this version does not know', bundle(['box', 'patch']), 'box', false],
    ['no row at all', bundle(), 'box', false],
  ] as const)('%s: %s', (_name, commitBundle, key, replaces) => {
    expect(replacesValue(commitBundle as never, key)).toBe(replaces);
  });

  it('one replacing row is enough, wherever it sits among the rows of the commit', () => {
    // The value after the commit rests on the commit alone: rows before the set are overwritten, rows
    // after it refine what the set wrote.
    expect(replacesValue(bundle(['box', 'merge'], ['box', 'set']) as never, 'box')).toBe(true);
    expect(replacesValue(bundle(['box', 'set'], ['box', 'merge'], [`box${D}a`, 'set']) as never, 'box')).toBe(true);
  });
});

describe('the rule: what a write was folded onto (commit by commit)', () => {
  /** A log of bundles written by hand: [execution, ...rows on `k`]. No row: the commit did not write `k`. */
  const logOf = (...steps: Array<[id: string, ...verbs: string[]]>) =>
    steps.map(([id, ...verbs]) => ({ runtimeStageId: id, trace: verbs.map((verb) => ({ path: 'k', verb })) }));
  type Log = ReturnType<typeof logOf>;
  const writesOf = (log: Log) => log.flatMap((bundle, at) => (bundle.trace.length > 0 ? [at] : []));
  const under = (log: Log, at: number) =>
    builtOnBefore(
      'k',
      at,
      (position) => log[position] as never,
      (_key, before) => {
        for (let i = before - 1; i >= 0; i--) if (log[i].trace.length > 0) return i;
        return -1;
      },
    );
  const over = (log: Log, at: number) => builtDirectlyOn('k', at, writesOf(log), (position) => log[position] as never);

  it('nothing, when the write replaced the value', () => {
    expect(under(logOf(['a', 'set'], ['b', 'set']), 1)).toBeUndefined();
  });

  it('the last commit that wrote the key before it, when the write was partial', () => {
    expect(under(logOf(['a', 'set'], ['x'], ['b', 'merge']), 2)).toBe(0);
    expect(under(logOf(['a', 'set'], ['b', 'merge'], ['c', 'append']), 2)).toBe(1);
  });

  it('-1 when no commit before it wrote the key: it was folded onto the value from before the run', () => {
    expect(under(logOf(['x'], ['b', 'merge']), 1)).toBe(-1);
  });

  it('an earlier commit of the SAME step is the answer like any other: the rule knows nothing of steps', () => {
    // A mount commits and then commits its exit; a fork child commits again when the fan-out settles.
    // The later commit was folded onto the earlier one. (A reader whose nodes are steps passes through
    // it; that is the walk's business and is tested with the walk.)
    const log = logOf(['a', 'set'], ['m', 'merge'], ['m', 'merge']);
    expect(under(log, 2)).toBe(1);
    expect(under(log, 1)).toBe(0);
    expect(under(logOf(['a', 'set'], ['m', 'set'], ['m', 'merge']), 2)).toBe(1);
  });

  it('forward: the next write of the key, when it only added', () => {
    const log = logOf(['a', 'set'], ['x'], ['b', 'merge'], ['c', 'merge']);
    expect(over(log, 0)).toBe(2);
    expect(over(log, 2)).toBe(3);
    expect(over(log, 3)).toBeUndefined();
  });

  it('forward: none, when the next write replaced the value', () => {
    expect(over(logOf(['a', 'set'], ['b', 'set'], ['c', 'merge']), 0)).toBeUndefined();
  });

  it('forward: the next write only, never the one after it, and a later commit of its own step counts', () => {
    const log = logOf(['a', 'set'], ['a', 'merge'], ['b', 'merge']);
    expect(over(log, 0)).toBe(1);
    expect(over(log, 1)).toBe(2);
  });

  it('forward is the inverse of backward, for every log of up to six commits by three steps', () => {
    // Each commit: one of three steps, and it replaces `k`, adds to it, or leaves it alone. A step may
    // commit more than once and steps may interleave (a fork's children, a mount's two commits).
    const STEPS = ['a', 'b', 'c'];
    const ROWS: string[][] = [[], ['merge'], ['set']];
    let logs = 0;
    let pairs = 0;
    const grow = (log: Log): void => {
      if (log.length > 0) {
        logs++;
        const writes = writesOf(log);
        for (const lower of writes) {
          const built = over(log, lower);
          for (const upper of writes) {
            if (upper <= lower) continue;
            pairs++;
            const forward = built === upper;
            const backward = under(log, upper) === lower;
            if (forward !== backward) {
              throw new Error(
                `${JSON.stringify(log.map((b) => `${b.runtimeStageId}:${b.trace.map((r) => r.verb).join('+')}`))}: ` +
                  `was ${upper} folded onto ${lower}? forward says ${forward}, backward says ${backward}`,
              );
            }
          }
        }
      }
      if (log.length === 6) return;
      for (const step of STEPS) for (const rows of ROWS) grow([...log, ...logOf([step, ...rows])]);
    };
    grow([]);
    expect(logs).toBe(9 + 9 ** 2 + 9 ** 3 + 9 ** 4 + 9 ** 5 + 9 ** 6);
    expect(pairs).toBeGreaterThan(1_000_000);
  });
});

describe('the walk back through a value built in steps', () => {
  it('the finding: Use read a box and a list that Start wrote and Fill added to; the walk now holds Start', () => {
    const { log, state, reads } = builtInSteps();
    expect(state).toMatchObject({ box: { a: 1, b: 2 }, final: '[{"a":1,"b":2},["first","second"]]' });
    // Fill read nothing, and its rows did not replace: they were folded onto what Start left.
    expect(log[1].trace.map((row) => `${row.verb} ${row.path}`)).toEqual(['merge box', 'merge list']);

    const root = walk(log, 'use', reads);
    expect(flattenCausalDAG(root).map((node) => node.stageId)).toEqual(['use', 'fill', 'start']);
    expect(edgesOf(root)).toEqual([
      'use <- fill via box',
      'use <- fill via list',
      'fill <- start via box [built on]',
      'fill <- start via list [built on]',
    ]);
    // The mark is the registered code, on the edge no read made, and only there.
    const fill = root.parents[0];
    expect(fill.parentEdges.map((edge) => edge.builtOn)).toEqual(['partial-write', 'partial-write']);
    expect(root.parentEdges.map((edge) => edge.builtOn)).toEqual([undefined, undefined]);
  });

  it('follows one link per partial write, to the write that replaced the value and no further', () => {
    const w = world();
    writes(w, 'old', [[['k'], { v: 0 }, 'set']]);
    writes(w, 'a', [[['k'], { a: 1 }, 'set']]); // replaces: `old` is no part of the value any more
    writes(w, 'b', [[['k'], { b: 2 }, 'merge']]);
    writes(w, 'c', [[['k'], { c: 3 }, 'merge']]);
    const d = w.frame();
    d.read([], 'k');
    d.write(['out'], 1, 'set');
    commit(d, 'd');
    const root = walk(w.log.list(), 'd', { 'd#0': ['k'] });
    expect(edgesOf(root)).toEqual(['d <- c via k', 'c <- b via k [built on]', 'b <- a via k [built on]']);
    expect(flattenCausalDAG(root).map((node) => node.stageId)).not.toContain('old');
  });

  it('a row on a path inside the key is partial too: the edge keeps its nested-rows mark and the walk goes on', () => {
    const w = world();
    writes(w, 'start', [[['box'], { a: 1, deep: { x: 1 } }, 'set']]);
    writes(w, 'inner', [[['box', 'deep', 'x'], 2, 'set']]);
    const use = w.frame();
    use.read([], 'box');
    use.write(['out'], 1, 'set');
    commit(use, 'use');
    const root = walk(w.log.list(), 'use', { 'use#0': ['box'] });
    expect(edgesOf(root)).toEqual(['use <- inner via box [nested-rows]', 'inner <- start via box [built on]']);
  });

  it('a step that READ the key before it merged into it keeps its one edge: no second one is added', () => {
    // The common shape (`scope.list.push(x)`, `scope.box.a = 1`): the step's read already carries the
    // walk to the earlier writer, so such a record answers exactly as before.
    const w = world();
    writes(w, 'start', [[['box'], { a: 1 }, 'set']]);
    const fill = w.frame();
    fill.read([], 'box');
    fill.write(['box'], { b: 2 }, 'merge');
    commit(fill, 'fill');
    const use = w.frame();
    use.read([], 'box');
    use.write(['out'], 1, 'set');
    commit(use, 'use');
    const root = walk(w.log.list(), 'use', { 'use#0': ['box'], 'fill#0': ['box'] });
    expect(edgesOf(root)).toEqual(['use <- fill via box', 'fill <- start via box']);
  });

  it('steps side by side: what the step read and what its write was folded onto can be two different commits', () => {
    // Fill reads the box as Start left it. While Fill runs, Other replaces the box and commits. Fill
    // then merges into the box: its commit is folded onto OTHER's value, not onto the one it read.
    const w = world();
    writes(w, 'start', [[['box'], { a: 1 }, 'set']]);
    const fill = w.frame();
    fill.read([], 'box');
    writes(w, 'other', [[['box'], { o: 1 }, 'set']]);
    fill.write(['box'], { b: 2 }, 'merge');
    commit(fill, 'fill');
    expect(w.state.getState().box).toEqual({ o: 1, b: 2 });
    const use = w.frame();
    use.read([], 'box');
    use.write(['out'], 1, 'set');
    commit(use, 'use');
    const root = walk(w.log.list(), 'use', { 'use#0': ['box'], 'fill#0': ['box'] });
    // A read is dated where the step looked at state (Start); a fold happens in commit order (Other).
    expect(edgesOf(root).sort()).toEqual(
      ['fill <- other via box [built on]', 'fill <- start via box', 'use <- fill via box'].sort(),
    );
  });

  it('steps side by side, and the step looked again: a possible read of the sibling does not stand in for the certain link', () => {
    // Fill looks at the box, Other replaces it and commits, Fill looks at live state again and
    // merges. The record holds Fill's window, not the moment of each look, so which value Fill READ
    // has two possible sources. What its merge was FOLDED ONTO is known for certain: Other's value,
    // the last one before Fill's commit.
    const w = world();
    writes(w, 'start', [[['box'], { a: 1 }, 'set']]);
    const fill = w.frame(['runs', 'fill']);
    fill.read([], 'box');
    writes(w, 'other', [[['box'], { o: 1 }, 'set']]);
    fill.read([], 'box');
    fill.write(['box'], { b: 2 }, 'merge');
    commit(fill, 'fill');
    expect(w.log.list()[2]).toMatchObject({ beganAt: 1, sawUntil: 2 });
    const use = w.frame();
    use.read([], 'box');
    use.write(['out'], 1, 'set');
    commit(use, 'use');
    const root = walk(w.log.list(), 'use', { 'use#0': ['box'], 'fill#0': ['box'] });
    expect(edgesOf(root).sort()).toEqual(
      [
        'fill <- other via box (written-while-running)',
        'fill <- other via box [built on]',
        'fill <- start via box (replaced-while-running)',
        'use <- fill via box',
      ].sort(),
    );
  });

  it('the order the walk meets a read and a link in does not change the answer: one edge, the read', () => {
    // X merges into `k`, THEN reads `k`, then writes `k2`. Under per-write attribution the read feeds
    // only `k2`. A reader of both keys reaches X twice: through `k` (the link under X's merge) and
    // through `k2` (X's read of `k`). Both lead to P for `k`; one edge says it, whichever comes first.
    const w = world();
    const p = w.frame();
    p.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
    p.write(['k'], { a: 1 }, 'set');
    commit(p, 'p');
    const x = w.frame();
    x.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
    x.write(['k'], { b: 2 }, 'merge');
    x.read([], 'k');
    x.noteRead([], 'k');
    x.write(['k2'], 1, 'set');
    commit(x, 'x');
    const log = w.log.list();
    expect(log[1].trace.map((row) => `${row.verb} ${row.path} after ${JSON.stringify(row.readKeys)}`)).toEqual([
      'merge k after []',
      'set k2 after ["k"]',
    ]);
    const reader = w.frame();
    reader.read([], 'k');
    reader.read([], 'k2');
    reader.write(['out'], 1, 'set');
    commit(reader, 'r');
    const walked = (order: string[]) =>
      edgesOf(walk(w.log.list(), 'r', { 'r#0': order, 'x#0': ['k'] }, { edgeAttribution: 'per-write' })).sort();
    const linkFirst = walked(['k', 'k2']);
    const readFirst = walked(['k2', 'k']);
    expect(linkFirst).toEqual(['r <- x via k', 'r <- x via k2', 'x <- p via k'].sort());
    expect(readFirst).toEqual(linkFirst);
  });

  it('a first write that is a merge was folded onto the value from before the run: the node says so', () => {
    const w = world({ box: { seeded: true } });
    writes(w, 'fill', [[['box'], { b: 2 }, 'merge']]);
    const use = w.frame();
    use.read([], 'box');
    use.write(['out'], 1, 'set');
    commit(use, 'use');
    const root = walk(w.log.list(), 'use', { 'use#0': ['box'] });
    expect(edgesOf(root)).toEqual(['use <- fill via box']);
    const fill = root.parents[0];
    expect(fill.preRunBase).toEqual({ code: 'from-initial-state', keys: ['box'] });
    // Use read a value some commit wrote, so it has no pre-run read of its own.
    expect(root.preRunReads).toBeUndefined();
    expect(root.preRunBase).toBeUndefined();
  });

  it('two bundles of one step: the walk passes through its own earlier write to what that was built on', () => {
    const w = world();
    writes(w, 'start', [[['list'], ['a'], 'set']]);
    const first = w.frame();
    first.write(['list'], ['b'], 'merge');
    commit(first, 'mount');
    const exit = w.frame();
    exit.write(['list'], ['c'], 'merge');
    commit(exit, 'mount', 'exit');
    const use = w.frame();
    use.read([], 'list');
    use.write(['out'], 1, 'set');
    commit(use, 'use');
    const root = walk(w.log.list(), 'use', { 'use#0': ['list'] });
    expect(edgesOf(root)).toEqual(['use <- mount via list', 'mount <- start via list [built on]']);
  });

  it('a step whose own earlier commit REPLACED the value: the walk ends at that step, nothing older is in it', () => {
    const w = world();
    writes(w, 'start', [[['list'], ['a'], 'set']]);
    const first = w.frame();
    first.write(['list'], ['fresh'], 'set');
    commit(first, 'mount');
    const exit = w.frame();
    exit.write(['list'], ['more'], 'merge');
    commit(exit, 'mount', 'exit');
    const use = w.frame();
    use.read([], 'list');
    use.write(['out'], 1, 'set');
    commit(use, 'use');
    expect(w.state.getState().list).toEqual(['fresh', 'more']);
    const root = walk(w.log.list(), 'use', { 'use#0': ['list'] });
    expect(edgesOf(root)).toEqual(['use <- mount via list']);
    expect(root.parents[0].preRunBase).toBeUndefined();
  });

  it('two steps whose commits interleave on one key rest on each other: an edge each way, and every helper ends', () => {
    // A adds to `k`, B adds to `k`, A adds to `k` again (its second commit). What A left rests on B's
    // write, and B's write rests on A's first. At the level of steps that is a cycle of two, and it is
    // what the record says. The cause graph, whose nodes are commits, has no cycle here.
    const w = world({ k: { seeded: 1 } });
    const a1 = w.frame();
    a1.write(['k'], { a1: 1 }, 'merge');
    commit(a1, 'a');
    writes(w, 'b', [[['k'], { b: 1 }, 'merge']]);
    const a2 = w.frame();
    a2.write(['k'], { a2: 1 }, 'merge');
    commit(a2, 'a', 'repeat');
    const use = w.frame();
    use.read([], 'k');
    use.write(['out'], 1, 'set');
    commit(use, 'use');
    expect(w.state.getState().k).toEqual({ seeded: 1, a1: 1, b: 1, a2: 1 });
    const log = w.log.list();
    const root = walk(log, 'use', { 'use#0': ['k'] });
    expect(edgesOf(root).sort()).toEqual(
      ['a <- b via k [built on]', 'b <- a via k [built on]', 'use <- a via k'].sort(),
    );
    // A's FIRST commit was folded onto the value from before the run, and the walk came to it.
    expect(root.parents[0].preRunBase).toEqual({ code: 'from-initial-state', keys: ['k'] });
    // Each helper visits a node once.
    expect(flattenCausalDAG(root).map((node) => node.stageId)).toEqual(['use', 'a', 'b']);
    expect(formatCausalChain(root).split('\n')).toEqual([
      'use (use#0) [wrote: out]',
      '  a (a#0) ← via k [wrote: k]',
      '    b (b#0) ← built on k [wrote: k]',
      '      ↳ a#0 (see above)',
    ]);
    const json = sliceToJSON(sliceForKey(log, 'out', keysReadFromMap({ 'use#0': ['k'] })));
    expect(
      (json.edges ?? []).map((edge) => `${edge.from} -> ${edge.to}${edge.builtOn ? ' built on' : ''}`).sort(),
    ).toEqual(['a#0 -> b#0 built on', 'b#0 -> a#0 built on', 'use#0 -> a#0'].sort());
    expect(Object.keys(json.nodes ?? {}).sort()).toEqual(['a#0', 'b#0', 'use#0']);
  });

  it('a chain longer than the depth budget is cut, and the root says so', () => {
    const w = world();
    writes(w, 's0', [[['k'], { n: 0 }, 'set']]);
    for (let i = 1; i <= 6; i++) writes(w, `s${i}`, [[['k'], { [`f${i}`]: i }, 'merge']]);
    const use = w.frame();
    use.read([], 'k');
    use.write(['out'], 1, 'set');
    commit(use, 'use');
    const whole = walk(w.log.list(), 'use', { 'use#0': ['k'] });
    expect(flattenCausalDAG(whole).map((node) => node.stageId)).toEqual([
      'use',
      's6',
      's5',
      's4',
      's3',
      's2',
      's1',
      's0',
    ]);
    expect(whole.truncated).toBeUndefined();
    const cut = walk(w.log.list(), 'use', { 'use#0': ['k'] }, { maxDepth: 3 });
    expect(flattenCausalDAG(cut).map((node) => node.stageId)).toEqual(['use', 's6', 's5', 's4']);
    expect(cut.truncated).toEqual({ byDepth: true, byNodes: false });
    const few = walk(w.log.list(), 'use', { 'use#0': ['k'] }, { maxNodes: 3 });
    expect(flattenCausalDAG(few).map((node) => node.stageId)).toEqual(['use', 's6', 's5']);
    expect(few.truncated).toEqual({ byDepth: false, byNodes: true });
    // A budget that ends exactly at the write that REPLACED the value cuts nothing: that step has no
    // link left to follow, so the walk is whole and does not say otherwise.
    const exact = walk(w.log.list(), 'use', { 'use#0': ['k'] }, { maxDepth: 7 });
    expect(flattenCausalDAG(exact).map((node) => node.stageId)).toHaveLength(8);
    expect(exact.truncated).toBeUndefined();
  });

  it('under per-write attribution the link is followed too, beside the reads that fed the write', () => {
    const w = world();
    const start = w.frame();
    start.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
    start.write(['box'], { a: 1 }, 'set');
    start.write(['seedOnly'], 1, 'set');
    commit(start, 'start');
    const fill = w.frame();
    fill.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
    fill.read([], 'seedOnly');
    fill.noteRead([], 'seedOnly');
    fill.write(['box'], { b: 2 }, 'merge');
    commit(fill, 'fill');
    const use = w.frame();
    use.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
    use.read([], 'box');
    use.noteRead([], 'box');
    use.write(['out'], 1, 'set');
    commit(use, 'use');
    const root = walk(
      w.log.list(),
      'use',
      { 'use#0': ['box'], 'fill#0': ['seedOnly'] },
      { edgeAttribution: 'per-write', rootLinkKeys: ['out'] },
    );
    expect(edgesOf(root).sort()).toEqual(
      ['fill <- start via box [built on]', 'fill <- start via seedOnly', 'use <- fill via box'].sort(),
    );
  });
});

describe('a slice for a key whose last write did not replace it', () => {
  it('the root is the last writer, and its write is followed to what it was built on', () => {
    const { log, reads } = builtInSteps();
    const slice = sliceForKey(log, 'box', keysReadFromMap(reads).lookup);
    expect(slice.writer?.stageId).toBe('fill');
    expect(edgesOf(slice.root!)).toEqual(['fill <- start via box [built on]']);
    const json = sliceToJSON(slice);
    expect(json.edges).toEqual([
      { from: 'fill#0', to: 'start#0', kind: 'data', key: 'box', weight: 1, builtOn: 'partial-write' },
    ]);
    expect(formatCausalChain(slice.root!)).toBe(
      ['fill (fill#0) [wrote: box, list]', '  start (start#0) ← built on box [wrote: box, list]'].join('\n'),
    );
  });

  it('a slice for a key the root replaced has no such edge, whatever else the root merged', () => {
    const { log, reads } = builtInSteps();
    const slice = sliceForKey(log, 'final', keysReadFromMap(reads).lookup);
    expect(slice.writer?.stageId).toBe('use');
    expect(slice.root!.parentEdges.map((edge) => edge.builtOn)).toEqual([undefined, undefined]);
  });

  it('a first write that is a merge: the slice root says it rests on the value from before the run', () => {
    const w = world({ box: { seeded: true } });
    writes(w, 'fill', [[['box'], { b: 2 }, 'merge']]);
    const slice = sliceForKey(w.log.list(), 'box', keysReadFromMap({}).lookup);
    expect(slice.root!.preRunBase).toEqual({ code: 'from-initial-state', keys: ['box'] });
    expect(sliceToJSON(slice).nodes?.['fill#0'].preRunBase).toEqual({ code: 'from-initial-state', keys: ['box'] });
  });

  it("the plain walk from a step does not follow that step's own partial writes: nobody asked about them", () => {
    const { log, reads } = builtInSteps();
    const root = walk(log, 'fill', reads);
    expect(root.parentEdges).toEqual([]);
    expect(root.preRunBase).toBeUndefined();
  });
});

describe('the last writer the walk uses is the one the fold uses', () => {
  it('a partial write sits on the last write before its own commit', () => {
    const { log } = builtInSteps();
    expect(lastWriterPosition(log, 'box', 1)).toBe(0);
    expect(
      builtOnBefore(
        'box',
        1,
        (position) => log[position],
        (key, before) => lastWriterPosition(log, key, before),
      ),
    ).toBe(0);
  });
});

describe('forward: the life of a value does not end at a write that only added to it', () => {
  const lookup = (reads: Record<string, string[]>) => keysReadFromMap(reads).lookup;
  /** The moments of a timeline that has some (every timeline here does). */
  const momentsOf = (timeline: KeyTimeline): KeyMoment[] => timeline.moments ?? [];

  it('the finding, forward: what Start wrote is read by Use, although Fill wrote the key in between', () => {
    const { log, reads } = builtInSteps();
    // Anchored before Fill's commit: the value as Start left it.
    const slice = forwardSliceForKey(log, 'box', lookup(reads), { before: 1 });
    expect(slice.root?.commitIdx).toBe(0);
    // Fill's merge does not end the life: no later write replaced the box.
    expect(slice.root?.nextWriteIdx).toBeUndefined();
    expect(slice.root?.reads.map((read) => read.stageId)).toEqual(['use']);
    expect(slice.notes.map((note) => note.code)).toContain('partial-write');
    expect(slice.notes.find((note) => note.code === 'partial-write')?.detail).toContain(
      "'box' was merged into or appended to at commit 1",
    );
  });

  it('a write that replaces the value ends the life of everything before it', () => {
    const w = world();
    writes(w, 'a', [[['k'], { a: 1 }, 'set']]);
    writes(w, 'b', [[['k'], { b: 2 }, 'merge']]);
    writes(w, 'c', [[['k'], { c: 3 }, 'set']]);
    const use = w.frame();
    use.read([], 'k');
    use.write(['out'], 1, 'set');
    commit(use, 'use');
    const log = w.log.list();
    const reads = { 'use#0': ['k'] };
    const fromA = forwardSliceForKey(log, 'k', lookup(reads), { before: 1 });
    expect(fromA.root?.nextWriteIdx).toBe(2);
    expect(fromA.root?.reads).toEqual([]);
    const fromC = forwardSliceForKey(log, 'k', lookup(reads));
    expect(fromC.root?.commitIdx).toBe(2);
    expect(fromC.root?.reads.map((read) => read.stageId)).toEqual(['use']);
  });

  it('the timeline says it on the write: Fill was added to the value of commit 0, and the read names Fill', () => {
    const { log, reads } = builtInSteps();
    const timeline = keyTimeline(log, 'box', lookup(reads));
    expect(momentsOf(timeline).map((m) => `${m.kind}@${m.commitIdx}${m.verb ? ` ${m.verb}` : ''}`)).toEqual([
      'write@0 set',
      'write@1 merge',
      'read@2',
    ]);
    const [start, fill, read] = momentsOf(timeline);
    expect(start.builtOnWriteIdx).toBeUndefined();
    expect(start.builtOnPreRun).toBeUndefined();
    expect(fill.builtOnWriteIdx).toBe(0);
    expect(read.fromWriteIdx).toBe(1);
    expect(timeline.notes.map((note) => note.code)).toEqual(['partial-write']);
    const text = formatTimeline(timeline);
    expect(text).toContain('@1 write merge — fill (fill#0) (added to the value of commit 0)');
    expect(text).toContain('@2 read  — use (use#0) (value from commit 1)');
  });

  it('a write that replaced the value carries no link, and neither does a read of it', () => {
    const w = world();
    writes(w, 'a', [[['k'], { a: 1 }, 'set']]);
    writes(w, 'b', [[['k'], { b: 2 }, 'merge']]);
    writes(w, 'c', [[['k'], { c: 3 }, 'set']]);
    const use = w.frame();
    use.read([], 'k');
    use.write(['out'], 1, 'set');
    commit(use, 'use');
    const moments = momentsOf(keyTimeline(w.log.list(), 'k', lookup({ 'use#0': ['k'] })));
    expect(moments.map((m) => [m.kind, m.commitIdx, m.builtOnWriteIdx])).toEqual([
      ['write', 0, undefined],
      ['write', 1, 0],
      ['write', 2, undefined],
      ['read', 3, undefined],
    ]);
    expect(moments[3].fromWriteIdx).toBe(2);
  });

  it('a first write that only added says the value from before the run is under it, and the next one links to it', () => {
    const w = world({ k: { seeded: true } });
    writes(w, 'a', [[['k'], { a: 1 }, 'merge']]);
    writes(w, 'b', [[['k'], { b: 2 }, 'merge']]);
    const use = w.frame();
    use.read([], 'k');
    use.write(['out'], 1, 'set');
    commit(use, 'use');
    const timeline = keyTimeline(w.log.list(), 'k', lookup({ 'use#0': ['k'] }));
    const [a, b, read] = momentsOf(timeline);
    expect(a.builtOnPreRun).toBe(true);
    expect(a.builtOnWriteIdx).toBeUndefined();
    expect(b.builtOnWriteIdx).toBe(0);
    expect(b.builtOnPreRun).toBeUndefined();
    expect(read.fromWriteIdx).toBe(1);
    expect(timeline.notes.map((note) => note.code)).toEqual(['partial-write', 'from-initial-state']);
    // The note names the write it is said of: the first write of the key.
    expect(timeline.notes[1].detail).toBe(FOLDED_ON_PRE_RUN_WORDS('k', 0));
    expect(formatTimeline(timeline)).toContain('@0 write merge — a (a#0) (added to the value from BEFORE the run)');
  });

  it('a later set of the whole value does not make that note false: it speaks of ONE write, by its commit', () => {
    // A merges into the seeded `k`; C then sets `k`. The timeline holds a write of the whole value
    // (commit 1), so "no write of its whole value in range" would be false of it. What is true: the
    // write at commit 0 rests on the value from before the run. (The note said the first until the
    // second reader of the marked row asked what its words meant, round 4.)
    const w = world({ k: { seeded: true } });
    writes(w, 'a', [[['k'], { a: 1 }, 'merge']]);
    writes(w, 'c', [[['k'], { c: 3 }, 'set']]);
    const log = w.log.list();
    const timeline = keyTimeline(log, 'k', lookup({}));
    expect(momentsOf(timeline).map((m) => [m.commitIdx, m.verb, m.builtOnPreRun])).toEqual([
      [0, 'merge', true],
      [1, 'set', undefined],
    ]);
    expect(timeline.notes.filter((note) => note.code === 'from-initial-state')).toEqual([
      { code: 'from-initial-state', detail: FOLDED_ON_PRE_RUN_WORDS('k', 0) },
    ]);
    // A backward slice says the code of the VALUE at its point, in the words it always had. At the
    // end of this log the value is C's alone: no note. Just before C it is the merge on the seed.
    expect(sliceForKey(log, 'k', lookup({})).notes).toBeUndefined();
    expect(sliceForKey(log, 'k', lookup({}), { before: 1 }).notes).toEqual([
      {
        code: 'from-initial-state',
        detail:
          "'k' has no write of its whole value in range — its value rests on what it held before the run, " +
          'which the commit log cannot see, so the writes here may be only part of it.',
      },
    ]);
  });

  it('the link is by COMMIT: a step that committed twice has its later commit linked to its earlier one', () => {
    // A reader of the timeline works commit by commit. Had the link skipped the step's own earlier
    // commit, the later one would look like a whole value and commit 1 would never be named.
    const w = world();
    writes(w, 'start', [[['list'], ['a'], 'set']]);
    const first = w.frame();
    first.write(['list'], ['b'], 'merge');
    commit(first, 'mount');
    const exit = w.frame();
    exit.write(['list'], ['c'], 'merge');
    commit(exit, 'mount', 'exit');
    const use = w.frame();
    use.read([], 'list');
    use.write(['out'], 1, 'set');
    commit(use, 'use');
    const timeline = keyTimeline(w.log.list(), 'list', lookup({ 'use#0': ['list'] }));
    expect(momentsOf(timeline).map((m) => [m.kind, m.commitIdx, m.builtOnWriteIdx])).toEqual([
      ['write', 0, undefined],
      ['write', 1, 0],
      ['write', 2, 1],
      ['read', 3, undefined],
    ]);
    expect(formatTimeline(timeline)).toContain('@2 write merge — mount (mount#0) (added to the value of commit 1)');
  });

  it('the links stay one number per write, however many writes a read saw (a list appended to and read in a loop)', () => {
    const w = world();
    writes(w, 'start', [[['list'], [0], 'set']]);
    const reads: Record<string, string[]> = {};
    const rounds = 40;
    for (let round = 1; round <= rounds; round++) {
      const frame = w.frame();
      frame.write(['list'], [round], 'merge');
      frame.commit(() => ({ stage: 'add', stageId: 'add', runtimeStageId: `add#${round}` }));
      frame.release();
      const reader = w.frame();
      reader.read([], 'list');
      reader.write([`seen${round}`], round, 'set');
      reader.commit(() => ({ stage: 'look', stageId: 'look', runtimeStageId: `look#${round}` }));
      reader.release();
      reads[`look#${round}`] = ['list'];
    }
    const timeline = keyTimeline(w.log.list(), 'list', lookup(reads));
    const writesSeen = momentsOf(timeline).filter((m) => m.kind === 'write');
    const readsSeen = momentsOf(timeline).filter((m) => m.kind === 'read');
    expect(writesSeen).toHaveLength(rounds + 1);
    expect(readsSeen).toHaveLength(rounds);
    // Every added write links to the write just before it; following the links from any read reaches Start.
    expect(writesSeen.slice(1).map((m) => m.builtOnWriteIdx)).toEqual(writesSeen.slice(0, -1).map((m) => m.commitIdx));
    const byCommit = new Map(writesSeen.map((m) => [m.commitIdx, m]));
    let at = readsSeen[rounds - 1].fromWriteIdx;
    let hops = 0;
    while (at !== undefined && byCommit.get(at)?.builtOnWriteIdx !== undefined) {
      at = byCommit.get(at)!.builtOnWriteIdx;
      hops++;
    }
    expect(at).toBe(0);
    expect(hops).toBe(rounds);
    // The size of the answer grows with the moments, not with their square.
    expect(JSON.stringify(momentsOf(timeline)).length).toBeLessThan(260 * momentsOf(timeline).length);
  });

  it('backward and forward agree: every step the walk back names for a read is a writer whose life holds that read', () => {
    const { log, reads } = builtInSteps();
    const backward = flattenCausalDAG(walk(log, 'use', reads))
      .map((node) => node.stageId)
      .filter((id) => id !== 'use')
      .sort();
    const forward = [0, 1]
      .filter((at) =>
        forwardSliceForKey(log, 'box', lookup(reads), { before: at + 1 }).root?.reads.some(
          (read) => read.stageId === 'use',
        ),
      )
      .map((at) => log[at].stageId)
      .sort();
    expect(forward).toEqual(backward);
  });
});
