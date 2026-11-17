import { expect, it } from 'vitest';
import { EventLog, RecordFrame, SharedMemory } from '../../../write.js';
import type { NativeReadObservation } from '../pathOps.js';
import {
  beginLocatedRead,
  completeLocationCandidate,
  endLocatedRead,
  noteLocationSegment,
  resetLocationCandidate,
  takeLocation,
} from '../readLocation.js';

it('forgets losing candidates without forgetting an accessor observed earlier in the same call', () => {
  const observation = beginLocatedRead();
  try {
    resetLocationCandidate(observation);
    noteLocationSegment(observation, 'losing', false);
    resetLocationCandidate(observation);
    noteLocationSegment(observation, 'winner', true);
    completeLocationCandidate(observation, true);
    expect(takeLocation(observation, 'winner', 1)).toBeUndefined();
  } finally {
    endLocatedRead(observation);
  }
});

for (const throws of [false, true]) {
  it(`ends the call-local token after a real live read, privacy throws=${throws}`, () => {
    const state = new SharedMemory(undefined, {});
    const frame = new RecordFrame(state);
    frame.read([], 'missing');
    state.setValue([], [], 'n', 2);
    let seen: NativeReadObservation | undefined;
    const native = state.getValue;
    state.getValue = (address, path, key, observation) => {
      seen = observation;
      return native.call(state, address, path, key, observation);
    };
    const failure = new Error('original');
    if (throws) {
      expect(() =>
        frame.readWithLocation([], 'n', { runtimeStageId: 'read#0' }, () => {
          throw failure;
        }),
      ).toThrow(failure);
    } else {
      expect(frame.readWithLocation([], 'n').location).toEqual(['n']);
    }
    expect(seen).toBeDefined();
    // These internal helpers cannot revive a completed token or retain a last-read receipt.
    resetLocationCandidate(seen);
    noteLocationSegment(seen!, 'forged', true);
    completeLocationCandidate(seen, true);
    expect(takeLocation(seen!, 'n', 2)).toBeUndefined();
  });
}

it('does not attach a location when a custom live port supplies no completed native traversal', () => {
  const state = new SharedMemory(undefined, {});
  const frame = new RecordFrame(state);
  frame.read([], 'missing');
  state.getValue = () => 42;
  const result = frame.readWithLocation([], 'custom');
  expect(result.value).toBe(42);
  expect(Object.hasOwn(result, 'location')).toBe(false);
});

it('preserves legacy prefixes only for the no-source branch, matching existing read doors', () => {
  for (const source of [false, true]) {
    const read = (located: boolean) => {
      const state = new SharedMemory(undefined, { cfg: { n: 7 } });
      const log = new EventLog(state.getState());
      const frame = new RecordFrame(state, log);
      frame.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
      if (located) {
        const result = source
          ? frame.readWithLocation(['cfg'], 'n', { runtimeStageId: 'read#0' })
          : frame.readWithLocation(['cfg'], 'n');
        expect(result.location).toEqual(['cfg', 'n']);
      } else if (source) frame.readWithSource(['cfg'], 'n', { runtimeStageId: 'read#0' });
      else frame.readTracked(['cfg'], 'n');
      frame.write(['result'], 7, 'set');
      frame.commit(() => ({ stage: 'Write', stageId: 'write', runtimeStageId: 'write#0' }));
      return log.list()[0].trace;
    };
    const baseline = read(false);
    expect(read(true)).toEqual(baseline);
    expect(baseline[0].readKeys).toEqual(source ? [] : ['cfg.n']);
  }
});
