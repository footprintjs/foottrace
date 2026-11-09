import { describe, expect, it } from 'vitest';
import { createReadSourceRecord, decodeReadSourceSnapshot, RecordFrame, SharedMemory } from '../../../write';
import { createRecordGraph, explain } from '../../../cause';
import { exportProv } from '../../../prov';

const address = { logRunId: 'output-read-proof', drillPath: [] };
const owner = { runtimeStageId: 'reader#1', attemptId: 'reader#1@1' };
function fixture(maxOccurrences?: number) {
  const state = new SharedMemory(undefined, {});
  const record = createReadSourceRecord(state, address, {
    writeReadPrefixes: true,
    ...(maxOccurrences === undefined ? {} : { limits: { maxOccurrences } }),
  });
  const seed = new RecordFrame(state, record.log);
  seed.useReadSourceOwner({ runtimeStageId: 'seed#0', attemptId: 'seed#0@1' });
  seed.write(['a'], 1, 'set');
  seed.write(['b'], 2, 'set');
  seed.commit(() => ({ stage: 'Seed', stageId: 'seed', runtimeStageId: 'seed#0' }));
  seed.release();
  const frame = new RecordFrame(state, record.log);
  frame.readWithSource([], 'a', owner);
  frame.noteRead([], 'a');
  frame.write(['out'], 42, 'set'); // A read may be ignored: this is a constant on purpose.
  frame.readWithSource([], 'b', owner);
  frame.noteRead([], 'b');
  frame.commit(() => ({ stage: 'Reader', stageId: 'reader', runtimeStageId: owner.runtimeStageId }));
  frame.release();
  const scope = {
    address,
    initialState: {},
    commitLog: record.log.list(),
    complete: true,
    reads: { 'seed#0': [], 'reader#1': ['a', 'b'] },
    controlDeps: {},
    attention: { 'seed#0': [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: ['witness'] }] },
    readSources: {
      record: record.snapshot(),
      executions: [
        { runtimeStageId: 'seed#0', stateAddress: [], attemptIds: ['seed#0@1'] },
        { runtimeStageId: 'reader#1', stateAddress: [], attemptIds: [owner.attemptId] },
      ],
    },
  } as any;
  expect(decodeReadSourceSnapshot(scope.readSources.record)).toEqual(scope.readSources.record);
  return { record, scope };
}
const ctx = () => ({ signal: new AbortController().signal });
describe('admitted completed-read prefixes', () => {
  it('excludes later reads from a particular output but keeps a possible-contributor gap', async () => {
    const { scope } = fixture(),
      graph = createRecordGraph([scope]);
    const output = graph.nodeId(address, { runtimeStageId: owner.runtimeStageId, commitIdx: 1, key: 'out' });
    const a = graph.nodeId(address, { runtimeStageId: 'seed#0', commitIdx: 0, key: 'a' });
    const parents = await graph.parents(output, ctx());
    expect(parents.edges).toHaveLength(1);
    expect(parents.edges[0]).toMatchObject({ nodeId: a, attribution: 'per-write' });
    expect(parents.edges[0].evidence).toContain('write-prefix:1:0');
    expect((await graph.gaps(output, ctx())).map((g) => g.code)).toContain('conservative');
    expect((await explain(graph, output)).rootCause).toBeUndefined();
  });
  it('exports only observed prefix candidates, never standard derivation', async () => {
    const { scope } = fixture();
    const result = await exportProv(scope, { base: 'urn:prefix-proof:' });
    const text = JSON.stringify(result);
    expect(text).toContain('observed-before-write');
    expect(text).not.toContain('wasDerivedFrom');
    const rows = (result as any).document?.['@graph'] ?? (result as any)['@graph'] ?? [];
    expect(rows.filter((r: any) => r['ft:attribution'] === 'observed-before-write')).toHaveLength(1);
  });
  it('keeps forward possible output impact symmetric and excludes a later read from that output', async () => {
    const { scope } = fixture(),
      graph = createRecordGraph([scope]);
    const a = graph.nodeId(address, { runtimeStageId: 'seed#0', commitIdx: 0, key: 'a' });
    const b = graph.nodeId(address, { runtimeStageId: 'seed#0', commitIdx: 0, key: 'b' });
    const output = graph.nodeId(address, { runtimeStageId: owner.runtimeStageId, commitIdx: 1, key: 'out' });
    expect((await graph.children(a, ctx())).edges).toContainEqual(
      expect.objectContaining({ nodeId: output, attribution: 'per-write' }),
    );
    expect((await graph.children(b, ctx())).edges.some((edge) => edge.nodeId === output)).toBe(false);
    expect((await graph.children(a, ctx())).complete).toBe(false);
  });
  it.each([false, true])(
    'keeps an exact backward root independent of possible forward output impact: qualified=%s',
    async (qualified) => {
      const { scope } = fixture(),
        graph = createRecordGraph([scope]);
      const source = graph.nodeId(address, {
        runtimeStageId: 'seed#0',
        commitIdx: 0,
        ...(qualified ? { key: 'a' } : {}),
      });
      const result = await explain(graph, source, { includeBackward: true });
      expect(result.rootCause).toBe(source);
      expect(result.backward?.confidence).toBe('complete');
      expect(result.impact.confidence).toBe('incomplete');
      expect((await graph.gaps(source, ctx())).map((g) => g.code)).not.toContain('conservative');
    },
  );
  it('retains the existing immediate data/control edge-cap law', async () => {
    const { scope } = fixture(),
      graph = createRecordGraph([scope], { maxEdges: 1 });
    const source = graph.nodeId(address, { runtimeStageId: 'seed#0', commitIdx: 0 });
    expect((await graph.gaps(source, ctx())).map((g) => g.code)).toContain('edge-limit');
    expect((await explain(graph, source)).rootCause).toBeUndefined();
  });
  it.each(['last', 'all'])('refuses a captured sidecar with %s output entries removed at the codec door', (kind) => {
    const { scope } = fixture(),
      wire = JSON.parse(JSON.stringify(scope.readSources.record));
    wire.writeReadPrefixes.writes = kind === 'all' ? [] : wire.writeReadPrefixes.writes.slice(0, -1);
    expect(decodeReadSourceSnapshot(wire)).toBeUndefined();
  });
  it('reconciles captured coverage with native rows even if a stored frame count is coherently edited', async () => {
    const { scope } = fixture(),
      wire = JSON.parse(JSON.stringify(scope.readSources.record));
    const removed = wire.writeReadPrefixes.writes.pop();
    const manifest = wire.writeReadPrefixes.frames.find((row: any) => row.frame === removed.frame);
    manifest.writes = (manifest.writes ?? 1) - 1;
    expect(decodeReadSourceSnapshot(wire)).toBeDefined(); // Structural consistency is not authentication.
    const graph = createRecordGraph([{ ...scope, readSources: { ...scope.readSources, record: wire } }]);
    const source = graph.nodeId(address, { runtimeStageId: 'seed#0', commitIdx: 0, key: 'a' });
    expect((await graph.children(source, ctx())).complete).toBe(false);
    expect((await graph.gaps(source, ctx())).map((g) => g.code)).toContain('invalid-data');
    expect(
      JSON.stringify(
        await exportProv(
          { ...scope, readSources: { ...scope.readSources, record: wire } },
          {
            base: 'urn:incomplete-prefix-proof:',
          },
        ),
      ),
    ).not.toContain('observed-before-write');
  });
  it.each([0, 1])(
    'keeps partial output coverage unknown forward without downgrading exact backward reads: omitted=%s',
    async (omitted) => {
      const { scope } = fixture(),
        wire = JSON.parse(JSON.stringify(scope.readSources.record));
      wire.writeReadPrefixes.writes.pop();
      wire.writeReadPrefixes.status = 'partial';
      wire.writeReadPrefixes.omitted = omitted;
      expect(decodeReadSourceSnapshot(wire)).toBeDefined();
      const graph = createRecordGraph([{ ...scope, readSources: { ...scope.readSources, record: wire } }]);
      const source = graph.nodeId(address, { runtimeStageId: 'seed#0', commitIdx: 0 });
      const result = await explain(graph, source, { includeBackward: true });
      expect(result.rootCause).toBe(source);
      expect(result.backward?.confidence).toBe('complete');
      expect(result.impact.confidence).toBe('incomplete');
      expect((await graph.children(source, ctx())).complete).toBe(false);
    },
  );
  it('keeps a real write-limit exhaustion separate from complete recorded-read coverage', async () => {
    const { scope, record } = fixture(2),
      snapshot = record.snapshot();
    expect(snapshot.status).toBe('captured');
    expect(snapshot.writeReadPrefixes?.status).toBe('partial');
    expect(snapshot.writeReadPrefixes?.writes.some((row) => row.commitIdx === 1)).toBe(false);
    expect(decodeReadSourceSnapshot(snapshot)).toEqual(snapshot);
    const graph = createRecordGraph([scope]);
    const source = graph.nodeId(address, { runtimeStageId: 'seed#0', commitIdx: 0 });
    const result = await explain(graph, source, { includeBackward: true });
    expect(result.rootCause).toBe(source);
    expect(result.backward?.confidence).toBe('complete');
    expect(result.impact.confidence).toBe('incomplete');
    expect((await graph.children(source, ctx())).edges).toContainEqual(
      expect.objectContaining({
        nodeId: graph.nodeId(address, { runtimeStageId: owner.runtimeStageId, commitIdx: 1 }),
        attribution: 'recorded-read',
      }),
    );
  });
  it.each(['count', 'completion', 'completion-gap', 'owner', 'row', 'future-source', 'cut-last-read', 'cut-all-reads'])(
    'refuses internally inconsistent %s evidence',
    async (kind) => {
      const { scope } = fixture();
      const wire = JSON.parse(JSON.stringify(scope.readSources.record));
      const prefix = wire.writeReadPrefixes.writes.find((r: any) => r.commitIdx === 1);
      if (kind === 'count') prefix.count++;
      if (kind === 'completion') wire.occurrences[1].completed = wire.occurrences[0].completed;
      if (kind === 'completion-gap') wire.occurrences[1].completed += 9;
      if (kind === 'owner') prefix.attemptId = 'reader#1@2';
      if (kind === 'row') prefix.rowIdx = 99;
      if (kind === 'future-source') {
        wire.occurrences[0].source = { kind: 'committed', commitIdx: 2 };
        scope.commitLog = [
          ...scope.commitLog,
          {
            idx: 2,
            stage: 'Future',
            stageId: 'future',
            runtimeStageId: 'future#2',
            overwrite: { a: 9 },
            updates: {},
            redactedPaths: [],
            trace: [{ path: 'a', verb: 'set', readKeys: [] }],
          },
        ];
        scope.reads['future#2'] = [];
      }
      if (kind === 'cut-last-read') wire.occurrences.pop();
      if (kind === 'cut-all-reads') wire.occurrences = [];
      const graph = createRecordGraph([{ ...scope, readSources: { ...scope.readSources, record: wire } }]);
      const output = graph.nodeId(address, { runtimeStageId: owner.runtimeStageId, commitIdx: 1, key: 'out' });
      expect((await graph.parents(output, ctx())).complete).toBe(false);
      expect((await graph.gaps(output, ctx())).map((g) => g.code)).toContain('invalid-data');
    },
  );
  it('never executes a sidecar getter while admitting untrusted stored evidence', () => {
    const { scope } = fixture();
    let calls = 0;
    const wire = JSON.parse(JSON.stringify(scope.readSources.record));
    Object.defineProperty(wire.writeReadPrefixes, 'writes', {
      get() {
        calls++;
        throw Error('do not run');
      },
    });
    expect(decodeReadSourceSnapshot(wire)).toBeUndefined();
    expect(calls).toBe(0);
  });
});
