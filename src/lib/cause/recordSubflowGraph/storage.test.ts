import { describe, expect, it, vi } from 'vitest';
import { createRecordGraph, createStoredRecordGraph, explain } from '../../../cause.js';
import type { RecordScope, RecordSubflows, StoredRecordScope } from '../../../cause.js';
import type { CommitBundle, LogAddress } from '../../../index.js';

const parent = { logRunId: 'storage-run', drillPath: [] as string[] };
const child = { logRunId: 'storage-run', drillPath: ['mount#0'] };
const ctx = () => ({ signal: new AbortController().signal });
const key = (address: LogAddress) => JSON.stringify(address);
function commit(runtimeStageId: string, idx: number, path: string, readKeys: string[] = []): CommitBundle {
  return {
    idx,
    runtimeStageId,
    stage: runtimeStageId,
    stageId: runtimeStageId,
    trace: [{ path, verb: 'set', readKeys }],
    overwrite: { [path]: 'synthetic-state' },
    updates: {},
    redactedPaths: [],
  };
}
function scope(address: LogAddress, commitLog: CommitBundle[]): RecordScope {
  return {
    address,
    commitLog,
    complete: true,
    attention: {},
    controlDeps: {},
    reads: Object.fromEntries(
      commitLog.map((row) => [row.runtimeStageId, row.trace.flatMap((entry) => entry.readKeys ?? [])]),
    ),
  };
}
function fixture() {
  const inventory: RecordSubflows = {
    version: 1,
    status: 'partial',
    collections: [],
    mounts: [
      {
        runtimeStageId: 'mount#0',
        child,
        outputHandoff: {
          version: 1,
          attribution: 'observed-read-prefix',
          parent: { address: parent, runtimeStageId: 'mount#0', commitIdx: 0 },
          child: { address: child, beforeCommitIdx: 1 },
          writes: [{ path: 'final', reads: ['value'] }],
          status: 'captured',
          limitations: [],
        },
      },
    ],
  };
  const rootBundle = commit('mount#0', 0, 'final');
  return {
    rootBundle,
    root: { ...scope(parent, [rootBundle]), subflows: inventory },
    nested: {
      ...scope(child, [commit('mount/value#1', 0, 'value')]),
      subflows: { version: 1 as const, status: 'partial' as const, mounts: [], collections: [] },
    },
  };
}
function stored(scope: RecordScope): StoredRecordScope {
  return {
    reads: scope.reads,
    controlDeps: scope.controlDeps,
    attention: scope.attention,
    subflows: scope.subflows,
    entries: [
      { kind: 'opened', at: 0, address: scope.address, initialState: {} },
      ...scope.commitLog.map((bundle) => ({ kind: 'commit', at: 1, address: scope.address, bundle })),
      { kind: 'closed', at: 2, address: scope.address, outcome: 'ok', commits: scope.commitLog.length },
    ],
  };
}

describe('authorized storage subflow projection', () => {
  it('shares admitted parent/gap inspection and loads only the exact referenced native logs', async () => {
    const f = fixture();
    const records = new Map([
      [key(parent), stored(f.root)],
      [key(child), stored(f.nested)],
    ]);
    const loadLog = vi.fn((address: LogAddress) => {
      const found = records.get(key(address));
      if (!found) throw new Error('not authorized');
      return found;
    });
    const graph = createStoredRecordGraph({ loadLog });
    const selected = graph.nodeId(parent, { runtimeStageId: 'mount#0', commitIdx: 0, key: 'final' });
    const writer = graph.nodeId(child, { runtimeStageId: 'mount/value#1', commitIdx: 0, key: 'value' });
    const result = await explain(graph, selected, { includeBackward: true });
    expect(result.backward?.nodes).toContain(writer);
    expect(result.backward?.confidence).toBe('incomplete');
    expect(loadLog.mock.calls.map(([address]) => key(address))).toEqual([key(parent), key(child)]);
    expect(result.backward?.gaps.some((gap) => gap.evidence.includes('subflow:output:0'))).toBe(true);
  });

  it('keeps a denied child unknown without exposing its host error', async () => {
    const f = fixture();
    const loadLog = vi.fn((address: LogAddress) => {
      if (key(address) === key(parent)) return stored(f.root);
      throw new Error('SYNTHETIC_PRIVATE_HOST_ERROR');
    });
    const graph = createStoredRecordGraph({ loadLog });
    const selected = graph.nodeId(parent, { runtimeStageId: 'mount#0', commitIdx: 0, key: 'final' });
    const result = await explain(graph, selected, { includeBackward: true });
    const gaps = result.backward!.gaps;
    expect(loadLog.mock.calls.map(([address]) => key(address))).toEqual([key(parent), key(child)]);
    expect(gaps.some((gap) => gap.code === 'unavailable')).toBe(true);
    expect(gaps.some((gap) => gap.code === 'scope-boundary')).toBe(true);
    expect(JSON.stringify(gaps)).not.toContain('SYNTHETIC_PRIVATE_HOST_ERROR');
  });

  it('does not let unknown forward inventory erase supported local backward evidence', async () => {
    const local = scope(parent, [commit('local#0', 0, 'value')]);
    const graph = createRecordGraph([
      {
        ...local,
        subflows: { version: 1, status: 'partial', mounts: [], collections: [] },
        attention: { 'local#0': [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: ['proof:local'] }] },
      },
    ]);
    const selected = graph.nodeId(parent, { runtimeStageId: 'local#0', commitIdx: 0, key: 'value' });
    const result = await explain(graph, selected, { includeBackward: true });
    expect(result.backward?.confidence).toBe('complete');
    expect(result.backward?.gaps).toEqual([]);
    expect(result.rootCause).toBe(selected);
    expect(result.impact.confidence).toBe('incomplete');
    expect(result.confidence).toBe('incomplete');
  });

  it('keeps boundary references when local and cross-scope evidence share a conservative gap', async () => {
    const f = fixture();
    delete f.rootBundle.trace[0].readKeys;
    const graph = createRecordGraph([f.root, f.nested]);
    const selected = graph.nodeId(parent, { runtimeStageId: 'mount#0', commitIdx: 0, key: 'final' });
    const result = await explain(graph, selected, { includeBackward: true });
    expect(result.backward?.gaps.find((gap) => gap.code === 'conservative')?.evidence).toContain('subflow:output:0');
  });

  it('keeps a legacy child-only scope local without discovering an optional parent', async () => {
    const local = scope(child, [commit('local#1', 0, 'value')]);
    const loadLog = vi.fn((address: LogAddress) => {
      assertSameRequestedScope(address);
      return stored(local);
    });
    function assertSameRequestedScope(address: LogAddress) {
      expect(key(address)).toBe(key(child));
    }
    const graph = createStoredRecordGraph({ loadLog });
    const selected = graph.nodeId(child, { runtimeStageId: 'local#1', commitIdx: 0, key: 'value' });
    // This direct child query has no declared subflow port and no native seed crossing.
    expect((await graph.children(selected, ctx())).complete).toBe(true);
    expect(loadLog.mock.calls.map(([address]) => key(address))).toEqual([key(child)]);
  });

  it('keeps admitted stored local edges when the optional subflow field is an accessor', async () => {
    const local = scope(parent, [commit('source#0', 0, 'input'), commit('use#1', 1, 'final', ['input'])]);
    let calls = 0;
    const loaded = Object.defineProperty(stored(local), 'subflows', {
      enumerable: true,
      get() {
        calls++;
        throw new Error('SYNTHETIC_PRIVATE_METADATA');
      },
    });
    const graph = createStoredRecordGraph({ loadLog: () => loaded });
    const selected = graph.nodeId(parent, { runtimeStageId: 'use#1', commitIdx: 1, key: 'final' });
    const source = graph.nodeId(parent, { runtimeStageId: 'source#0', commitIdx: 0, key: 'input' });
    expect((await graph.parents(selected, ctx())).edges.some((edge) => edge.nodeId === source)).toBe(true);
    expect(calls).toBe(0);
    const gaps = await graph.gaps(selected, ctx());
    expect(gaps.some((gap) => gap.code === 'invalid-data')).toBe(true);
    expect(JSON.stringify(gaps)).not.toContain('SYNTHETIC_PRIVATE_METADATA');
  });

  it('does not load a child after cancellation of an already admitted graph', async () => {
    const f = fixture();
    const loadLog = vi.fn((address: LogAddress) => (key(address) === key(parent) ? stored(f.root) : stored(f.nested)));
    const graph = createStoredRecordGraph({ loadLog });
    await graph.openScope(parent, ctx());
    const controller = new AbortController();
    controller.abort();
    const selected = graph.nodeId(parent, { runtimeStageId: 'mount#0', commitIdx: 0, key: 'final' });
    const result = await graph.parents(selected, { signal: controller.signal });
    expect(result.complete).toBe(false);
    expect(loadLog.mock.calls.map(([address]) => key(address))).toEqual([key(parent)]);
  });
});
