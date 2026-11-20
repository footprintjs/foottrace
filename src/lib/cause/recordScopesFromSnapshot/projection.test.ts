import { describe, expect, it, vi } from 'vitest';
import { createRecordGraph, recordScopesFromSnapshot } from '../../../cause.js';

const runId = 'run';
const address = (...drillPath: string[]) => ({ logRunId: runId, drillPath });
const start = { runtimeStageId: 'start#0' };
const bundle = (id: string, idx: number) => ({
  runtimeStageId: id,
  stageId: id.split('#')[0],
  idx,
  trace: [],
  overwrite: {},
  updates: {},
  redactedPaths: [],
});
const snapshot = () => ({
  logAddress: address(),
  commitLog: [bundle(start.runtimeStageId, 0)],
  initialState: {},
  executionTree: { ...start, stageReads: {}, undefinedReadKeys: [] },
});
const mount = (id: string) => ({ runtimeStageId: id, subflowId: 'child' });
const context = (path: string[], stageContexts = start) => ({
  logAddress: address(...path),
  history: [],
  stageContexts,
});

function nested(depth: number) {
  const results: Record<string, unknown> = {};
  const ids = Array.from({ length: depth }, (_, index) => `mount#${index}`);
  for (let index = 0; index < depth; index++)
    results[ids[index]] = {
      treeContext: context(ids.slice(0, index + 1), index + 1 < depth ? mount(ids[index + 1]) : start),
    };
  return { ...snapshot(), executionTree: depth ? mount(ids[0]) : start, subflowResults: results };
}

describe('recordScopesFromSnapshot', () => {
  it('projects a flat runtime scope and opens the same nodes in the graph', async () => {
    const { scopes, gaps } = recordScopesFromSnapshot(snapshot());
    expect(gaps).toEqual([]);
    expect(scopes).toHaveLength(1);
    const graph = createRecordGraph(scopes);
    expect(await graph.openScope(address(), { signal: new AbortController().signal })).toEqual([
      graph.nodeId(address(), { runtimeStageId: 'start#0', commitIdx: 0 }),
    ]);
  });

  it('uses exact invocation stamps and preserves missing handoffs as scope boundaries', () => {
    const exact = { treeContext: context(['child#1']) };
    const root = { ...snapshot(), executionTree: { ...start, children: [mount('child#1')] } };
    const projected = recordScopesFromSnapshot({ ...root, subflowResults: { child: exact, 'child#1': exact } });
    expect(projected.scopes.map((scope) => scope.address)).toEqual([address(), address('child#1')]);
    expect(projected.scopes[0].subflows?.mounts).toEqual([{ runtimeStageId: 'child#1', child: address('child#1') }]);
    expect(projected.scopes[1].complete).toBe(false);
    expect(projected.gaps).toEqual([{ code: 'scope-boundary', address: address('child#1') }]);

    for (const results of [{ child: exact }, { 'child#1': { treeContext: context(['wrong#1']) } }]) {
      const refused = recordScopesFromSnapshot({ ...root, subflowResults: results });
      expect(refused.scopes).toHaveLength(1);
      expect(refused.scopes[0].subflows?.mounts).toEqual([]);
      expect(refused.gaps).toEqual(projected.gaps);
    }
  });

  it('preserves read keys across serialization without inspecting their stored values', () => {
    const base = snapshot();
    const step = { ...base.executionTree, stageReads: { b: 1, a: undefined }, undefinedReadKeys: ['a'] };
    const live = { ...base, executionTree: step };
    expect(recordScopesFromSnapshot(live)).toEqual(recordScopesFromSnapshot(JSON.parse(JSON.stringify(live))));
    const getter = vi.fn();
    Object.defineProperty(step.stageReads, 'c', { get: getter, enumerable: true });
    expect(recordScopesFromSnapshot(live).scopes[0].reads).toEqual({ 'start#0': ['a', 'b', 'c'] });
    expect(getter).not.toHaveBeenCalled();
  });

  it('keeps only the optional recorded control dependencies for admitted IDs', () => {
    const source = snapshot();
    const projected = recordScopesFromSnapshot({
      ...source,
      executionTree: { ...start, next: { runtimeStageId: 'next#1' } },
      controlDeps: { 'next#1': { deciderId: 'start#0' }, off: { deciderId: 'start#0' } },
    });
    expect(projected.scopes[0].controlDeps).toEqual({ 'next#1': { deciderId: 'start#0' } });
  });

  it('contains throwing and revoked proxies without evaluating getters or thrown values', () => {
    const getter = vi.fn();
    const withGetter = Object.defineProperty(snapshot(), 'commitLog', { get: getter });
    const thrown = Object.defineProperty({}, 'code', { get: getter });
    const proxy = new Proxy(snapshot(), {
      getOwnPropertyDescriptor() {
        throw thrown;
      },
    });
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    const cyclical: { runtimeStageId: string; next?: object } = { ...start };
    cyclical.next = cyclical;
    for (const input of [
      withGetter,
      proxy,
      { ...snapshot(), commitLog: revoked.proxy },
      { ...snapshot(), executionTree: cyclical },
    ])
      expect(recordScopesFromSnapshot(input)).toEqual({ scopes: [], gaps: [{ code: 'invalid-data' }] });
    expect(getter).not.toHaveBeenCalled();
    expect(recordScopesFromSnapshot({ commitLog: [] })).toEqual({ scopes: [], gaps: [{ code: 'not-collected' }] });
  });

  it('bounds a hostile array before reading any element', () => {
    const descriptor = vi.fn(Reflect.getOwnPropertyDescriptor);
    const commitLog = new Proxy(new Array(100_000), { getOwnPropertyDescriptor: descriptor });
    expect(recordScopesFromSnapshot({ ...snapshot(), commitLog })).toEqual({
      scopes: [],
      gaps: [{ code: 'node-limit' }],
    });
    expect(descriptor.mock.calls.map(([, key]) => key)).toEqual(['length']);
  });

  it.each([18, 64])('admits depth 16 and reports each discovered deeper scope through %s', (depth) => {
    const projected = recordScopesFromSnapshot(nested(depth));
    expect(projected.scopes.map((scope) => scope.address.drillPath.length)).toEqual(
      Array.from({ length: 17 }, (_, index) => index),
    );
    expect(projected.gaps.filter(({ code }) => code === 'depth-limit').map(({ depth }) => depth)).toEqual(
      Array.from({ length: depth - 16 }, (_, index) => index + 17),
    );
    expect(projected.scopes.at(-1)?.subflows?.mounts).toEqual([]);
  });

  it('checks adjacent commit limits before reading the log payload', () => {
    const commitLog = Array.from({ length: 4097 }, (_, index) => bundle(`start#${index}`, index));
    const base = snapshot();
    expect(recordScopesFromSnapshot({ ...base, commitLog: commitLog.slice(0, 4096) }).scopes[0].commitLog).toHaveLength(
      4096,
    );
    expect(recordScopesFromSnapshot({ ...base, commitLog }).gaps).toEqual([{ code: 'node-limit' }]);
  });

  it('uses one scope limit across a wide run and never enumerates the result aliases', () => {
    const wide = (children: number) => {
      const ids = Array.from({ length: children }, (_, i) => `mount#${i + 1}`);
      const entries = ids.map((id) => [id, { treeContext: context([id]) }]);
      const keys = vi.fn(() => {
        throw new Error('must not enumerate aliases');
      });
      return {
        input: {
          ...snapshot(),
          executionTree: { ...start, children: ids.map(mount) },
          subflowResults: new Proxy(Object.fromEntries(entries), { ownKeys: keys }),
        },
        keys,
      };
    };
    const at = wide(255);
    expect(recordScopesFromSnapshot(at.input).scopes).toHaveLength(256);
    expect(at.keys).not.toHaveBeenCalled();
    const over = wide(256);
    expect(recordScopesFromSnapshot(over.input)).toEqual({ scopes: [], gaps: [{ code: 'node-limit' }] });
    expect(over.keys).not.toHaveBeenCalled();
  });
});
