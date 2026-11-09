import { describe, expect, it } from 'vitest';
import { createReadSourceRecord, decodeReadSourceSnapshot, RecordFrame, SharedMemory } from '../../../write';
import { createRecordGraph, explain } from '../../../cause';
import { exportProv } from '../../../prov';

type Unsupported = 'composite' | 'merge' | 'repeated' | 'redacted' | 'delete';
const address = { logRunId: 'prefix-availability', drillPath: [] };
const context = () => ({ signal: new AbortController().signal });
function fixture(
  kind: Unsupported | 'scalar',
  placement: 'after' | 'before' | 'other' = 'after',
  disposition = 'released',
) {
  const state = new SharedMemory(undefined, {});
  const record = createReadSourceRecord(state, address, { writeReadPrefixes: true });
  const seed = new RecordFrame(state, record.log);
  seed.useReadSourceOwner({ runtimeStageId: 'seed#0', attemptId: 'seed#0@1' });
  seed.write(['a'], 41, 'set');
  seed.write(['b'], 42, 'set');
  seed.commit(() => ({ stage: 'Seed', stageId: 'seed', runtimeStageId: 'seed#0' }));
  seed.release();
  const owner = { runtimeStageId: 'reader#1', attemptId: 'reader#1@1' };
  const frame = new RecordFrame(state, record.log);
  frame.useReadSourceOwner(owner);
  const write = (target: RecordFrame) => {
    if (kind === 'delete') target.write(['a'], undefined, 'delete');
    else if (kind === 'merge') target.write(['out'], { x: 42 }, 'merge');
    else if (kind === 'composite') target.write(['out'], { x: 42 }, 'set');
    else {
      target.write(['out'], 42, 'set', kind === 'redacted' ? { whole: true } : undefined);
      if (kind === 'repeated') target.write(['out'], 43, 'set');
    }
  };
  if (placement === 'before') write(frame);
  frame.readWithSource([], 'a', owner);
  frame.noteRead([], 'a');
  if (placement === 'after') write(frame);
  frame.commit(() => ({ stage: 'Reader', stageId: 'reader', runtimeStageId: owner.runtimeStageId }));
  if (disposition === 'released' || placement === 'other') frame.release();
  if (disposition === 'discarded' && placement !== 'other') frame.discard();
  if (placement === 'other') {
    const other = new RecordFrame(state, record.log);
    const otherOwner = { runtimeStageId: 'other#2', attemptId: 'other#2@1' };
    other.readWithSource([], 'b', otherOwner);
    other.noteRead([], 'b');
    write(other);
    other.commit(() => ({ stage: 'Other', stageId: 'other', runtimeStageId: 'other#2' }));
    if (disposition === 'released') other.release();
    if (disposition === 'discarded') other.discard();
  }
  const snapshot = record.snapshot();
  expect(decodeReadSourceSnapshot(snapshot)).toEqual(snapshot);
  const scope = {
    address,
    initialState: {},
    commitLog: record.log.list(),
    complete: true,
    reads: { 'seed#0': [], 'reader#1': ['a'], ...(placement === 'other' ? { 'other#2': ['b'] } : {}) },
    controlDeps: {},
    attention: { 'seed#0': [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: ['host-witness'] }] },
    readSources: {
      record: snapshot,
      executions: [
        { runtimeStageId: 'seed#0', stateAddress: [], attemptIds: ['seed#0@1'] },
        { runtimeStageId: 'reader#1', stateAddress: [], attemptIds: [owner.attemptId] },
        ...(placement === 'other' ? [{ runtimeStageId: 'other#2', stateAddress: [], attemptIds: ['other#2@1'] }] : []),
      ],
    },
  } as any;
  const graph = createRecordGraph([scope]);
  const source = graph.nodeId(address, { runtimeStageId: 'seed#0', commitIdx: 0, key: 'a' });
  return { graph, source, snapshot, scope };
}

describe('write-prefix availability is directional and candidate-specific', () => {
  it.each(['composite', 'merge', 'repeated', 'redacted', 'delete'] as const)(
    'keeps %s output association unknown without losing the exact backward source',
    async (kind) => {
      const { graph, source, snapshot, scope } = fixture(kind);
      expect(snapshot.writeReadPrefixes).toMatchObject({ status: 'captured', omitted: 0 });
      expect(snapshot.writeReadPrefixes?.writes.find((row) => row.commitIdx === 1)?.status).toBe('unavailable');
      const result = await explain(graph, source, { includeBackward: true });
      const adjacency = await graph.children(source, context());
      expect(result.rootCause).toBe(source);
      expect(result.backward?.confidence).toBe('complete');
      expect(result.impact.confidence).toBe('incomplete');
      expect(adjacency.complete).toBe(false);
      expect(adjacency.edges).toHaveLength(1);
      expect(adjacency.edges[0].attribution).toBe('recorded-read');
      expect(JSON.stringify(await exportProv(scope, { base: 'urn:availability-proof:' }))).not.toContain(
        'observed-before-write',
      );
    },
  );
  it.each(['composite', 'merge', 'repeated', 'redacted'] as const)(
    'does not associate a later read with an earlier unavailable %s output',
    async (kind) => {
      const { graph, source, snapshot } = fixture(kind, 'before');
      expect(snapshot.writeReadPrefixes?.writes.find((row) => row.commitIdx === 1)).toMatchObject({
        status: 'unavailable',
        through: 0,
        count: 0,
      });
      expect((await graph.children(source, context())).complete).toBe(true);
      expect(
        (await graph.children(source, context())).edges.every((edge) => edge.attribution === 'recorded-read'),
      ).toBe(true);
    },
  );
  it.each(['composite', 'merge', 'repeated', 'redacted'] as const)(
    'does not associate an unrelated frame with an unavailable %s output',
    async (kind) => {
      const { graph, source, snapshot } = fixture(kind, 'other');
      expect(snapshot.writeReadPrefixes?.writes.find((row) => row.commitIdx === 2)?.status).toBe('unavailable');
      expect((await graph.children(source, context())).complete).toBe(true);
      expect(
        (await graph.children(source, context())).edges.every((edge) => edge.attribution === 'recorded-read'),
      ).toBe(true);
    },
  );
  it.each(['active', 'discarded'])(
    'keeps an unrelated %s frame independent of a released exact source read',
    async (disposition) => {
      const { graph, source } = fixture('scalar', 'other', disposition);
      expect((await graph.children(source, context())).complete).toBe(true);
    },
  );
  it.each(['active', 'discarded'])('does not call %s observation/output linkage complete', async (disposition) => {
    const { graph, source } = fixture('scalar', 'after', disposition);
    const result = await explain(graph, source, { includeBackward: true });
    expect(result.rootCause).toBe(source);
    expect(result.backward?.confidence).toBe('complete');
    expect(result.impact.confidence).toBe('incomplete');
    const adjacency = await graph.children(source, context());
    expect(adjacency.complete).toBe(false);
    expect(adjacency.edges.every((edge) => edge.attribution === 'recorded-read')).toBe(true);
  });
});
