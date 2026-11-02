import { describe, expect, it } from 'vitest';
import { buildAttemptId, causalChain, readStoredRecord, sliceForKey, stateAt } from '../../../src/index.js';
import { EventLog, memorySink, RecordFrame, SharedMemory } from '../../../src/write.js';
import { recordRun } from '../../helpers/recordRun.js';
import { createRecordGraph, explain } from '../../../src/cause.js';
import { exportProv } from '../../../src/prov.js';

const first = buildAttemptId('fetch#1', 1, { ordinal: 1, attempt: 1 });
const second = buildAttemptId('fetch#1', 1, { ordinal: 2, attempt: 1 });
// The cast lets the red test execute against the old runtime before this additive writer port exists.
const delivered = (frame: RecordFrame, id: string) =>
  (frame as RecordFrame & { noteReadAttempt(id: string): void }).noteReadAttempt(id);
const attempts = (row: unknown) => (row as { readAttempts?: readonly string[] }).readAttempts;

describe('per-write call-answer ceilings', () => {
  it.each(['full', 'delta'] as const)(
    'snapshots the prefix and leaves state-key collisions disjoint (%s)',
    (commitValues) => {
      const run = recordRun({ [first]: 5 }, { commitValues, writeProvenance: 'reads-prefix' });
      const bundle = run.step('fetch', (s) => {
        s.set('before', 0);
        s.read(first);
        delivered(s.frame, first);
        s.set('middle', 1);
        delivered(s.frame, second);
        delivered(s.frame, first);
        s.set('after', 2);
      });
      expect(attempts(bundle.trace.find((r) => r.path === 'before'))).toBeUndefined();
      expect(attempts(bundle.trace.find((r) => r.path === 'middle'))).toEqual([first]);
      expect(attempts(bundle.trace.find((r) => r.path === 'after'))).toEqual([second, first]);
      expect(bundle.trace.find((r) => r.path === 'middle')?.readKeys).toEqual([first]);
      expect(bundle.trace.find((r) => r.path === 'after')?.readKeys).toEqual([first]);
      const later = run.step('later', (s) => s.set('independent', 3));
      expect(attempts(later.trace[0])).toBeUndefined();
    },
  );

  it.each(['full', 'delta'] as const)(
    'keeps the last write prefix through repeated writes and lossy families (%s)',
    (commitValues) => {
      const run = recordRun({ items: [], object: {} }, { commitValues, writeProvenance: 'reads-prefix' });
      const bundle = run.step('fetch', (s) => {
        s.set('items', [1]);
        delivered(s.frame, first);
        s.set('items', [1, 2]);
        s.set('object', { a: 1 });
        delivered(s.frame, second);
        s.set('a', 2, undefined, ['object']);
        s.merge('object', { b: 3 });
      });
      expect(attempts(bundle.trace.filter((r) => r.path === 'items').at(-1))).toEqual([first]);
      expect(bundle.trace.filter((r) => r.path.startsWith('object')).some((r) => attempts(r)?.includes(second))).toBe(
        true,
      );
      expect(stateAt(run.snapshot(), 0).state).toMatchObject({ items: [1, 2], object: { a: 2, b: 3 } });
      expect(attempts(bundle.trace.filter((r) => r.path === 'object').at(-1))).toEqual([first, second]);
    },
  );

  it('discards the prefix while independently delivered attempt notes survive saved reopening', () => {
    const sink = memorySink(),
      state = new SharedMemory(undefined, {});
    const log = new EventLog({}, { sink, address: { logRunId: 'run-a', drillPath: [] } });
    const frame = new RecordFrame(state, log);
    frame.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
    delivered(frame, first);
    log.note('attempt', { id: first, outcome: 'timeout' });
    frame.write(frame.at([], 'discarded'), 1, 'set');
    frame.discard();
    frame.write(frame.at([], 'kept'), 2, 'set');
    frame.commit(() => ({ stage: 'Fetch', stageId: 'fetch', runtimeStageId: 'fetch#1' }));
    expect(attempts(log.list()[0].trace[0])).toBeUndefined();
    const stored = readStoredRecord(JSON.parse(JSON.stringify(sink.entries))).root('run-a')!;
    expect(stored.notes[0].data.id).toBe(first);
    expect(stored.complete).toBe(false);
  });

  it.each(['full', 'delta'] as const)(
    'retains each source in an actually re-encoded lossy family (%s)',
    (commitValues) => {
      const run = recordRun({ object: { a: 0 } }, { commitValues, writeProvenance: 'reads-prefix' });
      const bundle = run.step('fetch', (s) => {
        s.merge('object', { x: 1 });
        delivered(s.frame, first);
        s.set('object', { b: 1 });
        s.merge('object', { z: 3 });
        delivered(s.frame, second);
        s.set('y', 2, undefined, ['object']);
      });
      expect(attempts(bundle.trace.find((row) => row.path === 'object'))).toEqual([first]);
      expect(attempts(bundle.trace.find((row) => row.path === 'object\u001fy'))).toEqual([first, second]);
      expect(stateAt(run.snapshot(), 0).state).toMatchObject({ object: { b: 1, z: 3, y: 2 } });
    },
  );

  it('keeps off/empty trace bytes identical and refuses malformed on-dial identities', () => {
    const write = (enabled: boolean, recordAnswer: boolean) => {
      const run = recordRun({}, { writeProvenance: enabled ? 'reads-prefix' : 'off' });
      return run.step('fetch', (s) => {
        if (recordAnswer) delivered(s.frame, first);
        s.set('x', 1);
      });
    };
    expect(JSON.stringify(write(false, false))).toBe(JSON.stringify(write(false, true)));
    expect(attempts(write(true, false).trace[0])).toBeUndefined();
    const run = recordRun({}, { writeProvenance: 'reads-prefix' });
    run.step('fetch', (s) => {
      for (const id of ['', 'fetch#1', 'fetch#1@0', 'fetch#1@01'])
        expect(() => delivered(s.frame, id)).toThrow(TypeError);
    });
  });

  it('keeps raw backward slices state-only and retains the separate saved call witness', () => {
    const sink = memorySink();
    const log = new EventLog({}, { sink, address: { logRunId: 'slice-run', drillPath: [] } });
    const frame = new RecordFrame(new SharedMemory(undefined, {}), log);
    frame.useEncoding({ commitValues: 'full', writeProvenance: 'reads-prefix' });
    delivered(frame, first);
    frame.write(frame.at([], 'response'), 'artifact:response', 'set');
    frame.commit(() => ({ stage: 'Fetch', stageId: 'fetch', runtimeStageId: 'fetch#0' }));
    log.close('ok');
    const entries = [...readStoredRecord(JSON.parse(JSON.stringify(sink.entries))).root('slice-run')!.commitLog];
    const chain = causalChain(entries, 'fetch#0', () => []);
    const slice = sliceForKey(entries, 'response', () => []);
    // These APIs follow state-key writers only; empty parents cannot rule out external ancestry.
    expect(chain?.parents).toEqual([]);
    expect(slice.root?.parents).toEqual([]);
    expect(slice.writer?.trace[0].readKeys).toEqual([]);
    expect(slice.writer?.trace[0].readAttempts).toEqual([first]);
  });

  it('native cause projection does not quietly claim complete ancestry for unprojected call sources', async () => {
    const run = recordRun({}, { writeProvenance: 'reads-prefix' });
    run.step('fetch', (s) => {
      delivered(s.frame, first);
      s.set('response', 'artifact:response');
    });
    const snapshot = run.snapshot(),
      address = { logRunId: 'run-a', drillPath: [] };
    const graph = createRecordGraph([
      { address, ...snapshot, reads: {}, controlDeps: {}, attention: {}, complete: true },
    ]);
    const result = await explain(graph, graph.nodeId(address, { runtimeStageId: 'fetch#0', key: 'response' }));
    expect(result.confidence).toBe('incomplete');
    expect(result.gaps.some((g) => g.code === 'conservative')).toBe(true);
    expect(result.rootCause).toBeUndefined();
  });

  it('the value-free PROV projection discloses unprojected answer sources instead of inventing remote activities', async () => {
    const run = recordRun({}, { writeProvenance: 'reads-prefix' });
    run.step('fetch', (s) => {
      delivered(s.frame, first);
      s.set('response', 1);
    });
    const projected = await exportProv(run.snapshot(), { base: 'urn:example:call-source/' });
    expect(projected.complete).toBe(false);
    expect(projected.gaps.some((g) => g.code === 'conservative')).toBe(true);
    expect(JSON.stringify(projected.document)).not.toContain(first);
  });

  it('full-mode delete flattening retains the answer ceiling without becoming a state-key read', () => {
    const run = recordRun({ gone: 1 }, { writeProvenance: 'reads-prefix' });
    const bundle = run.step('fetch', (s) => {
      delivered(s.frame, first);
      s.delete('gone');
    });
    expect(bundle.trace[0].verb).toBe('set');
    expect(attempts(bundle.trace[0])).toEqual([first]);
    expect(bundle.trace[0].readKeys).toEqual([]);
  });
});
