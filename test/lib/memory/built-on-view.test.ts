/**
 * A `set` row the WRITER made out of writes that only added, and the mark that says so.
 *
 * A step merges into `a` and also writes a path inside `a`. Under `commitValues: 'delta'` the two rows
 * share storage in the bundle, so the writer stores one `set` of the whole value. Under either
 * encoding, rows that would not fold back to what the step read are stored as `set` rows of what it
 * read (merge into `a.x`, delete `a.x`, merge into `a`). In both cases the row says `set` and still
 * holds what `a` held in the step's view. Read as a plain replacement, the walk back ended at that
 * step and left out every step whose write was still in the value.
 *
 * The writer now marks such a row (`TraceEntry.builtOnView`), dates it (the view's pin counts as a
 * look), and the readers take the mark as a read of the path, made for the step, at the commit that
 * carries the row (`memory/builtOn.ts · readFromView`).
 *
 * Test types: unit (which rows are marked, and which are not), scenario (the walk back, the forward
 * walk, the timeline, the cause graph), boundary (steps side by side, a step's later commit, the
 * start of the log), security (the doors that take records from outside keep the mark or refuse it).
 */
import { describe, expect, it } from 'vitest';

import {
  causalChain,
  flattenCausalDAG,
  formatForwardSlice,
  formatTimeline,
  forwardSliceForKey,
  keysReadFromMap,
  keyTimeline,
} from '../../../src';
import type { CausalNode, CommitBundle } from '../../../src';
import { createRecordGraph, explain } from '../../../src/cause';
import { isViewRow, readFromView, replacesValue } from '../../../src/lib/memory/builtOn';
import { EventLog, RecordFrame, SharedMemory } from '../../../src/write';

type Encoding = 'full' | 'delta';
const D = '\u001f';

function world(encoding: Encoding, seed: Record<string, unknown> = {}) {
  const state = new SharedMemory(undefined, structuredClone(seed));
  const log = new EventLog(structuredClone(seed));
  const frame = (address: string[] = []) => {
    const made = new RecordFrame(state, log, address);
    made.useEncoding({ commitValues: encoding, writeProvenance: 'off' });
    return made;
  };
  return { state, log, frame };
}
function commit(frame: RecordFrame, id: string, phase?: 'exit'): void {
  frame.commit(() => ({ stage: id, stageId: id, runtimeStageId: `${id}#0`, ...(phase && { phase }) }));
  frame.release();
}
const rowsOf = (bundle: CommitBundle) =>
  bundle.trace.map((row) => `${row.verb} ${row.path.split(D).join('.')}${row.builtOnView ? ' (built on view)' : ''}`);
const edgesOf = (root: CausalNode) =>
  flattenCausalDAG(root).flatMap((node) =>
    node.parentEdges.map(
      (edge) =>
        `${node.stageId} <- ${edge.parent.stageId} via ${edge.key}` +
        (edge.builtOn ? ` [${edge.builtOn}]` : '') +
        (edge.overlap ? ` (${edge.overlap})` : ''),
    ),
  );
const walk = (log: CommitBundle[], id: string, reads: Record<string, string[]>) =>
  causalChain(log, `${id}#0`, keysReadFromMap(reads).lookup)!;

/** Start sets `a`. Fill merges into `a` and writes a path inside it, reading nothing. Use reads `a`. */
function mergedAndInside(encoding: Encoding) {
  const w = world(encoding);
  const start = w.frame();
  start.write(['a'], { s: 1 }, 'set');
  commit(start, 'start');
  const fill = w.frame();
  fill.write(['a'], { m: 1 }, 'merge');
  fill.write(['a', 'in'], 1, 'set');
  commit(fill, 'fill');
  const use = w.frame();
  use.read([], 'a');
  use.write(['out'], 1, 'set');
  commit(use, 'use');
  return { ...w, list: w.log.list(), reads: { 'use#0': ['a'] } };
}

describe('which rows the writer marks', () => {
  it("delta: a merge of a key and a write inside it are one set of the whole value, marked; the inner set is the step's own", () => {
    const { list, state } = mergedAndInside('delta');
    expect(state.getState().a).toEqual({ s: 1, m: 1, in: 1 });
    expect(rowsOf(list[1])).toEqual(['set a.in', 'set a (built on view)']);
    // Nothing was committed between Fill's first touch of state and its commit: its view was the state
    // just before the commit, which is what a reader takes a bundle with no stamp to say.
    expect(list[1].viewAt).toBeUndefined();
  });

  it('full: the same step keeps its verbs, and nothing is marked', () => {
    const { list } = mergedAndInside('full');
    expect(rowsOf(list[1])).toEqual(['merge a', 'set a.in']);
  });

  it.each(['full', 'delta'] as const)(
    '%s: a step that SET the key itself is not marked, whatever else it wrote under it',
    (encoding) => {
      const w = world(encoding, { a: { old: 1 } });
      const step = w.frame();
      step.write(['a'], { fresh: 1 }, 'set');
      step.write(['a'], { more: 1 }, 'merge');
      step.write(['a', 'in'], 1, 'set');
      commit(step, 'step');
      expect(w.state.getState().a).toEqual({ fresh: 1, more: 1, in: 1 });
      expect(w.log.list()[0].trace.some((row) => row.builtOnView)).toBe(false);
    },
  );

  it('full, the default: rows that would not fold back are stored as what the step read; the set of `a` is marked', () => {
    // Merge into a.x, delete a.x, merge into a. The step deleted `a.x` itself; it never replaced `a`.
    const w = world('full', { a: { old: 1, x: { deep: 1 } } });
    const step = w.frame();
    step.write(['a', 'x'], { t: 1 }, 'merge');
    step.write(['a', 'x'], undefined, 'delete');
    step.write(['a'], { m: 1 }, 'merge');
    commit(step, 'step');
    expect(w.state.getState().a).toEqual({ old: 1, m: 1 });
    expect(rowsOf(w.log.list()[0])).toEqual(['set a.x', 'set a (built on view)']);
  });

  it('full: every row of such a family that the step did not replace itself is marked, not only its top one', () => {
    // The step merged into a.y and into a, and it replaced a.x itself (it deleted it on the way). All
    // three rows are stored as what the step read. The two it only added to hold what the view held.
    const w = world('full', { a: { old: 1, x: { deep: 1 }, y: { was: 1 } } });
    const step = w.frame();
    step.write(['a', 'y'], { q: 1 }, 'merge');
    step.write(['a', 'x'], { t: 1 }, 'merge');
    step.write(['a', 'x'], undefined, 'delete');
    step.write(['a', 'x'], { u: 1 }, 'merge');
    step.write(['a'], { m: 1 }, 'merge');
    commit(step, 'step');
    expect(w.state.getState().a).toEqual({ old: 1, x: { u: 1 }, y: { was: 1, q: 1 }, m: 1 });
    expect(rowsOf(w.log.list()[0])).toEqual(['set a.y (built on view)', 'set a.x', 'set a (built on view)']);
  });

  it('merges of a list that would not fold back: a set of what was read, marked; under delta the compact append, which needs no mark', () => {
    const rows = (encoding: Encoding) => {
      const w = world(encoding, { list: [{ id: 1 }] });
      const step = w.frame();
      step.write(['list'], [{ id: 2 }], 'merge');
      step.write(['list'], [], 'merge');
      step.write(['list'], [{ id: 1 }, { id: 3 }], 'merge');
      commit(step, 'step');
      expect(w.state.getState().list).toEqual([{ id: 1 }, { id: 3 }]);
      return rowsOf(w.log.list()[0]);
    };
    expect(rows('full')).toEqual(['set list (built on view)']);
    // An `append` says by its verb that it added to what was there. The mark is for a `set` only.
    expect(rows('delta')).toEqual(['append list']);
  });

  it('delta: a list that only grew is an append, which says by its verb that it added: no mark', () => {
    const w = world('delta', { list: ['a'] });
    const step = w.frame();
    step.write(['list'], ['a', 'b'], 'set');
    commit(step, 'step');
    expect(rowsOf(w.log.list()[0])).toEqual(['append list']);
  });

  it('the rule reads the mark: the row replaces the value in the fold, and it read the path from the view', () => {
    const { list } = mergedAndInside('delta');
    expect(replacesValue(list[1], 'a')).toBe(true);
    expect(readFromView(list[1], 'a')).toBe(true);
    // Asked about a path inside the key or a container around it: the row holds that part of the view too.
    expect(readFromView(list[1], `a${D}s`)).toBe(true);
    expect(readFromView(list[1], 'other')).toBe(false);
    expect(readFromView(list[0], 'a')).toBe(false);
    // The mark counts on a `set` row only: on another verb it says nothing the fold does not say already.
    expect(list[1].trace.map(isViewRow)).toEqual([false, true]);
    expect(isViewRow({ verb: 'merge', builtOnView: true })).toBe(false);
  });
});

describe('the walk back through a row the writer built on the view', () => {
  it('delta: Use read a value that Start and Fill made; the walk holds both (it used to end at Fill)', () => {
    const { list, reads } = mergedAndInside('delta');
    expect(edgesOf(walk(list, 'use', reads))).toEqual(['use <- fill via a', 'fill <- start via a [built-on-view]']);
  });

  it('full: the same run is answered through the fold, with the same steps', () => {
    const { list, reads } = mergedAndInside('full');
    expect(edgesOf(walk(list, 'use', reads))).toEqual(['use <- fill via a', 'fill <- start via a [partial-write]']);
  });

  it('at the start of the log the view held the value from before the run, and the node says so', () => {
    const w = world('delta', { a: { seeded: 1 } });
    const fill = w.frame();
    fill.write(['a'], { m: 1 }, 'merge');
    fill.write(['a', 'in'], 1, 'set');
    commit(fill, 'fill');
    const use = w.frame();
    use.read([], 'a');
    use.write(['out'], 1, 'set');
    commit(use, 'use');
    const root = walk(w.log.list(), 'use', { 'use#0': ['a'] });
    expect(edgesOf(root)).toEqual(['use <- fill via a']);
    expect(root.parents[0].preRunBase).toEqual({ code: 'from-initial-state', keys: ['a'] });
  });

  it('steps side by side: the row holds what the VIEW held, not what a sibling committed since', () => {
    // Fill begins (its first write pins its view). Other replaces `a` and commits. Fill commits its row,
    // which was built on the view from before Other: in the fold it replaces what Other wrote.
    const w = world('delta');
    const start = w.frame();
    start.write(['a'], { s: 1 }, 'set');
    commit(start, 'start');
    const fill = w.frame();
    fill.write(['a'], { m: 1 }, 'merge');
    const other = w.frame();
    other.write(['a'], { o: 1 }, 'set');
    commit(other, 'other');
    fill.write(['a', 'in'], 1, 'set');
    commit(fill, 'fill');
    expect(w.state.getState().a).toEqual({ s: 1, m: 1, in: 1 });
    const list = w.log.list();
    // The commit says when its view was pinned. Fill read nothing itself, so it has no read stamps.
    expect(list[2]).toMatchObject({ runtimeStageId: 'fill#0', viewAt: 1 });
    expect([list[2].beganAt, list[2].sawUntil]).toEqual([undefined, undefined]);
    // Start's commit and Other's carry no stamp at all: nothing landed between their view and their commit.
    expect(list.slice(0, 2).map((bundle) => bundle.viewAt)).toEqual([undefined, undefined]);
    const use = w.frame();
    use.read([], 'a');
    use.write(['out'], 1, 'set');
    commit(use, 'use');
    const root = walk(w.log.list(), 'use', { 'use#0': ['a'] });
    // Start, for certain. Other is NOT a source: nothing of what it wrote is in the value.
    expect(edgesOf(root)).toEqual(['use <- fill via a', 'fill <- start via a [built-on-view]']);
  });

  it('a step that pinned its view by a write and read live state later: the row has ONE source, and the read keeps its own date', () => {
    // Fill's first write pins its view (the log holds one commit). Other replaces `a` and writes `flag`.
    // Fill then reads `flag`, which its view does not hold: a look at state as it stands now. The row
    // was built on the pinned view, and the commit says when that was (`viewAt`), apart from when
    // Fill's code read. So the row has one certain source, and so has the read. (Dated by one pair of
    // stamps, as the first form of this change did, both answers became "possible": Start or Other.)
    const w = world('delta');
    const start = w.frame();
    start.write(['a'], { s: 1 }, 'set');
    commit(start, 'start');
    const fill = w.frame();
    fill.write(['a'], { m: 1 }, 'merge');
    const other = w.frame();
    other.write(['a'], { o: 1 }, 'set');
    other.write(['flag'], 1, 'set');
    commit(other, 'other');
    expect(fill.read([], 'flag')).toBe(1);
    fill.write(['a', 'in'], 1, 'set');
    commit(fill, 'fill');
    expect(w.state.getState().a).toEqual({ s: 1, m: 1, in: 1 });
    const list = w.log.list();
    // The read saw state just before the commit: no read stamp. The view was pinned one commit earlier.
    expect(list[2]).toMatchObject({ runtimeStageId: 'fill#0', viewAt: 1 });
    expect([list[2].beganAt, list[2].sawUntil]).toEqual([undefined, undefined]);
    const use = w.frame();
    use.read([], 'a');
    use.write(['out'], 1, 'set');
    commit(use, 'use');
    const all = w.log.list();
    expect(edgesOf(walk(all, 'use', { 'use#0': ['a'], 'fill#0': ['flag'] })).sort()).toEqual(
      ['use <- fill via a', 'fill <- start via a [built-on-view]', 'fill <- other via flag'].sort(),
    );
    const timeline = keyTimeline(all, 'a', keysReadFromMap({ 'use#0': ['a'] }).lookup);
    const writes = (timeline.moments ?? []).filter((moment) => moment.kind === 'write');
    expect(writes.map((moment) => [moment.commitIdx, moment.builtOnWriteIdx, moment.builtOnViewIdxs])).toEqual([
      [0, undefined, undefined],
      [1, undefined, undefined],
      [2, 0, undefined],
    ]);
    expect(formatTimeline(timeline)).toContain('@2 write set — fill (fill#0) (added to the value of commit 0)');
  });

  it('an array that does not show where the view sits: each write it could have held is a possible source', () => {
    // A record handed over with one bundle that says no index, in a hole of the indices (10, ?, 13).
    // Fill's view was pinned when the log held 12 commits. The bundle with no index sits at 11 or at
    // 12: inside the view, or not. The reader cannot know, names both writes, and calls neither certain.
    const row = (path: string, extra: object = {}) => ({ path, verb: 'set' as const, ...extra });
    const bundle = (id: string, idx: number | undefined, trace: CommitBundle['trace'], extra: object = {}) =>
      ({
        ...(idx !== undefined && { idx }),
        stage: id,
        stageId: id,
        runtimeStageId: `${id}#0`,
        trace,
        redactedPaths: [],
        overwrite: Object.fromEntries(trace.map((entry) => [entry.path, 1])),
        updates: {},
        ...extra,
      } as CommitBundle);
    const log = [
      bundle('start', 10, [row('a')]),
      bundle('other', undefined, [row('a')]),
      bundle('fill', 13, [row('a', { builtOnView: true })], { viewAt: 12 }),
      bundle('use', 14, [row('out')]),
    ];
    expect(edgesOf(walk(log, 'use', { 'use#0': ['a'] })).sort()).toEqual(
      [
        'use <- fill via a',
        'fill <- start via a [built-on-view] (replaced-while-running)',
        'fill <- other via a [built-on-view] (written-while-running)',
      ].sort(),
    );
    // The timeline says it on the write: one number cannot, so it lists the writes the view could have held.
    const timeline = keyTimeline(log, 'a', keysReadFromMap({ 'use#0': ['a'] }).lookup);
    const writes = (timeline.moments ?? []).filter((moment) => moment.kind === 'write');
    expect(writes.map((moment) => [moment.commitIdx, moment.builtOnWriteIdx, moment.builtOnViewIdxs])).toEqual([
      [0, undefined, undefined],
      [1, undefined, undefined],
      [2, undefined, [0, 1]],
    ]);
    expect(formatTimeline(timeline)).toContain(
      "@2 write set — fill (fill#0) (built on the value its step's view held: commit 0 or 1)",
    );
    // With the index said, the same record has one answer.
    const said = [log[0], { ...log[1], idx: 12 }, log[2], log[3]];
    expect(edgesOf(walk(said, 'use', { 'use#0': ['a'] }))).toEqual([
      'use <- fill via a',
      'fill <- start via a [built-on-view]',
    ]);
  });

  it('where the fold and the view name one parent there is one edge, and it says the fold', () => {
    // A row INSIDE the key that the writer built on the view. The key was not replaced, so the fold
    // names the write before it; the row holds what the view held, so the view names that write too.
    // One edge, and the same word whichever of the two the walk meets first.
    const row = (path: string, extra: object = {}) => ({ path, verb: 'set' as const, ...extra });
    const bundle = (id: string, idx: number, trace: CommitBundle['trace']): CommitBundle => ({
      idx,
      stage: id,
      stageId: id,
      runtimeStageId: `${id}#0`,
      trace,
      redactedPaths: [],
      overwrite: Object.fromEntries(trace.map((entry) => [entry.path, idx])),
      updates: {},
    });
    const log = [
      bundle('start', 0, [row('a')]),
      bundle('fill', 1, [row(`a${D}x`, { builtOnView: true })]),
      bundle('use', 2, [row('out')]),
    ];
    expect(edgesOf(walk(log, 'use', { 'use#0': ['a'] }))).toEqual([
      'use <- fill via a',
      'fill <- start via a [partial-write]',
    ]);
  });

  it("a step that only merged (no row of the writer's) is not dated: its bytes are what they were", () => {
    const w = world('delta');
    const start = w.frame();
    start.write(['a'], { s: 1 }, 'set');
    commit(start, 'start');
    const fill = w.frame();
    fill.write(['a'], { m: 1 }, 'merge');
    const other = w.frame();
    other.write(['b'], 1, 'set');
    commit(other, 'other');
    commit(fill, 'fill');
    const bundle = w.log.list()[2];
    expect(rowsOf(bundle)).toEqual(['merge a']);
    expect([bundle.beganAt, bundle.viewAt]).toEqual([undefined, undefined]);
  });

  it("a step's LATER commit has a view of its own: a write between its two commits is under the row, and is named", () => {
    // S commits. T adds to `a`. S commits again (a continuation) with a row built on the view it pinned
    // after T. What T wrote is in the value. Dated with S's first commit, T would be left out.
    const w = world('delta');
    const first = w.frame();
    first.write(['a'], { s1: 1 }, 'set');
    commit(first, 's');
    const t = w.frame();
    t.write(['a'], { t: 1 }, 'merge');
    commit(t, 't');
    const later = w.frame();
    later.write(['a'], { s2: 1 }, 'merge');
    later.write(['a', 'in'], 1, 'set');
    commit(later, 's', 'exit');
    expect(w.state.getState().a).toEqual({ s1: 1, t: 1, s2: 1, in: 1 });
    expect(rowsOf(w.log.list()[2])).toEqual(['set a.in', 'set a (built on view)']);
    const use = w.frame();
    use.read([], 'a');
    use.write(['out'], 1, 'set');
    commit(use, 'use');
    const root = walk(w.log.list(), 'use', { 'use#0': ['a'] });
    expect(edgesOf(root).sort()).toEqual(
      ['s <- t via a [built-on-view]', 't <- s via a [partial-write]', 'use <- s via a'].sort(),
    );
  });
});

describe('forward, the timeline and the cause graph', () => {
  it("forward: the way from Start's write reaches Use through the row Fill's commit holds", () => {
    const { list, reads } = mergedAndInside('delta');
    const slice = forwardSliceForKey(list, 'a', keysReadFromMap(reads).lookup, { before: 1 });
    expect(slice.root?.commitIdx).toBe(0);
    // In the fold Fill's `set` ends the life of Start's write. Fill's commit holds it in that row (no
    // code of Fill read it: the read is marked), and the row's own life holds Use.
    expect(slice.root?.nextWriteIdx).toBe(1);
    expect(slice.root?.reads).toEqual([
      { runtimeStageId: 'fill#0', stageId: 'fill', stageName: 'fill', commitIdx: 1, builtOnView: true },
    ]);
    // The value went into that row and into nothing else Fill wrote: one edge, exact, and it says why.
    expect(slice.root?.fedEdges.map((edge) => [edge.child.key, edge.basis])).toEqual([['a', 'built-on-view']]);
    const onward = slice.root?.fedEdges[0].child;
    expect(onward?.commitIdx).toBe(1);
    expect(onward?.reads.map((read) => [read.stageId, read.builtOnView])).toEqual([['use', undefined]]);
    expect(formatForwardSlice(slice)).toContain('held by fill (fill#0) @1 (in a row the writer built on its view)');
    expect(formatForwardSlice(slice)).toContain('→ fed [exact, built on the view]');
  });

  it('forward: only the row built on the view of THIS key is fed; another marked row of the commit is not', () => {
    // Fill merges into `a` and into `b`, and writes inside both: two rows the writer built on the view.
    const w = world('delta');
    const start = w.frame();
    start.write(['a'], { s: 1 }, 'set');
    start.write(['b'], { s: 1 }, 'set');
    commit(start, 'start');
    const fill = w.frame();
    fill.write(['a'], { m: 1 }, 'merge');
    fill.write(['a', 'in'], 1, 'set');
    fill.write(['b'], { m: 1 }, 'merge');
    fill.write(['b', 'in'], 1, 'set');
    commit(fill, 'fill');
    const list = w.log.list();
    expect(rowsOf(list[1]).filter((row) => row.endsWith('(built on view)'))).toEqual([
      'set a (built on view)',
      'set b (built on view)',
    ]);
    const slice = forwardSliceForKey(list, 'a', keysReadFromMap({}).lookup, { before: 1 });
    expect(slice.root?.fedEdges.map((edge) => [edge.child.key, edge.basis])).toEqual([['a', 'built-on-view']]);
  });

  it("forward: a step's later commit is a reader by ITS OWN view, pinned before a sibling replaced the key", () => {
    // S sets `a`. S's later commit starts (its first write pins its view). T replaces `a`. S's later
    // commit then lands with a row built on the view from before T: it holds what S first wrote, and
    // nothing of T's. Dated at its commit, it would be listed as holding T's value.
    const w = world('delta');
    const first = w.frame();
    first.write(['a'], { s1: 1 }, 'set');
    commit(first, 's');
    const later = w.frame();
    later.write(['a'], { s2: 1 }, 'merge');
    const t = w.frame();
    t.write(['a'], { t: 1 }, 'set');
    commit(t, 't');
    later.write(['a', 'in'], 1, 'set');
    commit(later, 's', 'exit');
    expect(w.state.getState().a).toEqual({ s1: 1, s2: 1, in: 1 });
    const list = w.log.list();
    expect(list[2]).toMatchObject({ runtimeStageId: 's#0', phase: 'exit', viewAt: 1 });
    expect(list[2].beganAt).toBeUndefined();
    const readersOf = (before: number) =>
      forwardSliceForKey(list, 'a', keysReadFromMap({}).lookup, { before }).root?.reads.map((read) => read.commitIdx);
    expect(readersOf(1)).toEqual([2]);
    expect(readersOf(2)).toEqual([]);
  });

  it('forward: a commit whose step possibly read a value and whose row certainly holds it is a certain reader', () => {
    // Fill read `a` and looked at state again after Other replaced it, so its READ of Start's value is
    // only possible. Its view was pinned before Other committed, so its ROW holds Start's value for
    // sure. Either way of reading is enough: the commit holds the value, for certain. Other's value is
    // not in the row, and Fill's code may have read it: a possible reader, by its read alone.
    const row = (path: string, extra: object = {}) => ({ path, verb: 'set' as const, ...extra });
    const bundle = (id: string, idx: number, trace: CommitBundle['trace'], extra: object = {}): CommitBundle => ({
      idx,
      stage: id,
      stageId: id,
      runtimeStageId: `${id}#0`,
      trace,
      redactedPaths: [],
      overwrite: Object.fromEntries(trace.map((entry) => [entry.path, idx])),
      updates: {},
      ...extra,
    });
    const log = [
      bundle('start', 0, [row('a')]),
      bundle('other', 1, [row('a')]),
      bundle('fill', 2, [row('a', { builtOnView: true })], { beganAt: 1, sawUntil: 2, viewAt: 1 }),
    ];
    const readersOf = (before: number) =>
      forwardSliceForKey(log, 'a', keysReadFromMap({ 'fill#0': ['a'] }).lookup, { before }).root?.reads.map((read) => [
        read.commitIdx,
        read.overlap,
        read.builtOnView,
      ]);
    expect(readersOf(1)).toEqual([[2, undefined, undefined]]);
    expect(readersOf(2)).toEqual([[2, 'written-while-running', undefined]]);
  });

  it('the timeline lists no read by Fill: its code read nothing, and reads were not recorded for it', () => {
    const { list } = mergedAndInside('delta');
    // No reads provider at all: a log with a marked row is still a log with no recorded reads.
    const timeline = keyTimeline(list, 'a', keysReadFromMap({}).lookup);
    expect((timeline.moments ?? []).map((moment) => [moment.kind, moment.commitIdx])).toEqual([
      ['write', 0],
      ['write', 1],
    ]);
    expect(timeline.notes.map((note) => note.code)).toContain('reads-not-recorded');
  });

  it('the timeline links the row to the write its view held', () => {
    const { list, reads } = mergedAndInside('delta');
    const timeline = keyTimeline(list, 'a', keysReadFromMap(reads).lookup);
    const writes = (timeline.moments ?? []).filter((moment) => moment.kind === 'write');
    expect(writes.map((moment) => [moment.commitIdx, moment.verb, moment.builtOnWriteIdx])).toEqual([
      [0, 'set', undefined],
      [1, 'set', 0],
    ]);
    expect(formatTimeline(timeline)).toContain('@1 write set — fill (fill#0) (added to the value of commit 0)');
  });

  it("the cause graph: Fill's node has Start's as parent, Start's has Fill's as child, and explain reaches a failure in Start", async () => {
    const { list, reads } = mergedAndInside('delta');
    const address = { logRunId: 'run', drillPath: [] };
    const ctx = () => ({ signal: new AbortController().signal });
    const failure = { kind: 'error', reason: 'ERROR_RECORDED', evidence: ['test:failure'] } as const;
    const g = createRecordGraph([
      {
        address,
        commitLog: list,
        reads: { 'start#0': [], 'fill#0': [], ...reads },
        attention: { 'start#0': [failure] },
        controlDeps: {},
        complete: true,
      } as never,
    ]);
    const node = (at: number, key: string) =>
      g.nodeId(address, { runtimeStageId: list[at].runtimeStageId, commitIdx: at, key });
    expect((await g.parents(node(1, 'a'), ctx())).edges.map((edge) => [edge.nodeId, edge.attribution])).toEqual([
      [node(0, 'a'), 'recorded-write'],
    ]);
    expect((await g.children(node(0, 'a'), ctx())).edges.map((edge) => edge.nodeId)).toContain(node(1, 'a'));
    const finding = await explain(g, node(2, 'out'), { includeBackward: true });
    // The marked step is reached, and it is the only candidate. The graph does not CONFIRM it: this
    // test's record carries no per-write reads, and Fill's commit also holds a row inside the key, both
    // of which the graph already called `conservative`. Without the mark the walk ended at Fill and
    // there was no candidate at all.
    expect(finding.rootCause).toBeUndefined();
    expect(finding.alternatives).toEqual([node(0, 'a')]);
    expect(finding.backward?.edges).toContainEqual({
      from: node(1, 'a'),
      to: node(0, 'a'),
      kind: 'data',
      attribution: 'recorded-write',
      evidence: ['commit:0'],
    });
  });
});

describe('a door that takes records from outside keeps the mark, or refuses it', () => {
  const address = { logRunId: 'run', drillPath: [] };
  const ctx = () => ({ signal: new AbortController().signal });
  const scopeOf = (list: unknown[]) => ({
    address,
    commitLog: list,
    reads: { 'start#0': [], 'fill#0': [], 'use#0': ['a'] },
    attention: {},
    controlDeps: {},
    complete: true,
  });
  const withRow = (list: CommitBundle[], row: Record<string, unknown>) =>
    list.map((bundle, at) =>
      at !== 1
        ? bundle
        : { ...bundle, trace: bundle.trace.map((entry) => (entry.path === 'a' ? { ...entry, ...row } : entry)) },
    );

  /** What the graph says about Fill's write of `a`: its parents, and the gaps (a refused record is one gap). */
  const ask = async (list: unknown[]) => {
    const g = createRecordGraph([scopeOf(list) as never]);
    const fill = g.nodeId(address, { runtimeStageId: 'fill#0', commitIdx: 1, key: 'a' });
    return {
      parents: (await g.parents(fill, ctx())).edges.length,
      gaps: (await g.gaps(fill, ctx())).map((gap) => gap.code),
    };
  };

  it('the cause graph keeps it: dropped, the row would read as a replacement and the way back would end at Fill', async () => {
    // (`conservative` is the graph's word for a commit that also holds a row inside the key; it was there before.)
    expect(await ask(mergedAndInside('delta').list)).toEqual({ parents: 1, gaps: ['conservative'] });
  });

  it.each([
    ['a value that is not the mark', { builtOnView: 'yes' }],
    ['false', { builtOnView: false }],
    ['a number', { builtOnView: 1 }],
  ])('the cause graph refuses %s: the record is not read at all', async (_name, row) => {
    expect(await ask(withRow(mergedAndInside('delta').list, row))).toEqual({ parents: 0, gaps: ['invalid-data'] });
  });

  it('the cause graph refuses the mark on a row that is not a set', async () => {
    const { list } = mergedAndInside('full');
    const marked = list.map((bundle, at) =>
      at !== 1
        ? bundle
        : {
            ...bundle,
            trace: bundle.trace.map((entry) => (entry.verb === 'merge' ? { ...entry, builtOnView: true } : entry)),
          },
    );
    expect(await ask(marked)).toEqual({ parents: 0, gaps: ['invalid-data'] });
  });
});
