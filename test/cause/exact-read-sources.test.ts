import { describe, expect, it, vi } from 'vitest';
import { createRecordGraph, createStoredRecordGraph, explain } from '../../src/cause.js';
import type { RecordScope } from '../../src/cause.js';
import { exportProv } from '../../src/prov.js';
import type { CommitBundle } from '../../src/index.js';
import { createReadSourceRecord, RecordFrame, SharedMemory } from '../../src/write.js';
import type { ReadSourceSnapshot } from '../../src/write.js';

const address = { logRunId: 'observed-run', drillPath: [] };
const context = () => ({ signal: new AbortController().signal });
function commit(runtimeStageId: string, idx: number, path: string, value: unknown): CommitBundle {
  return {
    idx,
    runtimeStageId,
    stageId: runtimeStageId.split('#')[0],
    stage: runtimeStageId.split('#')[0],
    trace: [{ path, verb: 'set', readKeys: [] }],
    overwrite: { [path]: value },
    updates: {},
    redactedPaths: [],
  };
}
const log = [commit('first#0', 0, 'n', 1), commit('later#1', 1, 'n', 2), commit('reader#2', 2, 'out', 3)];
function book(
  source: ReadSourceSnapshot['occurrences'][number]['source'] = { kind: 'committed', commitIdx: 0 },
): ReadSourceSnapshot {
  return {
    version: 1,
    address,
    segment: 1,
    status: source.kind === 'unavailable' ? 'partial' : 'captured',
    occurrences: [
      {
        ordinal: 1,
        runtimeStageId: 'reader#2',
        attemptId: 'reader#2@1',
        attemptStatus: 'known',
        frame: 1,
        key: 'n',
        stateAddress: [],
        source,
        disposition: 'released',
      },
    ],
    gaps: [],
    limits: { maxOccurrences: 32, maxPerExecution: 32, maxBytes: 16384, maxOrigins: 32, maxStaging: 32 },
  };
}
function sourceEvidence(record: unknown = book()) {
  return { record, executions: [{ runtimeStageId: 'reader#2', stateAddress: [], attemptIds: ['reader#2@1'] }] };
}
function scope(readSources: unknown = sourceEvidence()): RecordScope {
  return {
    address,
    commitLog: log,
    initialState: { n: 0 },
    reads: { 'first#0': [], 'later#1': [], 'reader#2': ['n'] },
    attention: {},
    controlDeps: {},
    complete: true,
    readSources,
  } as RecordScope;
}
function ids(g: ReturnType<typeof createRecordGraph>) {
  return {
    first: g.nodeId(address, { runtimeStageId: 'first#0', commitIdx: 0, key: 'n' }),
    later: g.nodeId(address, { runtimeStageId: 'later#1', commitIdx: 1, key: 'n' }),
    reader: g.nodeId(address, { runtimeStageId: 'reader#2', commitIdx: 2 }),
    output: g.nodeId(address, { runtimeStageId: 'reader#2', commitIdx: 2, key: 'out' }),
  };
}

describe('authorized exact root source evidence', () => {
  it('uses the observed committed source instead of the temporal candidate in both directions', async () => {
    const g = createRecordGraph([scope()]),
      id = ids(g);
    expect(await g.parents(id.reader, context())).toEqual({
      edges: [
        {
          nodeId: id.first,
          kind: 'data',
          attribution: 'recorded-read',
          evidence: ['commit:0', 'read:1', 'reader#2@1'],
        },
      ],
      complete: true,
    });
    expect((await g.children(id.first, context())).edges).toContainEqual({
      nodeId: id.reader,
      kind: 'data',
      attribution: 'recorded-read',
      evidence: ['commit:0', 'read:1', 'reader#2@1'],
    });
    expect((await g.children(id.later, context())).edges).toEqual([]);
  });

  it('uses the same exact edges through the public explanation walker', async () => {
    const g = createRecordGraph([
      {
        ...scope(),
        attention: { 'first#0': [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: ['proof:first'] }] },
      },
    ]);
    const result = await explain(g, ids(g).reader);
    expect(result.rootCause).toBe(ids(g).first);
    expect(result.confidence).toBe('complete');
    expect(result.path).toEqual([ids(g).reader, ids(g).first]);
  });

  it('keeps maximum canonical attempt IDs within public evidence limits', async () => {
    const runtimeStageId = 'r'.repeat(1020) + '#2',
      attemptId = runtimeStageId + '@1';
    const record = { ...book(), occurrences: [{ ...book().occurrences[0], runtimeStageId, attemptId }] };
    const g = createRecordGraph([
      {
        ...scope({ record, executions: [{ runtimeStageId, stateAddress: [], attemptIds: [attemptId] }] }),
        commitLog: [...log.slice(0, 2), { ...log[2], runtimeStageId }],
        reads: { 'first#0': [], 'later#1': [], [runtimeStageId]: ['n'] },
        attention: { 'first#0': [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: ['proof:first'] }] },
      },
    ]);
    const selected = g.nodeId(address, { runtimeStageId, commitIdx: 2 });
    expect((await explain(g, selected)).rootCause).toBe(ids(g).first);
  });

  it('does not promote an exact stage read into per-write or semantic derivation', async () => {
    const g = createRecordGraph([scope()]),
      id = ids(g);
    expect((await g.parents(id.output, context())).edges).toEqual([]); // captured empty prefix excludes n
    const withPrefix = { ...log[2], trace: [{ path: 'out', verb: 'set' as const, readKeys: ['n'] }] };
    const qualified = createRecordGraph([{ ...scope(), commitLog: [...log.slice(0, 2), withPrefix] }]);
    expect((await qualified.parents(ids(qualified).output, context())).edges).toEqual([
      expect.objectContaining({ nodeId: ids(qualified).first, attribution: 'stage' }),
    ]);
    expect((await qualified.gaps(ids(qualified).output, context())).map((gap) => gap.code)).toContain('conservative');
  });

  it('refuses invented qualified writes instead of treating them as complete leaves', async () => {
    const g = createRecordGraph([scope()]);
    const invented = g.nodeId(address, { runtimeStageId: 'reader#2', commitIdx: 2, key: 'never-written' });
    expect((await g.parents(invented, context())).complete).toBe(false);
    expect((await g.gaps(invented, context())).map((gap) => gap.code)).toContain('invalid-data');
  });

  it('accepts a proven scalar base as an observed terminus without inventing a commit', async () => {
    const g = createRecordGraph([scope(sourceEvidence(book({ kind: 'base', base: 1 })))]);
    expect(await g.parents(ids(g).reader, context())).toEqual({ edges: [], complete: true });
  });

  it.each([
    ['future/self commit', () => sourceEvidence(book({ kind: 'committed', commitIdx: 2 }))],
    [
      'foreign log',
      () => ({ ...sourceEvidence(), record: { ...book(), address: { ...address, logRunId: 'foreign' } } }),
    ],
    ['missing owner', () => ({ ...sourceEvidence(), executions: [] })],
    [
      'wrong namespace',
      () => ({
        ...sourceEvidence(),
        executions: [{ runtimeStageId: 'reader#2', stateAddress: ['elsewhere'], attemptIds: ['reader#2@1'] }],
      }),
    ],
    [
      'wrong attempt',
      () => ({
        ...sourceEvidence(),
        executions: [{ runtimeStageId: 'reader#2', stateAddress: [], attemptIds: ['reader#2@2'] }],
      }),
    ],
    [
      'duplicate owner',
      () => ({ ...sourceEvidence(), executions: [...sourceEvidence().executions, ...sourceEvidence().executions] }),
    ],
    [
      'unknown attempt',
      () => ({
        ...sourceEvidence(),
        record: {
          ...book(),
          occurrences: [{ ...book().occurrences[0], attemptId: undefined, attemptStatus: 'unavailable' }],
        },
      }),
    ],
  ])('withholds %s without falling back to a candidate', async (_name, evidence) => {
    const g = createRecordGraph([scope(evidence())]);
    expect((await g.parents(ids(g).reader, context())).edges).toEqual([]);
    expect((await g.gaps(ids(g).reader, context())).length).toBeGreaterThan(0);
  });

  it.each([
    { kind: 'staged' as const, frame: 1, generation: 1 },
    { kind: 'unavailable' as const, reason: 'composite-unsupported' as const },
    { kind: 'unavailable' as const, reason: 'redacted' as const },
  ])('leaves unsupported source $kind unknown', async (source) => {
    const g = createRecordGraph([scope(sourceEvidence(book(source)))]);
    expect((await g.parents(ids(g).reader, context())).edges).toEqual([]);
    expect((await g.gaps(ids(g).reader, context())).length).toBeGreaterThan(0);
  });

  it('preserves unavailable and capture-limit categories without candidate fallback', async () => {
    for (const [reason, code] of [
      ['capture-failed', 'unavailable'],
      ['undefined-presence-unknown', 'unavailable'],
      ['untracked-write', 'untracked-input'],
      ['budget-exhausted', 'truncated'],
    ] as const) {
      const g = createRecordGraph([scope(sourceEvidence(book({ kind: 'unavailable', reason })))]);
      expect((await g.parents(ids(g).reader, context())).edges).toEqual([]);
      expect((await g.gaps(ids(g).reader, context())).map((gap) => gap.code)).toContain(code);
    }
  });

  it('rejects non-scalar and redacted native references', async () => {
    for (const value of [{ secret: 'PAYLOAD' }, ['PAYLOAD']]) {
      const g = createRecordGraph([{ ...scope(), commitLog: [commit('first#0', 0, 'n', value), ...log.slice(1)] }]);
      expect((await g.parents(ids(g).reader, context())).edges).toEqual([]);
      expect(JSON.stringify(await g.gaps(ids(g).reader, context()))).not.toContain('PAYLOAD');
    }
    const g = createRecordGraph([{ ...scope(), commitLog: [{ ...log[0], redactedPaths: ['n'] }, ...log.slice(1)] }]);
    expect((await g.parents(ids(g).reader, context())).edges).toEqual([]);
  });

  it('never invokes source getters, and keeps already admitted structural control', async () => {
    const get = vi.fn(() => {
      throw new Error('PRIVATE');
    });
    const evidence = Object.defineProperty({}, 'record', { get, enumerable: true });
    const g = createRecordGraph([{ ...scope(evidence), controlDeps: { 'reader#2': { deciderId: 'first#0' } } }]);
    expect((await g.parents(ids(g).reader, context())).edges).toEqual([expect.objectContaining({ kind: 'control' })]);
    expect(get).not.toHaveBeenCalled();
    expect(JSON.stringify(await g.gaps(ids(g).reader, context()))).not.toContain('PRIVATE');
  });

  it('forwards explicitly authorized stored evidence without parsing opaque notes', async () => {
    const entries = [
      { kind: 'opened', address, at: 0, initialState: { n: 0 } },
      ...log.map((bundle) => ({ kind: 'commit', address, at: 0, bundle })),
      { kind: 'closed', address, at: 0, outcome: 'ok', commits: 3 },
    ];
    const { address: _address, commitLog: _log, complete: _complete, ...evidence } = scope();
    const g = createStoredRecordGraph({ loadLog: () => ({ entries, ...evidence }) });
    expect((await g.parents(ids(g).reader, context())).edges[0]?.nodeId).toBe(ids(g).first);
  });

  it('adds standard PROV usage only for exact entity joins and preserves original occurrence ordinals', async () => {
    const result = await exportProv(scope(), { base: 'urn:test:' });
    const activity = result.document['@graph'].filter((node) => node['prov:used']);
    expect(activity).toEqual([
      expect.objectContaining({ 'prov:used': { '@id': expect.stringContaining('/write/0/0/') } }),
    ]);
    expect(result.document['@graph']).toContainEqual(
      expect.objectContaining({ 'ft:ordinal': 1, 'ft:attemptId': 'reader#2@1' }),
    );
    expect(JSON.stringify(result)).not.toContain('prov:wasDerivedFrom');
    const unsupported = await exportProv(scope(sourceEvidence(book({ kind: 'staged', frame: 1, generation: 1 }))), {
      base: 'urn:test:',
    });
    expect(unsupported.document['@graph'].some((node) => node['prov:used'])).toBe(false);
  });

  it('consumes a source produced by the native writer and preserves repeat order', async () => {
    const heap = new SharedMemory(undefined, { n: 0 });
    const native = createReadSourceRecord(heap, address);
    const frame = new RecordFrame(heap, native.log);
    frame.write(['n'], 9, 'set');
    frame.commit(() => ({ stage: 'First', stageId: 'first', runtimeStageId: 'first#0' }));
    frame.release();
    frame.readWithSource([], 'n', { runtimeStageId: 'reader#1', attemptId: 'reader#1@1' });
    frame.readWithSource([], 'n', { runtimeStageId: 'reader#1', attemptId: 'reader#1@1' });
    frame.write(['out'], 10, 'set');
    frame.commit(() => ({ stage: 'Reader', stageId: 'reader', runtimeStageId: 'reader#1' }));
    frame.release();
    const snapshot = native.snapshot();
    const nativeScope: RecordScope = {
      address,
      commitLog: native.log.list(),
      initialState: native.log.getInitialState(),
      reads: { 'first#0': [], 'reader#1': ['n'] },
      attention: {},
      controlDeps: {},
      complete: true,
      readSources: {
        record: snapshot,
        executions: [{ runtimeStageId: 'reader#1', stateAddress: [], attemptIds: ['reader#1@1'] }],
      },
    };
    const g = createRecordGraph([nativeScope]);
    const reader = g.nodeId(address, { runtimeStageId: 'reader#1', commitIdx: 1 });
    const parents = await g.parents(reader, context());
    expect(await g.gaps(reader, context())).toEqual([]);
    expect(parents.complete).toBe(true);
    expect(parents.edges.map((edge) => edge.evidence.find((item) => item.startsWith('read:')))).toEqual([
      'read:1',
      'read:2',
    ]);
    const result = await exportProv(nativeScope, { base: 'urn:test:' });
    expect(
      result.document['@graph']
        .filter((node) => node['ft:basis'] === 'recorded-source')
        .map((node) => node['ft:ordinal']),
    ).toEqual([1, 2]);
    native.retire();
  });

  it('retains supported observations from a partial snapshot without upgrading completeness', async () => {
    const partial = { ...book(), status: 'partial', gaps: [{ reason: 'budget-exhausted', count: 3, exact: true }] };
    const g = createRecordGraph([scope(sourceEvidence(partial))]);
    expect((await g.parents(ids(g).reader, context())).edges).toHaveLength(1);
    expect((await g.parents(ids(g).reader, context())).complete).toBe(false);
    expect((await g.gaps(ids(g).reader, context())).map((gap) => gap.code)).toContain('not-collected');
  });

  it('keeps unproved child/resume segments unknown', async () => {
    const childAddress = { ...address, drillPath: ['mount#3'] };
    const child = createRecordGraph([
      { ...scope(sourceEvidence({ ...book(), address: childAddress })), address: childAddress },
    ]);
    const id = child.nodeId(childAddress, { runtimeStageId: 'reader#2', commitIdx: 2 });
    expect((await child.gaps(id, context())).map((gap) => gap.code)).toContain('scope-boundary');
    const resumed = createRecordGraph([scope(sourceEvidence({ ...book(), segment: 2 }))]);
    expect((await resumed.parents(ids(resumed).reader, context())).edges).toEqual([]);
    expect((await resumed.gaps(ids(resumed).reader, context())).map((gap) => gap.code)).toContain('unsupported');
  });

  it('withholds evidence on bounded admission and bounds public adjacency', async () => {
    const g = createRecordGraph([scope()], { maxFields: 50 });
    expect((await g.parents(ids(g).reader, context())).edges).toEqual([]);
    expect((await g.gaps(ids(g).reader, context())).map((gap) => gap.code)).toContain('node-limit');
    const repeated = { ...book(), occurrences: [book().occurrences[0], { ...book().occurrences[0], ordinal: 2 }] };
    const bounded = createRecordGraph([scope(sourceEvidence(repeated))], { maxEdges: 1 });
    expect((await bounded.parents(ids(bounded).reader, context())).edges).toHaveLength(1);
    expect((await bounded.gaps(ids(bounded).reader, context())).map((gap) => gap.code)).toContain('edge-limit');
  });

  it('does not reinterpret delimiter-bearing literal source keys or emit unencodable PROV', async () => {
    for (const key of ['n\u001ftail', '\ud800']) {
      const record = {
        ...book({ kind: 'base', base: 1 }),
        occurrences: [{ ...book({ kind: 'base', base: 1 }).occurrences[0], key }],
      };
      const source = { ...scope(sourceEvidence(record)), initialState: { [key]: 5 } };
      const result = await exportProv(source, { base: 'urn:test:' });
      expect(result.document['@graph'].some((node) => node['prov:used'])).toBe(false);
      expect(result.gaps.some((gap) => gap.code === 'unsupported' || gap.code === 'invalid-data')).toBe(true);
    }
  });

  it('exports a scalar base without values and omits usage when its entity is hidden or capped', async () => {
    const source = scope(sourceEvidence(book({ kind: 'base', base: 1 })));
    const result = await exportProv(source, { base: 'urn:test:' });
    expect(result.document['@graph']).toContainEqual(
      expect.objectContaining({ 'ft:initial': true, 'ft:valueAvailability': 'not-exported' }),
    );
    expect(result.document['@graph'].some((node) => node['prov:used'])).toBe(true);
    const hidden = await exportProv(
      { ...source, commitLog: [{ ...log[0], redactedPaths: ['n'] }, ...log.slice(1)] },
      { base: 'urn:test:' },
    );
    expect(hidden.document['@graph'].some((node) => node['prov:used'])).toBe(false);
    const capped = await exportProv(source, { base: 'urn:test:', maxNodes: 1 });
    expect(capped.document['@graph'].some((node) => node['prov:used'])).toBe(false);
  });

  it('keeps absent and undefined source seams byte-identical for both consumers', async () => {
    const { readSources: _sources, initialState: _base, ...legacy } = scope();
    const a = createRecordGraph([legacy]),
      b = createRecordGraph([{ ...legacy, readSources: undefined } as RecordScope]);
    expect(await a.parents(ids(a).reader, context())).toEqual(await b.parents(ids(b).reader, context()));
    expect(await exportProv(legacy, { base: 'urn:test:' })).toEqual(
      await exportProv({ ...legacy, readSources: undefined }, { base: 'urn:test:' }),
    );
  });
});
