import { describe, expect, it } from 'vitest';
import { createRecordGraph, explain } from '../../src/cause.js';
import type { RecordReadSources, RecordScope } from '../../src/cause.js';
import type { CommitBundle } from '../../src/index.js';
import { createReadSourceRecord, RecordFrame, SharedMemory } from '../../src/write.js';

const address = { logRunId: 'review-source-coverage', drillPath: [] };
const context = () => ({ signal: new AbortController().signal });
const failure = { kind: 'error', reason: 'ERROR_RECORDED', evidence: ['review:failure'] } as const;
function commit(runtimeStageId: string, path: string, readKeys?: string[]): CommitBundle {
  return {
    runtimeStageId,
    stageId: runtimeStageId.split('#')[0],
    stage: runtimeStageId.split('#')[0],
    trace: [{ path, verb: 'set', ...(readKeys === undefined ? {} : { readKeys }) }],
    overwrite: { [path]: 1 },
    updates: {},
    redactedPaths: [],
  };
}
function evidence(readers: string[] = [], bindings = readers): RecordReadSources {
  return {
    record: {
      version: 1,
      address,
      segment: 1,
      status: 'captured',
      occurrences: readers.map((runtimeStageId, index) => ({
        ordinal: index + 1,
        runtimeStageId,
        attemptId: runtimeStageId + '@1',
        attemptStatus: 'known',
        key: 'a',
        stateAddress: [],
        source: { kind: 'committed', commitIdx: 0 },
        disposition: 'released',
      })),
      gaps: [],
      limits: { maxOccurrences: 32, maxPerExecution: 32, maxBytes: 16384, maxOrigins: 32, maxStaging: 32 },
    },
    executions: bindings.map((runtimeStageId) => ({
      runtimeStageId,
      stateAddress: [],
      attemptIds: [runtimeStageId + '@1'],
    })),
  };
}
function scope(commitLog: CommitBundle[], readSources = evidence(), extra: Partial<RecordScope> = {}): RecordScope {
  return { address, commitLog, readSources, attention: {}, controlDeps: {}, complete: true, ...extra };
}
function node(graph: ReturnType<typeof createRecordGraph>, runtimeStageId: string, commitIdx: number, key?: string) {
  return graph.nodeId(address, { runtimeStageId, commitIdx, ...(key === undefined ? {} : { key }) });
}

describe('source coverage review regressions', () => {
  it('keeps an unbound execution with no collected reads incomplete, like an absent source seam', async () => {
    const record = scope([commit('a#0', 'a')], evidence(), { attention: { 'a#0': [failure] } });
    const graph = createRecordGraph([record]);
    const selected = node(graph, 'a#0', 0);
    expect(await graph.parents(selected, context())).toEqual({ edges: [], complete: false });
    expect((await graph.gaps(selected, context())).map((gap) => gap.code)).toContain('not-collected');
    const { readSources: _readSources, ...legacy } = record;
    for (const candidate of [graph, createRecordGraph([legacy])]) {
      const result = await explain(candidate, selected);
      expect(result.rootCause).toBeUndefined();
      expect(result.confidence).toBe('incomplete');
    }
  });

  it('preserves an explicit empty write prefix without declaring the whole execution read-free', async () => {
    const graph = createRecordGraph([scope([commit('a#0', 'a', [])])]);
    expect(await graph.parents(node(graph, 'a#0', 0, 'a'), context())).toEqual({ edges: [], complete: true });
    expect((await graph.parents(node(graph, 'a#0', 0), context())).complete).toBe(false);
  });

  it('accepts explicit empty stage reads and an authorized empty source book with a known attempt', async () => {
    for (const record of [
      scope([commit('a#0', 'a')], evidence(), { reads: { 'a#0': [] } }),
      scope([commit('a#0', 'a')], evidence([], ['a#0'])),
    ]) {
      const graph = createRecordGraph([record]);
      expect(await graph.parents(node(graph, 'a#0', 0), context())).toEqual({ edges: [], complete: true });
    }
  });

  it.each([{ attemptIds: undefined }, { attemptIds: [] }])(
    'does not certify empty source coverage without authorized attempts: $attemptIds',
    async ({ attemptIds }) => {
      const sources = evidence([], ['a#0']);
      const graph = createRecordGraph([
        scope([commit('a#0', 'a')], {
          ...sources,
          executions: [{ ...sources.executions[0], attemptIds }],
        }),
      ]);
      expect((await graph.parents(node(graph, 'a#0', 0), context())).complete).toBe(false);
    },
  );

  it.each([false, true])(
    'keeps forward coverage incomplete when a known consumer lacks observations (bound=%s)',
    async (bound) => {
      const graph = createRecordGraph([
        scope(
          [commit('a#0', 'a', []), commit('b#1', 'b', []), commit('c#2', 'c', ['a'])],
          evidence(['b#1'], bound ? ['b#1', 'c#2'] : ['b#1']),
          { reads: { 'a#0': [], 'b#1': ['a'], 'c#2': ['a'] } },
        ),
      ]);
      const source = node(graph, 'a#0', 0, 'a');
      const children = await graph.children(source, context());
      expect(children.edges).toEqual([
        expect.objectContaining({ nodeId: node(graph, 'b#1', 1), attribution: 'recorded-read' }),
      ]);
      expect(children.complete).toBe(false);
      expect((await graph.parents(node(graph, 'c#2', 2), context())).complete).toBe(false);
      expect((await explain(graph, source)).impact.confidence).toBe('incomplete');
    },
  );

  it('does not treat an unknown later execution as a proven absent consumer', async () => {
    const graph = createRecordGraph([
      scope([commit('a#0', 'a', []), commit('c#1', 'c')], evidence(), { reads: { 'a#0': [] } }),
    ]);
    expect(await graph.children(node(graph, 'a#0', 0, 'a'), context())).toEqual({ edges: [], complete: false });
  });

  it('retains a root established by complete parents when only later consumer coverage is missing', async () => {
    const graph = createRecordGraph([
      scope([commit('a#0', 'a', []), commit('c#1', 'c')], evidence(), {
        reads: { 'a#0': [] },
        attention: { 'a#0': [failure] },
      }),
    ]);
    const selected = node(graph, 'a#0', 0, 'a');
    expect(await graph.parents(selected, context())).toEqual({ edges: [], complete: true });
    expect(await graph.gaps(selected, context())).toEqual([]);
    const result = await explain(graph, selected);
    expect(result.rootCause).toBe(selected);
    expect(result.impact.confidence).toBe('incomplete');
    expect(result.confidence).toBe('incomplete');
  });

  it('keeps a later unproved continuation unknown even when its execution first committed earlier', async () => {
    const graph = createRecordGraph([
      scope(
        [commit('a#0', 'early', []), commit('b#1', 'a', []), { ...commit('a#0', 'later', ['a']), phase: 'repeat' }],
        evidence(),
        { reads: { 'b#1': [] } },
      ),
    ]);
    const selected = node(graph, 'b#1', 1, 'a');
    expect(await graph.parents(selected, context())).toEqual({ edges: [], complete: true });
    expect(await graph.children(selected, context())).toEqual({ edges: [], complete: false });
  });

  it('includes a native scalar descendant consumer in the containing value impact', async () => {
    const state = new SharedMemory(undefined, { ns: { x: 0 } });
    const native = createReadSourceRecord(state, address, { stateAddresses: [['ns']] });
    const writer = new RecordFrame(state, native.log, ['ns']);
    writer.useEncoding({ commitValues: 'delta', writeProvenance: 'reads-prefix' });
    writer.write(['ns', 'x'], 7, 'set');
    writer.write(['ns.x'], 9, 'set');
    writer.commit(() => ({ stage: 'A', stageId: 'a', runtimeStageId: 'a#0' }));
    writer.release();
    const reader = new RecordFrame(state, native.log, ['ns']);
    const observed = reader.readWithSource([], 'x', { runtimeStageId: 'b#1', attemptId: 'b#1@1' });
    reader.write(['out'], 8, 'set');
    reader.commit(() => ({ stage: 'B', stageId: 'b', runtimeStageId: 'b#1' }));
    reader.release();
    const literalReader = new RecordFrame(state, native.log);
    literalReader.readWithSource([], 'ns.x', { runtimeStageId: 'c#2', attemptId: 'c#2@1' });
    literalReader.write(['literalOut'], 10, 'set');
    literalReader.commit(() => ({ stage: 'C', stageId: 'c', runtimeStageId: 'c#2' }));
    literalReader.release();
    expect(observed.occurrence?.source).toEqual({ kind: 'committed', commitIdx: 0 });
    const graph = createRecordGraph([
      scope(
        native.log.list(),
        {
          record: native.snapshot(),
          executions: [
            { runtimeStageId: 'b#1', stateAddress: ['ns'], attemptIds: ['b#1@1'] },
            { runtimeStageId: 'c#2', stateAddress: [], attemptIds: ['c#2@1'] },
          ],
        },
        { initialState: native.log.getInitialState(), reads: { 'a#0': [], 'b#1': ['ns\u001fx'], 'c#2': ['ns.x'] } },
      ),
    ]);
    const leaf = await graph.children(node(graph, 'a#0', 0, 'ns\u001fx'), context());
    const ancestor = await graph.children(node(graph, 'a#0', 0, 'ns'), context());
    expect(leaf.edges).toHaveLength(1);
    expect(ancestor).toEqual(leaf);
    expect((await graph.children(node(graph, 'a#0', 0), context())).edges).toHaveLength(2);
    expect((await explain(graph, node(graph, 'a#0', 0, 'ns'))).impact.nodes).toContain(node(graph, 'b#1', 1));
    expect(await graph.children(node(graph, 'a#0', 0, 'ns\u001fx\u001fimagined'), context())).toEqual({
      edges: [],
      complete: false,
    });
    native.retire();
  });

  it('counts source and control children together in the shared immediate edge cap', async () => {
    const record = scope([commit('a#0', 'a', []), commit('b#1', 'b', []), commit('c#2', 'c', [])], evidence(['b#1']), {
      reads: { 'a#0': [], 'b#1': ['a'], 'c#2': [] },
      controlDeps: { 'c#2': { deciderId: 'a#0' } },
      attention: { 'a#0': [failure] },
    });
    const bounded = createRecordGraph([record], { maxEdges: 1 });
    const selected = node(bounded, 'a#0', 0);
    expect((await bounded.children(selected, context())).complete).toBe(false);
    expect((await bounded.gaps(selected, context())).map((gap) => gap.code)).toContain('edge-limit');
    expect((await explain(bounded, selected)).rootCause).toBeUndefined();
    const sufficient = createRecordGraph([record], { maxEdges: 2 });
    expect((await sufficient.children(selected, context())).complete).toBe(true);
    expect(await sufficient.gaps(selected, context())).toEqual([]);
  });
});
