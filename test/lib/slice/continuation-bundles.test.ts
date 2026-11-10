/**
 * Forward queries over a log that holds CONTINUATION bundles.
 *
 * One execution can commit more than once: a fork child's fan-out settle (`phase: 'repeat'`) and a
 * subflow mount's exit (`phase: 'exit'`) carry the runtimeStageId of the execution's first bundle.
 * The stage read before its own commit, so its reads belong to that FIRST bundle. Dating them again
 * at the continuation made a stage a reader of writes that happened after it ran.
 */
import { describe, expect, it } from 'vitest';

import type { CommitBundle, TraceEntry } from '../../../src/lib/memory/types.js';
import { forwardSliceForKey, keysReadFromMap, keyTimeline, sliceForKey } from '../../../src/lib/slice/index.js';

function commit(runtimeStageId: string, writes: string[], idx: number, phase?: CommitBundle['phase']): CommitBundle {
  const stageId = runtimeStageId.split('#')[0];
  return {
    idx,
    stage: stageId,
    stageId,
    runtimeStageId,
    trace: writes.map((path): TraceEntry => ({ path, verb: 'set' })),
    redactedPaths: [],
    overwrite: Object.fromEntries(writes.map((path) => [path, `val-${path}`])),
    updates: {},
    ...(phase !== undefined && { phase }),
  };
}

// A writes x. Fork child C reads x and writes c. Its sibling D rewrites x. Then C's fan-out settle
// commits again under C's runtimeStageId. C read A's x; it never read D's.
const LOG = [commit('A#0', ['x'], 0), commit('C#1', ['c'], 1), commit('D#2', ['x'], 2), commit('C#1', [], 3, 'repeat')];
const READS = keysReadFromMap({ 'C#1': ['x'] });

describe('forward queries read an execution once, at its first bundle', () => {
  it('keyTimeline lists the read once, in the life of the write it read', () => {
    const reads = keyTimeline(LOG, 'x', READS).moments!.filter((moment) => moment.kind === 'read');
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ runtimeStageId: 'C#1', commitIdx: 1, fromWriteIdx: 0 });
  });

  it('forwardSliceForKey does not name the stage a reader of a later write', () => {
    const fromD = forwardSliceForKey(LOG, 'x', READS);
    expect(fromD.root!.commitIdx).toBe(2);
    expect(fromD.root!.reads).toEqual([]);

    const fromA = forwardSliceForKey(LOG, 'x', READS, { before: 2 });
    expect(fromA.root!.commitIdx).toBe(0);
    expect(fromA.root!.reads.map((read) => [read.runtimeStageId, read.commitIdx])).toEqual([['C#1', 1]]);
  });

  it('agrees with the backward walk: the reader links to the writer before its first bundle', () => {
    const backward = sliceForKey(LOG, 'c', READS);
    expect(backward.root!.parents.map((parent) => parent.runtimeStageId)).toEqual(['A#0']);
  });

  it('a mount exit (`phase: exit`) dates the mount reads at its first bundle too', () => {
    const log = [
      commit('A#0', ['x'], 0),
      commit('M#1', [], 1),
      commit('D#2', ['x'], 2),
      commit('M#1', ['out'], 3, 'exit'),
    ];
    const reads = keyTimeline(log, 'x', keysReadFromMap({ 'M#1': ['x'] })).moments!.filter(
      (moment) => moment.kind === 'read',
    );
    expect(reads.map((moment) => [moment.commitIdx, moment.fromWriteIdx])).toEqual([[1, 0]]);
  });
});
