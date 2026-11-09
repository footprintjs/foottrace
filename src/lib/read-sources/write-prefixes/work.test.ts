import { describe, expect, it, vi } from 'vitest';
import { createReadSourceRecord, RecordFrame, SharedMemory } from '../../../write';
import * as paths from '../../memory/keyPaths';
import { prepareWriteReadPrefixes } from './admit';
import { decodeWriteReadPrefixes } from './codec';

function zeroReadWrites() {
  const state = new SharedMemory(undefined, {}),
    owner = { runtimeStageId: 'write#0', attemptId: 'write#0@1' };
  const record = createReadSourceRecord(state, { logRunId: 'work-proof', drillPath: [] }, { writeReadPrefixes: true });
  const frame = new RecordFrame(state, record.log);
  frame.useReadSourceOwner(owner);
  for (let index = 0; index < 16; index++) frame.write(['q'.repeat(96) + String(index).padStart(4, '0')], index, 'set');
  frame.commit(() => ({ stage: 'Write', stageId: 'write', runtimeStageId: owner.runtimeStageId }));
  frame.release();
  const log = JSON.parse(JSON.stringify(record.log.list()));
  log[0].redactedPaths = Array.from({ length: 8 }, (_, index) => 'q'.repeat(96) + 'zzzz\u001fmark' + index);
  const bindings = new Map([[owner.runtimeStageId, { attempts: new Set([owner.attemptId]), stateAddress: [] }]]);
  return { record: record.snapshot(), log, bindings };
}

describe('write-prefix privacy work reservations', () => {
  it('indexes completed observations once instead of rescanning every prior read for every output', () => {
    const state = new SharedMemory(undefined, { a: 1 });
    const owner = { runtimeStageId: 'write#0', attemptId: 'write#0@1' };
    const record = createReadSourceRecord(
      state,
      { logRunId: 'rank-proof', drillPath: [] },
      { writeReadPrefixes: true },
    );
    const frame = new RecordFrame(state, record.log);
    for (let index = 0; index < 100; index++) {
      frame.readWithSource([], 'a', owner);
      frame.write(['out' + index], index, 'set');
    }
    frame.commit(() => ({ stage: 'Write', stageId: 'write', runtimeStageId: owner.runtimeStageId }));
    frame.release();
    const snapshot = record.snapshot();
    let completionReads = 0;
    // Only this private, already-admitted occurrence seam is instrumented, not untrusted wire admission.
    const occurrences = snapshot.occurrences.map((row) => ({
      ...row,
      get completed() {
        completionReads++;
        return row.completed;
      },
    }));
    const decoded = decodeWriteReadPrefixes(snapshot.writeReadPrefixes, occurrences, snapshot.limits, () => {});
    expect(decoded.writes).toHaveLength(100);
    expect(completionReads).toBeLessThan(1000);
  });
  it('stops before uncharged repeated long-prefix comparisons on a zero-read/many-write record', () => {
    const f = zeroReadWrites(),
      compare = vi.spyOn(paths, 'relation');
    let remaining = 6000;
    try {
      expect(() =>
        prepareWriteReadPrefixes(f.record, f.log, [], f.bindings, (cost) => {
          remaining -= cost;
          if (remaining < 0) throw Error('WORK_STOP');
        }),
      ).toThrow('WORK_STOP');
      expect(compare.mock.calls.length).toBeGreaterThan(0);
      expect(compare.mock.calls.length).toBeLessThan(16 * 8);
    } finally {
      compare.mockRestore();
    }
  });
  it('admits the same supported fixture when its caller provides the charged allowance', () => {
    const f = zeroReadWrites();
    let remaining = 100000;
    const result = prepareWriteReadPrefixes(f.record, f.log, [], f.bindings, (cost) => {
      remaining -= cost;
      if (remaining < 0) throw Error('WORK_STOP');
    });
    expect(result?.writes.size).toBe(16);
    expect(result?.partial).toBe(false);
    expect(remaining).toBeGreaterThan(0);
  });
});
