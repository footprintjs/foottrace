import { describe, expect, it } from 'vitest';
import { buildAttemptId, readStoredRecord } from '../../../src/index.js';
import { EventLog, memorySink, RecordFrame, SharedMemory } from '../../../src/write.js';
import { recordRun } from '../../helpers/recordRun.js';

const ids = (count: number) =>
  Array.from({ length: count }, (_, i) => buildAttemptId('fetch#1', 1, { ordinal: i + 1, attempt: 1 }));
const omitted = (row: unknown) => (row as { readAttemptsOmitted?: number }).readAttemptsOmitted;

describe('bounded delivered-source windows', () => {
  it.each(['full', 'delta'] as const)('keeps exact 32/33/1000 boundaries across release (%s)', (commitValues) => {
    for (const count of [32, 33, 1000]) {
      const frame = new RecordFrame(new SharedMemory(undefined, {}), new EventLog({}));
      frame.useEncoding({ commitValues, writeProvenance: 'reads-prefix' });
      const sources = ids(count);
      sources.forEach((id) => frame.noteReadAttempt(id));
      frame.write(['first'], 1, 'set');
      frame.commit(() => ({ stage: 'first', stageId: 'first', runtimeStageId: 'first#0' }));
      frame.release();
      frame.write(['second'], 2, 'set');
      frame.commit(() => ({ stage: 'second', stageId: 'second', runtimeStageId: 'second#1' }));
      for (const bundle of frame.log!.list()) {
        expect(bundle.trace[0].readAttempts).toEqual(sources.slice(-32));
        expect(omitted(bundle.trace[0])).toBe(count > 32 ? count - 32 : undefined);
      }
    }
  });

  it.each(['full', 'delta'] as const)('retains the latest 32 and earlier snapshots (%s)', (commitValues) => {
    const sources = ids(1000);
    const run = recordRun({}, { commitValues, writeProvenance: 'reads-prefix' });
    const bundle = run.step('write', (s) => {
      sources.slice(0, 32).forEach((id) => s.frame.noteReadAttempt(id));
      s.set('before', 1);
      sources.slice(32).forEach((id) => s.frame.noteReadAttempt(id));
      for (let i = 0; i < 100; i++) s.set('after' + i, i);
      const active = (s.frame as unknown as { readAttempts?: Set<string> }).readAttempts;
      expect(active?.size).toBeLessThanOrEqual(32);
    });
    expect(bundle.trace[0].readAttempts).toEqual(sources.slice(0, 32));
    expect(omitted(bundle.trace[0])).toBeUndefined();
    for (const row of bundle.trace.slice(1)) {
      expect(row.readAttempts).toEqual(sources.slice(-32));
      expect(omitted(row)).toBe(968);
    }
  });

  it.each(['full', 'delta'] as const)(
    'refreshes retained duplicates and admits evicted reentries (%s)',
    (commitValues) => {
      const sources = ids(33);
      const run = recordRun({}, { commitValues, writeProvenance: 'reads-prefix' });
      const bundle = run.step('write', (s) => {
        sources.forEach((id) => s.frame.noteReadAttempt(id));
        s.set('first', 1);
        s.frame.noteReadAttempt(sources[1]);
        s.set('refreshed', 2);
        s.frame.noteReadAttempt(sources[0]);
        s.set('reentered', 3);
      });
      expect(bundle.trace[0].readAttempts).toEqual(sources.slice(1));
      expect(omitted(bundle.trace[0])).toBe(1);
      expect(bundle.trace[1].readAttempts).toEqual([...sources.slice(2), sources[1]]);
      expect(omitted(bundle.trace[1])).toBe(1);
      expect(bundle.trace[2].readAttempts).toEqual([...sources.slice(3), sources[1], sources[0]]);
      expect(omitted(bundle.trace[2])).toBe(2);
    },
  );

  it.each(['full', 'delta'] as const)(
    'keeps the latest pair through repeated paths and delete flattening (%s)',
    (commitValues) => {
      const sources = ids(34);
      const run = recordRun({ gone: 1 }, { commitValues, writeProvenance: 'reads-prefix' });
      const bundle = run.step('write', (s) => {
        sources.slice(0, 33).forEach((id) => s.frame.noteReadAttempt(id));
        s.set('same', 1);
        s.frame.noteReadAttempt(sources[33]);
        s.set('same', 2);
        s.delete('gone');
      });
      for (const path of ['same', 'gone']) {
        const row = bundle.trace.filter((r) => r.path === path).at(-1)!;
        expect(row.readAttempts).toEqual(sources.slice(2));
        expect(omitted(row)).toBe(2);
      }
    },
  );

  it.each(['full', 'delta'] as const)('preserves paired snapshots in an actually lossy family (%s)', (commitValues) => {
    const sources = ids(34);
    const run = recordRun({ object: { a: 0 } }, { commitValues, writeProvenance: 'reads-prefix' });
    const bundle = run.step('write', (s) => {
      s.merge('object', { x: 1 });
      sources.slice(0, 33).forEach((id) => s.frame.noteReadAttempt(id));
      s.set('object', { b: 1 });
      s.merge('object', { z: 3 });
      s.frame.noteReadAttempt(sources[33]);
      s.set('y', 2, undefined, ['object']);
    });
    const root = bundle.trace.find((r) => r.path === 'object')!;
    const child = bundle.trace.find((r) => r.path === 'object\u001fy')!;
    expect(root.readAttempts).toEqual(sources.slice(1, 33));
    expect(omitted(root)).toBe(1);
    expect(child.readAttempts).toEqual(sources.slice(2));
    expect(omitted(child)).toBe(2);
  });

  it('saturates evictions safely without an infeasible number of deliveries', () => {
    const frame = new RecordFrame(new SharedMemory(undefined, {}), new EventLog({}));
    frame.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
    const sources = ids(34);
    sources.slice(0, 32).forEach((id) => frame.noteReadAttempt(id));
    // White-box seed of the private arithmetic boundary; no production testing hook.
    (frame as unknown as { readAttemptsOmitted: number }).readAttemptsOmitted = Number.MAX_SAFE_INTEGER - 1;
    frame.noteReadAttempt(sources[32]);
    frame.write(['first'], 1, 'set');
    frame.noteReadAttempt(sources[33]);
    frame.write(['second'], 2, 'set');
    frame.commit(() => ({ stage: 'write', stageId: 'write', runtimeStageId: 'write#0' }));
    expect(frame.log!.list()[0].trace.map(omitted)).toEqual([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);
  });

  it('saves the counter and resets both fields on discard while notes survive', () => {
    const sink = memorySink(),
      log = new EventLog({}, { sink, address: { logRunId: 'cap-run', drillPath: [] } });
    const frame = new RecordFrame(new SharedMemory(undefined, {}), log);
    frame.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
    ids(33).forEach((id) => frame.noteReadAttempt(id));
    log.note('attempt', { outcome: 'ok' });
    frame.write(['kept'], 1, 'set');
    frame.commit(() => ({ stage: 'write', stageId: 'write', runtimeStageId: 'write#0' }));
    frame.discard();
    frame.write(['clean'], 2, 'set');
    frame.commit(() => ({ stage: 'next', stageId: 'next', runtimeStageId: 'next#1' }));
    log.close('ok');
    const reopened = readStoredRecord(JSON.parse(JSON.stringify(sink.entries))).root('cap-run')!;
    expect(omitted(reopened.commitLog[0].trace[0])).toBe(1);
    expect(reopened.commitLog[1].trace[0].readAttempts).toBeUndefined();
    expect(omitted(reopened.commitLog[1].trace[0])).toBeUndefined();
    expect(reopened.notes).toHaveLength(1);
  });

  it('starts a fresh eviction counter when delivery resumes after discard', () => {
    const frame = new RecordFrame(new SharedMemory(undefined, {}), new EventLog({}));
    frame.useEncoding({ commitValues: 'delta', writeProvenance: 'reads-prefix' });
    ids(34).forEach((id) => frame.noteReadAttempt(id));
    frame.discard();
    const sources = ids(33);
    frame.noteReadAttempt(sources[0]);
    frame.write(['first'], 1, 'set');
    sources.slice(1).forEach((id) => frame.noteReadAttempt(id));
    frame.write(['second'], 2, 'set');
    frame.commit(() => ({ stage: 'write', stageId: 'write', runtimeStageId: 'write#0' }));
    const rows = frame.log!.list()[0].trace;
    expect(rows[0].readAttempts).toEqual(sources.slice(0, 1));
    expect(omitted(rows[0])).toBeUndefined();
    expect(rows[1].readAttempts).toEqual(sources.slice(1));
    expect(omitted(rows[1])).toBe(1);
  });

  it('keeps whole long canonical IDs and leaves off/empty bytes unchanged', () => {
    const long = buildAttemptId('a'.repeat(400) + '#1', 1, { ordinal: 1, attempt: 1 });
    const run = recordRun({}, { writeProvenance: 'reads-prefix' });
    expect(
      run.step('write', (s) => {
        s.frame.noteReadAttempt(long);
        s.set('x', 1);
      }).trace[0].readAttempts,
    ).toEqual([long]);
    const write = (deliver: boolean) =>
      recordRun({}, { writeProvenance: 'off' }).step('write', (s) => {
        if (deliver) ids(33).forEach((id) => s.frame.noteReadAttempt(id));
        s.set('x', 1);
      });
    expect(JSON.stringify(write(true))).toBe(JSON.stringify(write(false)));
    const empty = recordRun({}, { writeProvenance: 'reads-prefix' }).step('write', (s) => s.set('x', 1));
    expect(empty.trace[0].readAttempts).toBeUndefined();
    expect(omitted(empty.trace[0])).toBeUndefined();
  });
});
