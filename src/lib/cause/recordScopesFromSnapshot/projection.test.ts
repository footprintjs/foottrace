import { describe, expect, it, vi } from 'vitest';
import { createRecordGraph, recordScopesFromSnapshot } from '../../../cause.js';
import { commitValueAt, isCommitBundle } from '../../../index.js';

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
  it('detaches each initial-state occurrence and matches the reopened snapshot', () => {
    const shared = { check: 47 };
    const live = { ...snapshot(), initialState: { left: shared, right: shared } };
    const saved = JSON.parse(JSON.stringify(live));
    const projected = recordScopesFromSnapshot(live);
    expect(projected).toEqual(recordScopesFromSnapshot(saved));
    const seed = projected.scopes[0].initialState!;
    expect(seed.left).not.toBe(seed.right);
    shared.check = 13;
    expect(seed).toEqual({ left: { check: 47 }, right: { check: 47 } });
  });

  it('charges both initial-state occurrences to the same projection allowance', () => {
    const samples = Array(25_000).fill(42);
    expect(recordScopesFromSnapshot({ ...snapshot(), initialState: { samples } }).scopes).toHaveLength(1);
    const live = { ...snapshot(), initialState: { left: samples, right: samples } };
    for (const input of [live, JSON.parse(JSON.stringify(live))]) {
      expect(recordScopesFromSnapshot(input)).toEqual({ scopes: [], gaps: [{ code: 'node-limit' }] });
    }
  });

  it('still refuses cycles and accessors in initial state, and repeated objects in commit payloads', () => {
    const cycle: { parent?: object } = {};
    cycle.parent = cycle;
    const getter = vi.fn(() => 47);
    const accessor = Object.defineProperty({}, 'check', { enumerable: true, get: getter });
    const shared = { check: 47 };
    const commit = { ...snapshot().commitLog[0], overwrite: { left: shared, right: shared } };
    for (const input of [
      { ...snapshot(), initialState: cycle },
      { ...snapshot(), initialState: { left: accessor, right: accessor } },
      { ...snapshot(), commitLog: [commit] },
    ]) {
      expect(recordScopesFromSnapshot(input)).toEqual({ scopes: [], gaps: [{ code: 'invalid-data' }] });
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it('projects a flat runtime scope and opens the same nodes in the graph', async () => {
    const { scopes, gaps } = recordScopesFromSnapshot(snapshot());
    expect(gaps).toEqual([]);
    expect(scopes).toHaveLength(1);
    const graph = createRecordGraph(scopes);
    expect(await graph.openScope(address(), { signal: new AbortController().signal })).toEqual([
      graph.nodeId(address(), { runtimeStageId: 'start#0', commitIdx: 0 }),
    ]);
  });

  it.each([
    ['accessor', 'invalid-data'],
    ['overlong targets', 'node-limit'],
    ['public name with unrelated payload', 'untracked-input'],
  ] as const)('keeps snapshots usable with outside-input %s', async (kind, expected) => {
    const get = vi.fn(() => {
      throw new Error('outside-input accessor ran');
    });
    const writer = {
      ...bundle(start.runtimeStageId, 0),
      stage: 'start',
      trace: [{ path: 'price', verb: 'set' }],
      overwrite: { price: 5 },
    };
    const continuation = { ...bundle(start.runtimeStageId, 1), stage: 'start', phase: 'repeat' };
    Object.defineProperty(continuation, 'outsideInputs', { get, enumerable: true });
    if (kind === 'accessor') {
      Object.defineProperty(writer, 'outsideInputs', { get, enumerable: true });
    } else {
      const value =
        kind === 'overlong targets'
          ? { call: { targets: new Array(100_001) } }
          : Object.defineProperty({ declared: ['clock'] }, 'payload', { get, enumerable: true });
      Object.defineProperty(writer, 'outsideInputs', { value, enumerable: true });
    }
    const { scopes, gaps } = recordScopesFromSnapshot({ ...snapshot(), commitLog: [writer, continuation] });
    expect(gaps).toEqual([]);
    expect(scopes).toHaveLength(1);
    const commits = scopes[0].commitLog.filter(isCommitBundle);
    expect(commits).toHaveLength(2);
    expect(commitValueAt(commits, 1, 'price')).toBe(5);
    expect(commits[0].outsideInputs).toEqual(
      kind === 'public name with unrelated payload' ? { declared: ['clock'] } : undefined,
    );
    expect(commits[1]).not.toHaveProperty('outsideInputs');
    const graph = createRecordGraph(scopes);
    const node = graph.nodeId(address(), { runtimeStageId: start.runtimeStageId, commitIdx: 0, key: 'price' });
    const coverage = await graph.gaps(node, { signal: new AbortController().signal });
    expect(coverage.map(({ code }) => code)).toContain(expected);
    expect(get).not.toHaveBeenCalled();
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

  it.each([
    [31, 1, true],
    [32, 1, false],
    [0, 256, true],
    [0, 257, false],
  ])(
    'opens a projection of %i children and %i commits with the documented graph limits',
    async (children, commits, fitsDefault) => {
      const ids = Array.from({ length: children }, (_, index) => `mount#${index + 1}`);
      const { scopes } = recordScopesFromSnapshot({
        ...snapshot(),
        commitLog: Array.from({ length: commits }, (_, index) => bundle(start.runtimeStageId, index)),
        executionTree: { ...start, children: ids.map(mount) },
        subflowResults: Object.fromEntries(ids.map((id) => [id, { treeContext: context([id]) }])),
      });
      expect(scopes).toHaveLength(children + 1);
      const options = { maxScopes: 256, maxCommits: 4096 };
      const query = { signal: new AbortController().signal };
      await expect(createRecordGraph(scopes, options).openScope(address(), query)).resolves.toHaveLength(commits);
      const openWithDefault = createRecordGraph(scopes).openScope(address(), query);
      if (fitsDefault) await expect(openWithDefault).resolves.toHaveLength(commits);
      else await expect(openWithDefault).rejects.toMatchObject({ code: 'node-limit' });
    },
  );

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
