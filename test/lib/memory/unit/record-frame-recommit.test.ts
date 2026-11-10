/**
 * A frame that commits and then writes again, with no `release()` in between.
 *
 * The engine always releases after a commit, so its second commit diffs against the state after
 * the first. A writer that skipped the release kept the buffer the commit had emptied, with the
 * diff base from BEFORE that commit: a write that restored the old value compared equal to the
 * stale base and was dropped, and live state kept the wrong value. A write after a commit now
 * starts a new round on committed state as it stands.
 */
import { describe, expect, it } from 'vitest';

import { EventLog } from '../../../../src/lib/memory/EventLog.js';
import { RecordFrame } from '../../../../src/lib/memory/RecordFrame.js';
import { SharedMemory } from '../../../../src/lib/memory/SharedMemory.js';
import type { CommitBundle } from '../../../../src/lib/memory/types.js';

type Loose = Record<string, any>;

function setup(initial: Loose) {
  const state = new SharedMemory(undefined, initial);
  const log = new EventLog(state.getState());
  return { state, log, frame: new RecordFrame(state, log) };
}

let execution = 0;
const commit = (frame: RecordFrame, id = 's'): void =>
  frame.commit(() => ({ stage: id, stageId: id, runtimeStageId: `${id}#${execution++}` }));
const last = (log: EventLog): CommitBundle => log.list()[log.list().length - 1];

describe('RecordFrame — a write after a commit starts a new round', () => {
  it('records a write that restores the value the first commit replaced', () => {
    const { state, log, frame } = setup({ k: 1 });
    frame.write(['k'], 2, 'set');
    commit(frame);
    frame.write(['k'], 1, 'set'); // no release in between
    commit(frame);
    expect(last(log).trace).toEqual([{ path: 'k', verb: 'set' }]);
    expect(state.getState()).toEqual({ k: 1 });
  });

  it('drops a write that repeats what the first commit wrote', () => {
    const { state, log, frame } = setup({ k: 1 });
    frame.write(['k'], 2, 'set');
    commit(frame);
    frame.write(['k'], 2, 'set');
    commit(frame);
    expect(last(log).trace).toEqual([]);
    expect(state.getState()).toEqual({ k: 2 });
  });

  it('diffs against what another writer committed in between', () => {
    const { state, log, frame } = setup({ k: 1 });
    frame.write(['k'], 2, 'set');
    commit(frame);

    const other = new RecordFrame(state, log);
    other.write(['k'], 5, 'set');
    commit(other, 'other');
    other.release();

    frame.write(['k'], 2, 'set'); // 2 was this frame's own last value; state now holds 5
    commit(frame);
    expect(last(log).trace).toEqual([{ path: 'k', verb: 'set' }]);
    expect(state.getState()).toEqual({ k: 2 });
  });

  it('merges into the committed value, not into an emptied working copy', () => {
    const { state, log, frame } = setup({ a: { x: 1, y: 2 }, z: 0 });
    frame.write(['z'], 1, 'set');
    commit(frame);
    frame.write(['a'], { x: 9 }, 'merge');
    expect(frame.read([], 'a')).toEqual({ x: 9, y: 2 }); // read-your-writes over the committed value
    commit(frame);
    expect(state.getState()).toEqual({ a: { x: 9, y: 2 }, z: 1 });
    expect(last(log).updates).toEqual({ a: { x: 9 } });
  });

  it('is the same record a writer that released would have made', () => {
    const run = (release: boolean) => {
      const { state, log, frame } = setup({ k: 1, list: [1] });
      frame.write(['k'], 2, 'set');
      frame.write(['list'], [1, 2], 'set');
      commit(frame, 'first');
      if (release) frame.release();
      frame.write(['k'], 1, 'set');
      frame.write(['list'], [1, 2], 'set');
      commit(frame, 'second');
      return { state: state.getState(), rows: log.list().map((bundle) => bundle.trace) };
    };
    expect(run(false)).toEqual(run(true));
  });
});
