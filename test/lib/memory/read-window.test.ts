/**
 * The read window: which commits a step's read could have seen.
 *
 * A log is ordered by commit, and a step commits when it ends. A step that read `x` early and
 * committed late sits after a sibling that wrote `x` in between; dating its read at its own commit
 * named the sibling and left out the real source. The record now says when a step began
 * (`CommitBundle.beganAt`) and, when it looked at live state again after a sibling committed, how far
 * it saw (`CommitBundle.sawUntil`). Every reader asks one rule (`readWindow.ts`).
 *
 * Test types: unit (the rule, the window, the admission of the stamps), scenario (the real writer,
 * then the backward walk and the slice), boundary (logs cut or built by hand, values that are not
 * stamps).
 */
import { describe, expect, it } from 'vitest';

import {
  causalChain,
  findLastWriter,
  findReadSources,
  formatSlice,
  keysReadFromMap,
  overlapOf,
  readStoredRecord,
  sliceForKey,
  sliceToJSON,
} from '../../../src';
import type { CommitBundle } from '../../../src';
import { lastWriterPosition } from '../../../src/lib/memory/commitLogUtils';
import { admitStamps, readOfValue, readSourcesOf, windowOf } from '../../../src/lib/memory/readWindow';
import { EventLog, memorySink, RecordFrame, SharedMemory } from '../../../src/write';

function world(seed: Record<string, unknown> = {}) {
  const state = new SharedMemory(undefined, seed);
  const log = new EventLog(seed);
  return { state, log, frame: (address: string[] = []) => new RecordFrame(state, log, address) };
}
function commit(frame: RecordFrame, id: string, phase?: 'exit' | 'repeat'): void {
  frame.commit(() => ({ stage: id, stageId: id, runtimeStageId: `${id}#0`, ...(phase && { phase }) }));
  frame.release();
}
/** Write a ROOT key, as a subflow's output mapping does from any frame. */
const writeRoot = (frame: RecordFrame, key: string, value: unknown) => frame.write([key], value, 'set');
/** The parents a step has through `key`, each with its mark when it is only a possible source. */
const parentsVia = (log: CommitBundle[], id: string, reads: Record<string, string[]>, key: string) => {
  const root = causalChain(log, id, keysReadFromMap(reads).lookup)!;
  return root.parentEdges
    .filter((edge) => edge.key === key)
    .map((edge) => `${edge.parent.runtimeStageId}${edge.overlap ? ` (${edge.overlap})` : ''}`)
    .sort();
};
const withoutStamps = (log: CommitBundle[]) =>
  log.map((bundle) => {
    const { beganAt: _beganAt, sawUntil: _sawUntil, ...rest } = bundle;
    return rest as CommitBundle;
  });

/**
 * The run of the finding: `seed` writes x; `slow` reads x and copies it later; `fast` replaces x in
 * between and commits first. `again`: `slow` reads x a second time after `fast` committed.
 */
function sideBySide(again = false) {
  const { log, frame } = world();
  const seed = frame();
  writeRoot(seed, 'x', 'from-seed');
  commit(seed, 'seed');
  const slow = frame(['runs', 'slow']);
  const seen = [slow.read([], 'x')];
  const fast = frame();
  writeRoot(fast, 'x', 'from-fast');
  commit(fast, 'fast');
  if (again) seen.push(slow.read([], 'x'));
  slow.write(slow.at([], 'copy'), seen[0], 'set');
  commit(slow, 'slow');
  return { log: log.list(), seen, reads: { 'slow#0': ['x'] } };
}

// positions of the commits that wrote the key, for a made-up log
const lookup = (writers: number[]) => (_key: string, before: number) =>
  writers.filter((position) => position < before).reduce((last, position) => Math.max(last, position), -1);
const at = (point: number) => ({ start: point, end: point });

describe('the rule, backward: a read saw the last write before the step began, or a write in its window', () => {
  it('with no window there is one source: the last writer before the point the read is dated at', () => {
    expect(readSourcesOf('x', at(7), lookup([1, 4]))).toEqual({ before: 4, during: [] });
    expect(readSourcesOf('x', at(7), lookup([]))).toEqual({ before: -1, during: [] });
    // A step dated where it began: a writer between that point and its own commit is not a source.
    expect(readSourcesOf('x', at(3), lookup([1, 4, 6]))).toEqual({ before: 1, during: [] });
  });

  it('writes inside the window are possible sources, in commit order, beside the one before it', () => {
    expect(readSourcesOf('x', { start: 3, end: 7 }, lookup([1, 4, 6]))).toEqual({ before: 1, during: [4, 6] });
    expect(readSourcesOf('x', { start: 3, end: 7 }, lookup([4]))).toEqual({ before: -1, during: [4] });
    expect(readSourcesOf('x', { start: 3, end: 7 }, lookup([1, 2]))).toEqual({ before: 2, during: [] });
  });

  it('the window is closed at its start and open at its end', () => {
    expect(readSourcesOf('x', { start: 3, end: 7 }, lookup([3, 7, 8]))).toEqual({ before: -1, during: [3] });
    expect(readSourcesOf('x', { start: 0, end: 3 }, lookup([0, 1, 2]))).toEqual({ before: -1, during: [0, 1, 2] });
    // A sibling that committed after the step's last look (position 5 and later) is not a source.
    expect(readSourcesOf('x', { start: 3, end: 5 }, lookup([1, 4, 5, 6]))).toEqual({ before: 1, during: [4] });
  });

  it('a source is certain when the window holds no write of the key, and possible otherwise', () => {
    const alone = readSourcesOf('x', at(7), lookup([1, 4]));
    expect(overlapOf(alone, 4)).toBeUndefined();
    const contested = readSourcesOf('x', { start: 3, end: 7 }, lookup([1, 4, 6]));
    expect(overlapOf(contested, 1)).toBe('replaced-while-running');
    expect(overlapOf(contested, 4)).toBe('written-while-running');
    expect(overlapOf(contested, 6)).toBe('written-while-running');
  });
});

describe('the rule, forward: a step read a value when one of its looks could see it', () => {
  it('a step with no window read the value when the point it is dated at sits in the life', () => {
    // a value written at 2 that lives until the write at 6
    expect(readOfValue(at(1), 2, 6, false)).toBe(false); // dated before the write
    expect(readOfValue(at(2), 2, 6, false)).toBe(false); // the writing step itself read the value before
    expect(readOfValue(at(3), 2, 6, false)).toBe(true);
    expect(readOfValue(at(6), 2, 6, false)).toBe(true); // the step that ends the life read it first
    expect(readOfValue(at(7), 2, 6, false)).toBe(false);
    expect(readOfValue(at(9), 2, undefined, false)).toBe(true); // it lives to the end of the log
    expect(readOfValue(at(0), -1, 3, false)).toBe(true); // the value from before the run
  });

  it('a step with a window read it when the value was alive at any look, and only possibly when the key was written there', () => {
    const window = { start: 3, end: 7 };
    expect(readOfValue(window, 1, 5, true)).toBe('replaced-while-running'); // alive when it began, ended inside
    expect(readOfValue(window, 5, undefined, true)).toBe('written-while-running');
    expect(readOfValue(window, 7, undefined, true)).toBe(false); // written after its last look
    expect(readOfValue(window, 0, 2, true)).toBe(false); // ended before it began
    expect(readOfValue(window, 1, 9, false)).toBe(true); // nothing wrote the key in the window: certain
  });
});

describe('when a step looked at state (windowOf)', () => {
  const bundle = (extra: Partial<CommitBundle> = {}): CommitBundle => ({
    stage: 's',
    stageId: 's',
    runtimeStageId: 's#0',
    trace: [],
    redactedPaths: [],
    overwrite: {},
    updates: {},
    ...extra,
  });
  const log = (count: number, last: Partial<CommitBundle>) =>
    Array.from({ length: count }, (_, i) => (i === count - 1 ? bundle(last) : bundle({ idx: i })));

  it('no stamp: every read is dated at the step itself', () => {
    expect(windowOf(log(5, { idx: 4 }), 4)).toEqual({ start: 4, end: 4 });
  });

  it('beganAt alone: every read is dated where the step began, and there is no window', () => {
    expect(windowOf(log(5, { idx: 4, beganAt: 2 }), 4)).toEqual({ start: 2, end: 2 });
    expect(windowOf(log(5, { idx: 4, beganAt: 0 }), 4)).toEqual({ start: 0, end: 0 });
  });

  it('beganAt and sawUntil: the window is the commits between them', () => {
    expect(windowOf(log(6, { idx: 5, beganAt: 1, sawUntil: 3 }), 5)).toEqual({ start: 1, end: 3 });
    expect(windowOf(log(6, { idx: 5, beganAt: 1, sawUntil: 5 }), 5)).toEqual({ start: 1, end: 5 });
  });

  it('a log cut at its front keeps the same window: distances do not depend on where the array starts', () => {
    const whole = log(8, { idx: 7, beganAt: 4, sawUntil: 6 });
    expect(windowOf(whole, 7)).toEqual({ start: 4, end: 6 });
    expect(windowOf(whole.slice(3), 4)).toEqual({ start: 1, end: 3 }); // the same commits
    expect(windowOf(whole.slice(5), 2)).toEqual({ start: 0, end: 1 }); // its start is cut at the array start
    expect(windowOf(whole.slice(7), 0)).toEqual({ start: 0, end: 0 }); // nothing of it is left
  });

  it('a hand-built bundle with no idx is read at its position', () => {
    expect(windowOf(log(5, { beganAt: 1, sawUntil: 3 }), 4)).toEqual({ start: 1, end: 3 });
  });

  it.each([
    ['at the step', { idx: 4, beganAt: 4 }],
    ['after the step', { idx: 4, beganAt: 9 }],
    ['negative', { idx: 4, beganAt: -3 }],
    ['not a whole number', { idx: 4, beganAt: 1.5 }],
    ['not a number', { idx: 4, beganAt: '1' as unknown as number }],
    ['NaN', { idx: 4, beganAt: Number.NaN }],
    ['missing beside a sawUntil', { idx: 4, sawUntil: 2 }],
  ])('a beganAt that is %s opens the window over every commit before the step', (_name, last) => {
    // It says the step did not simply see everything before its commit, and not from when: every earlier
    // writer of a key is then a possible source. Dated at the step instead, the real one could be left out.
    expect(windowOf(log(5, last), 4)).toEqual({ start: 0, end: 4 });
  });

  it.each([
    ['not after beganAt', { idx: 5, beganAt: 2, sawUntil: 2 }],
    ['before beganAt', { idx: 5, beganAt: 2, sawUntil: 1 }],
    ['past the step', { idx: 5, beganAt: 2, sawUntil: 6 }],
    ['not a whole number', { idx: 5, beganAt: 2, sawUntil: 3.5 }],
    ['not a number', { idx: 5, beganAt: 2, sawUntil: '3' as unknown as number }],
  ])('a sawUntil that is %s opens the window up to the step: never narrower than the truth', (_name, last) => {
    expect(windowOf(log(6, last), 5)).toEqual({ start: 2, end: 5 });
  });
});

describe('admitting the stamps of a bundle from outside', () => {
  it('no stamp is no stamp', () => {
    expect(admitStamps(undefined, undefined, 4, 4)).toEqual({});
    expect(admitStamps(undefined, undefined, undefined, 4)).toEqual({});
  });

  it('good stamps are kept as they are when the copy keeps its index', () => {
    expect(admitStamps(2, undefined, 5, 5)).toEqual({ beganAt: 2 });
    expect(admitStamps(2, 4, 5, 5)).toEqual({ beganAt: 2, sawUntil: 4 });
    expect(admitStamps(0, 5, 5, 5)).toEqual({ beganAt: 0, sawUntil: 5 });
    expect(admitStamps(2, 4, undefined, 5)).toEqual({ beganAt: 2, sawUntil: 4 }); // no idx: read at its position
  });

  it('a copy numbered by its position keeps each stamp at the same distance from the bundle', () => {
    // written at index 9 of its log, admitted at position 4 of a slice
    expect(admitStamps(6, 8, 9, 4)).toEqual({ beganAt: 1, sawUntil: 3 });
    expect(admitStamps(3, 8, 9, 4)).toEqual({ beganAt: 0, sawUntil: 3 }); // its start is before the slice: cut
    expect(admitStamps(2, 4, 9, 4)).toEqual({ beganAt: 0 }); // every look was before the slice
    expect(admitStamps(3, 5, 9, 4)).toEqual({ beganAt: 0 }); // its last look was at the slice's first commit
    expect(admitStamps(2, 4, 9, 0)).toEqual({}); // the copy is the first commit: nothing is before it
  });

  it.each([
    ['beganAt at the bundle', [5, undefined, 5]],
    ['beganAt after the bundle', [7, undefined, 5]],
    ['beganAt negative', [-1, undefined, 5]],
    ['beganAt a fraction', [1.5, undefined, 5]],
    ['beganAt a string', ['1', undefined, 5]],
    ['beganAt null', [null, undefined, 5]],
    ['sawUntil without beganAt', [undefined, 3, 5]],
    ['sawUntil not after beganAt', [2, 2, 5]],
    ['sawUntil past the bundle', [2, 6, 5]],
    ['sawUntil a fraction', [2, 3.5, 5]],
    ['sawUntil a string', [2, '3', 5]],
    ['an idx that is not a whole number', [2, 4, 5.5]],
    ['an idx that is not a number', [2, 4, '5']],
    ['an idx too large to count with', [2, 4, 2 ** 60]],
  ])('%s is refused, never dropped', (_name, [beganAt, sawUntil, idx]) => {
    expect(admitStamps(beganAt, sawUntil, idx, 5)).toBeUndefined();
  });
});

describe('the backward walk names what a step could have read, and nothing else', () => {
  it('a step that read early and committed late leads to the earlier writer, for certain', () => {
    const { log, seen, reads } = sideBySide();
    expect(seen).toEqual(['from-seed']); // what it really read
    expect(log[2]).toMatchObject({ runtimeStageId: 'slow#0', beganAt: 1 });
    expect(log[2].sawUntil).toBeUndefined();
    // The sibling committed first, but the step never looked at state after that: it is not a source.
    expect(parentsVia(log, 'slow#0', reads, 'x')).toEqual(['seed#0']);
  });

  it('the same log without the stamps (written before they existed) names the sibling instead', () => {
    const { log, reads } = sideBySide();
    expect(parentsVia(withoutStamps(log), 'slow#0', reads, 'x')).toEqual(['fast#0']);
  });

  it('a step that looked again after the sibling committed has both as possible sources', () => {
    const { log, seen, reads } = sideBySide(true);
    expect(seen).toEqual(['from-seed', 'from-fast']); // it really read both values
    expect(log[2]).toMatchObject({ runtimeStageId: 'slow#0', beganAt: 1, sawUntil: 2 });
    expect(parentsVia(log, 'slow#0', reads, 'x')).toEqual([
      'fast#0 (written-while-running)',
      'seed#0 (replaced-while-running)',
    ]);
  });

  it('a sibling that committed after the step last looked is not a source', () => {
    const { log, frame } = world();
    const seed = frame();
    writeRoot(seed, 'x', 'from-seed');
    commit(seed, 'seed');
    const slow = frame(['runs', 'slow']);
    slow.read([], 'x');
    const one = frame();
    writeRoot(one, 'x', 'one');
    commit(one, 'one');
    expect(slow.read([], 'x')).toBe('one'); // its last look: the log holds 2 commits
    const two = frame();
    writeRoot(two, 'x', 'two');
    commit(two, 'two'); // after that look
    slow.write(slow.at([], 'copy'), 1, 'set');
    commit(slow, 'slow');
    expect(parentsVia(log.list(), 'slow#0', { 'slow#0': ['x'] }, 'x')).toEqual([
      'one#0 (written-while-running)',
      'seed#0 (replaced-while-running)',
    ]);
  });

  it('a step that began after the sibling committed has one source, and no mark', () => {
    const { log, frame } = world();
    const seed = frame();
    writeRoot(seed, 'x', 'from-seed');
    commit(seed, 'seed');
    const fast = frame();
    writeRoot(fast, 'x', 'from-fast');
    commit(fast, 'fast');
    const slow = frame(['runs', 'slow']);
    const seen = slow.read([], 'x');
    slow.write(slow.at([], 'copy'), seen, 'set');
    commit(slow, 'slow');
    expect(seen).toBe('from-fast');
    expect(parentsVia(log.list(), 'slow#0', { 'slow#0': ['x'] }, 'x')).toEqual(['fast#0']);
  });

  it('with no writer before the step began, the value is from before the run: for certain when it never looked again', () => {
    const { log, frame } = world({ x: 'initial' });
    const slow = frame(['runs', 'slow']);
    const seen = slow.read([], 'x');
    const fast = frame();
    writeRoot(fast, 'x', 'from-fast');
    commit(fast, 'fast');
    slow.write(slow.at([], 'copy'), seen, 'set');
    commit(slow, 'slow');
    const root = causalChain(log.list(), 'slow#0', keysReadFromMap({ 'slow#0': ['x'] }).lookup)!;
    expect(seen).toBe('initial');
    expect(root.preRunReads).toEqual({ code: 'pre-run-origin', keys: ['x'] });
    expect(root.parentEdges).toEqual([]);
  });

  it('and when it did look again, both are said: from before the run, or the write in its window', () => {
    const { log, frame } = world({ x: 'initial' });
    const slow = frame(['runs', 'slow']);
    slow.read([], 'x');
    const fast = frame();
    writeRoot(fast, 'x', 'from-fast');
    commit(fast, 'fast');
    slow.read([], 'x');
    commit(slow, 'slow');
    const root = causalChain(log.list(), 'slow#0', keysReadFromMap({ 'slow#0': ['x'] }).lookup)!;
    expect(root.preRunReads).toEqual({ code: 'pre-run-origin', keys: ['x'] });
    expect(root.parentEdges.map((edge) => [edge.parent.runtimeStageId, edge.overlap])).toEqual([
      ['fast#0', 'written-while-running'],
    ]);
  });

  it('every writer inside the window is a possible source', () => {
    const { log, frame } = world();
    const seed = frame();
    writeRoot(seed, 'x', 0);
    commit(seed, 'seed');
    const slow = frame(['runs', 'slow']);
    slow.read([], 'x');
    for (const id of ['one', 'two']) {
      const sibling = frame();
      writeRoot(sibling, 'x', id);
      commit(sibling, id);
    }
    slow.read([], 'x');
    slow.write(slow.at([], 'copy'), 1, 'set');
    commit(slow, 'slow');
    expect(parentsVia(log.list(), 'slow#0', { 'slow#0': ['x'] }, 'x')).toEqual([
      'one#0 (written-while-running)',
      'seed#0 (replaced-while-running)',
      'two#0 (written-while-running)',
    ]);
  });

  it('a key nobody wrote in the window keeps its one certain source beside a contested key', () => {
    const { log, frame } = world();
    const seed = frame();
    writeRoot(seed, 'x', 'from-seed');
    writeRoot(seed, 'y', 'from-seed');
    commit(seed, 'seed');
    const slow = frame(['runs', 'slow']);
    slow.read([], 'x');
    slow.read([], 'y');
    const fast = frame();
    writeRoot(fast, 'x', 'from-fast');
    commit(fast, 'fast');
    slow.read([], 'x');
    commit(slow, 'slow');
    const reads = { 'slow#0': ['x', 'y'] };
    expect(parentsVia(log.list(), 'slow#0', reads, 'y')).toEqual(['seed#0']);
    expect(parentsVia(log.list(), 'slow#0', reads, 'x')).toEqual([
      'fast#0 (written-while-running)',
      'seed#0 (replaced-while-running)',
    ]);
  });

  it('a writer with one bundle before the window and a continuation inside it gets both edges', () => {
    const { log, frame } = world();
    const mount = frame();
    writeRoot(mount, 'x', 'first');
    commit(mount, 'mount'); // before the reader begins
    const slow = frame(['runs', 'slow']);
    slow.read([], 'x');
    writeRoot(mount, 'x', 'second');
    commit(mount, 'mount', 'exit'); // the same execution writes again while the reader runs
    slow.read([], 'x');
    slow.write(slow.at([], 'copy'), 1, 'set');
    commit(slow, 'slow');
    const root = causalChain(log.list(), 'slow#0', keysReadFromMap({ 'slow#0': ['x'] }).lookup)!;
    expect(root.parents.map((parent) => parent.runtimeStageId)).toEqual(['mount#0']);
    expect(root.parentEdges.map((edge) => edge.overlap)).toEqual(['replaced-while-running', 'written-while-running']);
  });

  it('the walk goes on through a possible source like through any other', () => {
    const { log, frame } = world();
    const origin = frame();
    writeRoot(origin, 'input', 1);
    commit(origin, 'origin');
    const seed = frame();
    writeRoot(seed, 'x', 'from-seed');
    commit(seed, 'seed');
    const slow = frame(['runs', 'slow']);
    slow.read([], 'x');
    const fast = frame();
    fast.read([], 'input');
    writeRoot(fast, 'x', 'from-fast');
    commit(fast, 'fast');
    slow.read([], 'x');
    slow.write(slow.at([], 'copy'), 1, 'set');
    commit(slow, 'slow');
    const root = causalChain(log.list(), 'slow#0', keysReadFromMap({ 'slow#0': ['x'], 'fast#0': ['input'] }).lookup)!;
    const fastNode = root.parents.find((parent) => parent.runtimeStageId === 'fast#0')!;
    expect(fastNode.parents.map((parent) => parent.runtimeStageId)).toEqual(['origin#0']);
  });
});

describe('the slice says it in its note, its text and its JSON', () => {
  it('a step that never looked again: one edge, no note, no mark', () => {
    const { log, reads } = sideBySide();
    const slice = sliceForKey(log, ['runs', 'slow', 'copy'], keysReadFromMap(reads), { edgeAttribution: 'stage' });
    expect(slice.notes).toBeUndefined();
    expect(formatSlice(slice)).toContain('seed (seed#0) ← via x [wrote: x]');
    expect(formatSlice(slice)).not.toContain('fast');
    expect(sliceToJSON(slice).edges).toEqual([{ from: 'slow#0', to: 'seed#0', kind: 'data', key: 'x', weight: 1 }]);
  });

  it('a step that looked again: the note counts the read, and every edge of the key is marked', () => {
    const { log, reads } = sideBySide(true);
    const slice = sliceForKey(log, ['runs', 'slow', 'copy'], keysReadFromMap(reads), { edgeAttribution: 'stage' });
    expect(slice.notes?.map((note) => note.code)).toEqual(['concurrent-write']);
    expect(slice.notes?.[0].detail).toMatch(/^1 read was made by a step that looked at state again after another step/);
    const text = formatSlice(slice);
    expect(text).toContain('seed (seed#0) ← via x (as the reader began; written again while it ran) [wrote: x]');
    expect(text).toContain('fast (fast#0) ← via x (written while the reader ran) [wrote: x]');
    expect(sliceToJSON(slice).edges).toEqual([
      { from: 'slow#0', to: 'seed#0', kind: 'data', key: 'x', weight: 1, overlap: 'replaced-while-running' },
      { from: 'slow#0', to: 'fast#0', kind: 'data', key: 'x', weight: 1, overlap: 'written-while-running' },
    ]);
  });

  it('a slice of a run with no overlap has no such note and no such field', () => {
    const { log, frame } = world();
    const seed = frame();
    writeRoot(seed, 'x', 1);
    commit(seed, 'seed');
    const next = frame();
    next.read([], 'x');
    writeRoot(next, 'y', 2);
    commit(next, 'next');
    const slice = sliceForKey(log.list(), 'y', keysReadFromMap({ 'next#0': ['x'] }), { edgeAttribution: 'stage' });
    expect(slice.notes).toBeUndefined();
    expect(JSON.stringify(sliceToJSON(slice))).not.toContain('overlap');
    expect(formatSlice(slice)).not.toContain('while');
  });
});

describe('a stored record keeps the stamps', () => {
  it('written through a sink and read back, the walk gives the same answer', () => {
    const address = { logRunId: 'run', drillPath: [] };
    const sink = memorySink();
    const state = new SharedMemory(undefined, {});
    const log = new EventLog({}, { sink, address });
    const frame = (at: string[] = []) => new RecordFrame(state, log, at);
    const seed = frame();
    writeRoot(seed, 'x', 'from-seed');
    commit(seed, 'seed');
    const slow = frame(['runs', 'slow']);
    slow.read([], 'x');
    const fast = frame();
    writeRoot(fast, 'x', 'from-fast');
    commit(fast, 'fast');
    slow.write(slow.at([], 'copy'), 1, 'set');
    commit(slow, 'slow');
    log.close('ok');

    const stored = readStoredRecord(JSON.parse(JSON.stringify(sink.entries))).log(address)!;
    expect(stored.gaps).toEqual([]);
    expect(stored.commitLog[2]).toMatchObject({ runtimeStageId: 'slow#0', beganAt: 1, idx: 2 });
    expect(parentsVia([...stored.commitLog], 'slow#0', { 'slow#0': ['x'] }, 'x')).toEqual(['seed#0']);
  });
});

describe('the public door: what a step could have read', () => {
  it('findReadSources answers for a STEP, where findLastWriter answers for a position in the log', () => {
    const { log } = sideBySide();
    expect(findLastWriter(log, 'x', 2)?.runtimeStageId).toBe('fast#0'); // the last write before slow's commit
    expect(findReadSources(log, 2, 'x')).toEqual({ before: 0, during: [] }); // what slow read: the seed's
    expect(findReadSources(log, 2, 'never-written')).toEqual({ before: -1, during: [] });
    expect(findReadSources(log, 1, 'x')).toEqual({ before: 0, during: [] }); // a step with no stamp

    const sources = findReadSources(sideBySide(true).log, 2, 'x');
    expect(sources).toEqual({ before: 0, during: [1] });
    expect([overlapOf(sources, 0), overlapOf(sources, 1)]).toEqual(['replaced-while-running', 'written-while-running']);
  });
});

describe('the position twin of findLastWriter', () => {
  it('answers the position findLastWriter answers the bundle of', () => {
    const { log } = sideBySide();
    expect(lastWriterPosition(log, 'x')).toBe(1);
    expect(lastWriterPosition(log, 'x', 1)).toBe(0);
    expect(lastWriterPosition(log, 'x', 0)).toBe(-1);
    expect(lastWriterPosition(log, 'nothing')).toBe(-1);
  });
});
