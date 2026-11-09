import { describe, expect, it } from 'vitest';
import { createReadSourceRecord, decodeReadSourceSnapshot, EventLog, RecordFrame, SharedMemory } from '../../../write';

const address = { logRunId: 'prefix-proof', drillPath: [] };
const owner = { runtimeStageId: 'work#1', attemptId: 'work#1@1' };
const stamp = () => ({ stage: 'Work', stageId: 'work', runtimeStageId: owner.runtimeStageId });
function open(enabled = true) {
  const state = new SharedMemory(undefined, { a: 1, b: 2 });
  const record = createReadSourceRecord(state, address, { writeReadPrefixes: enabled } as never);
  const frame = new RecordFrame(state, record.log);
  return { state, record, frame };
}
const sidecar = (record: ReturnType<typeof createReadSourceRecord>): any =>
  (record.snapshot() as any).writeReadPrefixes;

describe('native completed read prefixes', () => {
  it('does not pin first-touch state while an owner waits before its first access', async () => {
    for (const enabled of [false, true]) {
      const { frame, state, record } = open(enabled);
      (frame as any).useReadSourceOwner(owner);
      await Promise.resolve();
      const other = new RecordFrame(state, record.log);
      other.write(['a'], 9, 'set');
      other.commit(() => ({ stage: 'Other', stageId: 'other', runtimeStageId: 'other#0' }));
      expect(frame.readWithSource([], 'a', owner).value).toBe(9);
    }
  });
  it('keeps legacy format and log bytes unchanged when disabled', () => {
    const { frame, record } = open(false);
    frame.readWithSource([], 'a', owner);
    frame.write(['x'], 3, 'set');
    frame.commit(stamp);
    expect(record.snapshot().version).toBe(1);
    expect(sidecar(record)).toBeUndefined();
    expect(JSON.stringify(record.log.list())).not.toContain('Prefix');
  });
  it('binds a write to only completed reads before it, without changing trace bytes', () => {
    const { frame, record } = open();
    frame.readWithSource([], 'a', owner);
    frame.write(['x'], 3, 'set');
    frame.readWithSource([], 'b', owner);
    frame.commit(stamp);
    frame.release();
    expect(record.snapshot().version).toBe(2);
    expect(sidecar(record).writes).toEqual([
      expect.objectContaining({
        commitIdx: 0,
        rowIdx: 0,
        runtimeStageId: owner.runtimeStageId,
        attemptId: owner.attemptId,
        through: 1,
        count: 1,
        status: 'observed',
      }),
    ]);
    expect((record.snapshot().occurrences as any[]).map((r) => r.completed)).toEqual([1, 2]);
    expect(decodeReadSourceSnapshot(JSON.parse(JSON.stringify(record.snapshot())))).toEqual(record.snapshot());
    expect(sidecar(record).frames[0]).toMatchObject({ count: 2, writes: 1 });
    expect(JSON.stringify(record.log.list())).not.toContain('Prefix');
  });
  it('does not include an outer pending read merely because its reservation ordinal is earlier', () => {
    const { frame, record } = open();
    frame.readWithSource([], 'a', owner, () => {
      frame.readWithSource([], 'b', owner);
      frame.write(['x'], 3, 'set');
      return 'visible';
    });
    frame.commit(stamp);
    frame.release();
    expect((record.snapshot().occurrences as any[]).map((r) => [r.ordinal, r.completed])).toEqual([
      [1, 2],
      [2, 1],
    ]);
    expect(sidecar(record).writes[0]).toMatchObject({ through: 1, count: 1 });
  });
  it('never mixes parallel frames even when completion sequence interleaves', () => {
    const { frame, state, record } = open();
    const other = new RecordFrame(state, record.log);
    frame.readWithSource([], 'a', owner);
    other.readWithSource([], 'b', { runtimeStageId: 'other#2', attemptId: 'other#2@1' });
    frame.write(['x'], 3, 'set');
    frame.commit(stamp);
    frame.release();
    expect(sidecar(record).writes[0]).toMatchObject({ count: 1, through: 2 });
  });
  it('preserves observed empty prefixes through explicit native owner binding', () => {
    const { frame, record } = open();
    (frame as any).useReadSourceOwner(owner);
    frame.write(['x'], 3, 'set');
    frame.commit(stamp);
    frame.release();
    expect(sidecar(record).writes[0]).toMatchObject({ status: 'observed', through: 0, count: 0 });
  });
  it.each(['repeated', 'merge', 'delete', 'composite', 'nested'])('withholds unsupported output %s', (kind) => {
    const { frame, record } = open();
    frame.readWithSource([], 'a', owner);
    if (kind === 'repeated') {
      frame.write(['x'], 3, 'set');
      frame.write(['x'], 4, 'set');
    }
    if (kind === 'merge') frame.write(['x'], { n: 1 }, 'merge');
    if (kind === 'delete') frame.write(['a'], undefined, 'delete');
    if (kind === 'composite') frame.write(['x'], { n: 1 }, 'set');
    if (kind === 'nested') frame.write(['box', 'x'], 3, 'set');
    frame.commit(stamp);
    frame.release();
    expect(sidecar(record).writes.every((r: any) => r.status === 'unavailable')).toBe(true);
    expect(sidecar(record).writes.length).toBeGreaterThan(0);
    expect(sidecar(record).frames[0].writes).toBe(record.log.list()[0].trace.length);
  });
  it('does not borrow a discarded retry frame for the next attempt', () => {
    const { frame, record } = open();
    frame.readWithSource([], 'a', owner);
    frame.write(['lost'], 9, 'set');
    frame.discard();
    const next = { ...owner, attemptId: 'work#1@2' };
    frame.readWithSource([], 'b', next);
    frame.write(['x'], 3, 'set');
    frame.commit(stamp);
    frame.release();
    expect(sidecar(record).writes).toHaveLength(1);
    expect(sidecar(record).writes[0]).toMatchObject({ count: 1, attemptId: next.attemptId });
  });
  it('keeps original native errors when evidence cannot be made', () => {
    const { frame, record } = open();
    frame.readWithSource([], 'a', owner);
    frame.write(['x'], 3, 'set');
    const error = new Error('original stamp');
    expect(() =>
      frame.commit(() => {
        throw error;
      }),
    ).toThrow(error);
    expect(sidecar(record).writes).toEqual([]);
    expect(sidecar(record).frames[0].writes).toBe(0);
  });
  it('keeps v2 snapshots decodable within the one overall byte budget after exhaustion', () => {
    const state = new SharedMemory(undefined, { a: 1 });
    const record = createReadSourceRecord(state, address, { writeReadPrefixes: true, limits: { maxBytes: 2048 } });
    const frame = new RecordFrame(state, record.log);
    frame.useReadSourceOwner(owner);
    for (let index = 0; index < 100; index++) {
      frame.readWithSource([], 'a', owner);
      frame.write(['out' + index], index, 'set');
    }
    frame.commit(stamp);
    frame.release();
    expect(Buffer.byteLength(JSON.stringify(record.snapshot()))).toBeLessThanOrEqual(2048);
    expect(record.snapshot().status).not.toBe('captured');
    expect(decodeReadSourceSnapshot(record.snapshot())).toEqual(record.snapshot());
  });
  it('bounds total write associations independently of how many commits a log retains', () => {
    const state = new SharedMemory(undefined, { a: 1 });
    const record = createReadSourceRecord(state, address, { writeReadPrefixes: true, limits: { maxOccurrences: 2 } });
    for (let i = 0; i < 10; i++) {
      const frame = new RecordFrame(state, record.log);
      frame.useReadSourceOwner({ runtimeStageId: 'w#' + i, attemptId: 'w#' + i + '@1' });
      frame.write(['out'], i + 1, 'set');
      frame.commit(() => ({ stage: 'w', stageId: 'w', runtimeStageId: 'w#' + i }));
      frame.release();
    }
    expect(sidecar(record).writes.length).toBeLessThanOrEqual(2);
    expect(sidecar(record).status).toBe('partial');
    expect(sidecar(record).omitted).toBeGreaterThan(0);
    expect(decodeReadSourceSnapshot(record.snapshot())).toEqual(record.snapshot());
  });
  it('does not retain a no-op write or upgrade a repeated path to a unique event', () => {
    const { frame, record } = open();
    frame.readWithSource([], 'a', owner);
    frame.write(['a'], 1, 'set');
    frame.commit(stamp);
    frame.release();
    expect(sidecar(record).writes).toEqual([]);
  });
  it('does not call an aggregated delta row a unique write even when only one row survives', () => {
    const { frame, record } = open();
    frame.useEncoding({ commitValues: 'delta', writeProvenance: 'off' });
    frame.readWithSource([], 'a', owner);
    frame.write(['out'], 3, 'set');
    frame.write(['out'], 4, 'set');
    frame.commit(stamp);
    frame.release();
    expect(record.log.list()[0].trace).toHaveLength(1);
    expect(sidecar(record).writes[0]).toMatchObject({ status: 'unavailable', reason: 'unsupported-write' });
  });
  it('keeps an earlier immutable snapshot separate from later observations', () => {
    const { frame, record } = open();
    frame.readWithSource([], 'a', owner);
    frame.write(['x'], 3, 'set');
    frame.commit(stamp);
    const before = record.snapshot(),
      bytes = JSON.stringify(before);
    frame.readWithSource([], 'b', owner);
    expect(JSON.stringify(before)).toBe(bytes);
    expect(Object.isFrozen((before as any).writeReadPrefixes.writes[0])).toBe(true);
  });
  it('leaves ordinary noncapturing logs unchanged', () => {
    const state = new SharedMemory(undefined, { a: 1 });
    const log = new EventLog(state.getState());
    const frame = new RecordFrame(state, log);
    frame.write(['x'], 2, 'set');
    frame.commit(stamp);
    expect(log.list()[0].trace).toEqual([{ path: 'x', verb: 'set' }]);
  });
});
