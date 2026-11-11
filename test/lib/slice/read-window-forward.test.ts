/**
 * The read window, forward: who read this value?
 *
 * The forward walk and the key timeline dated a read at its step's commit, as the backward walk did.
 * For a step that read `x` early and committed after a sibling replaced `x`, the value it really read
 * showed no reader at all, and the sibling's value showed a certain one. Both now ask the one rule
 * (`memory/readWindow.ts`, through `keyIndex · readersOfLife`): a step is dated where it looked at
 * state, and it is a possible reader only when the key was written inside its window.
 *
 * Test types: scenario (the real writer), boundary (a run with no overlap is unchanged).
 */
import { describe, expect, it } from 'vitest';

import { formatForwardSlice, formatTimeline, forwardSliceForKey, keysReadFromMap, keyTimeline } from '../../../src';
import { EventLog, RecordFrame, SharedMemory } from '../../../src/write';

function world(seed: Record<string, unknown> = {}) {
  const state = new SharedMemory(undefined, seed);
  const log = new EventLog(seed);
  return { log, frame: (address: string[] = []) => new RecordFrame(state, log, address) };
}
function commit(frame: RecordFrame, id: string): void {
  frame.commit(() => ({ stage: id, stageId: id, runtimeStageId: `${id}#0` }));
  frame.release();
}
/**
 * seed writes x (0); slow reads x; fast replaces x and commits (1); slow copies what it read and
 * commits (2). `again`: slow reads x a second time after fast committed.
 */
function sideBySide(again = false) {
  const { log, frame } = world();
  const seed = frame();
  seed.write(['x'], 'from-seed', 'set');
  commit(seed, 'seed');
  const slow = frame(['runs', 'slow']);
  const seen = slow.read([], 'x');
  const fast = frame();
  fast.write(['x'], 'from-fast', 'set');
  commit(fast, 'fast');
  if (again) slow.read([], 'x');
  slow.write(slow.at([], 'copy'), seen, 'set');
  commit(slow, 'slow');
  return { log: log.list(), reads: keysReadFromMap({ 'slow#0': ['x'] }) };
}
const slowRead = { runtimeStageId: 'slow#0', stageId: 'slow', stageName: 'slow', commitIdx: 2 };
const timelineOf = (run: ReturnType<typeof sideBySide>) => keyTimeline(run.log, 'x', run.reads);

describe('the forward walk lists the steps that read a value, dated where they looked', () => {
  it("the value that was really read has its reader, for certain, though the reader committed after the value's life ended", () => {
    const { log, reads } = sideBySide();
    const slice = forwardSliceForKey(log, 'x', reads, { before: 1 }); // the seed's value
    expect(slice.root?.runtimeStageId).toBe('seed#0');
    expect(slice.root?.nextWriteIdx).toBe(1);
    expect(slice.root?.reads).toEqual([slowRead]);
    expect(slice.root?.fedEdges.map((edge) => edge.child.runtimeStageId)).toEqual(['slow#0']);
    expect(slice.notes.map((note) => note.code)).not.toContain('concurrent-write');
    expect(formatForwardSlice(slice)).toContain('  read by slow (slow#0) @2');
    expect(formatForwardSlice(slice)).not.toContain('maybe');
  });

  it('the value the sibling wrote has no reader: the step never looked at state after that commit', () => {
    const { log, reads } = sideBySide();
    const slice = forwardSliceForKey(log, 'x', reads); // the latest value: fast's
    expect(slice.root?.runtimeStageId).toBe('fast#0');
    expect(slice.root?.reads).toEqual([]);
  });

  it('a step that looked again is a possible reader of both values, and each says why', () => {
    const { log, reads } = sideBySide(true);
    const before = forwardSliceForKey(log, 'x', reads, { before: 1 });
    expect(before.root?.reads).toEqual([{ ...slowRead, overlap: 'replaced-while-running' }]);
    expect(formatForwardSlice(before)).toContain(
      'maybe read by slow (slow#0) @2 — the key was written again while it ran',
    );
    const during = forwardSliceForKey(log, 'x', reads);
    expect(during.root?.reads).toEqual([{ ...slowRead, overlap: 'written-while-running' }]);
    expect(formatForwardSlice(during)).toContain('maybe read by slow (slow#0) @2 — it began before this write');
    for (const slice of [before, during]) {
      expect(slice.notes.find((note) => note.code === 'concurrent-write')?.detail).toMatch(
        /^1 read was made by a step that looked at state again after another step committed the key/,
      );
    }
  });

  it('the timeline says which value a read saw, and which it could have seen', () => {
    const certain = timelineOf(sideBySide());
    expect(certain.moments?.[2]).toEqual({ kind: 'read', ...slowRead, fromWriteIdx: 0 });
    expect(certain.notes).toEqual([]);
    expect(formatTimeline(certain)).toContain('@2 read  — slow (slow#0) (value from commit 0)');

    const contested = timelineOf(sideBySide(true));
    expect(contested.moments).toEqual([
      { kind: 'write', commitIdx: 0, runtimeStageId: 'seed#0', stageId: 'seed', stageName: 'seed', verb: 'set' },
      { kind: 'write', commitIdx: 1, runtimeStageId: 'fast#0', stageId: 'fast', stageName: 'fast', verb: 'set' },
      { kind: 'read', ...slowRead, fromWriteIdx: 0, orWriteIdxs: [1] },
    ]);
    expect(contested.notes.map((note) => note.code)).toEqual(['concurrent-write']);
    expect(formatTimeline(contested)).toContain(
      '@2 read  — slow (slow#0) (value from commit 0, or from commit 1 written while it ran)',
    );
  });

  it('readers come in commit order, and a step is a reader only of the keys it read', () => {
    const { log, frame } = world();
    const seed = frame();
    seed.write(['x'], 'from-seed', 'set');
    seed.write(['z'], 'from-seed', 'set');
    commit(seed, 'seed'); // 0
    const early = frame(['runs', 'early']);
    early.read([], 'x'); // looks when the log holds 1 commit
    const other = frame();
    other.write(['y'], 1, 'set');
    commit(other, 'other'); // 1: lands while `early` runs
    commit(early, 'early'); // 2: dated where it began
    const late = frame();
    late.read([], 'x');
    commit(late, 'late'); // 3: dated at its own commit
    const reads = keysReadFromMap({ 'early#0': ['x'], 'late#0': ['x'] });

    expect(log.list()[2]).toMatchObject({ runtimeStageId: 'early#0', beganAt: 1 });
    const readersOf = (key: string) =>
      forwardSliceForKey(log.list(), key, reads).root?.reads.map((read) => [read.runtimeStageId, read.commitIdx]);
    expect(readersOf('x')).toEqual([
      ['early#0', 2],
      ['late#0', 3],
    ]);
    // `early` began while `z` was alive, but it never read `z`.
    expect(readersOf('z')).toEqual([]);
  });

  it('a run with no overlap answers as before: no possible reader, no extra field, no note', () => {
    const { log, frame } = world();
    const seed = frame();
    seed.write(['x'], 1, 'set');
    commit(seed, 'seed');
    const reader = frame();
    reader.read([], 'x');
    reader.write(['y'], 2, 'set');
    commit(reader, 'reader');
    const reads = keysReadFromMap({ 'reader#0': ['x'] });
    const slice = forwardSliceForKey(log.list(), 'x', reads);
    expect(slice.root?.reads).toEqual([
      { runtimeStageId: 'reader#0', stageId: 'reader', stageName: 'reader', commitIdx: 1 },
    ]);
    expect(slice.notes.map((note) => note.code)).not.toContain('concurrent-write');
    const timeline = keyTimeline(log.list(), 'x', reads);
    expect(timeline.moments?.[1]).toEqual({
      kind: 'read',
      commitIdx: 1,
      runtimeStageId: 'reader#0',
      stageId: 'reader',
      stageName: 'reader',
      fromWriteIdx: 0,
    });
    expect(timeline.notes).toEqual([]);
  });
});
