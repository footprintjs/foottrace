/** Public-only differential probe. Its named cases are a finite witness, not a universal equivalence proof. */
import type { CauseGraph, GraphContext, RecordGraphOptions, RecordScope } from '../../../src/cause.js';
import type { Attention, CommitBundle } from '../../../src/index.js';

export type CauseAPI = typeof import('../../../src/cause.js');
export interface PublicCase {
  readonly name: string;
  readonly json: string;
}
export const PRIVATE_SENTINEL = 'SYNTHETIC_PRIVATE_STATE_MUST_NOT_LEAVE_RECORD';
const address = { logRunId: 'fixture-run', drillPath: [] as string[] };
const context = (): GraphContext => ({ signal: new AbortController().signal });
const mark = (id: string): Attention => ({ kind: 'error', reason: 'ERROR_RECORDED', evidence: [`proof:${id}`] });

function commit(id: string, index: number, writes: Record<string, string[] | undefined>): CommitBundle {
  return {
    idx: index,
    stage: id,
    stageId: id,
    runtimeStageId: `${id}#${index}`,
    trace: Object.entries(writes).map(([path, readKeys]) => ({
      path,
      verb: 'set',
      ...(readKeys === undefined ? {} : { readKeys }),
    })),
    redactedPaths: [],
    overwrite: Object.fromEntries(Object.keys(writes).map((key) => [key, PRIVATE_SENTINEL])),
    updates: {},
  };
}
function baseScope(overrides: Partial<RecordScope> = {}): RecordScope {
  return {
    address,
    commitLog: [
      commit('a', 0, { a: [] }),
      commit('b', 1, { b: [] }),
      commit('split', 2, { x: ['a'], y: ['a', 'b'] }),
      commit('end', 3, { z: ['x'] }),
    ],
    reads: { 'a#0': [], 'b#1': [], 'split#2': ['a', 'b'], 'end#3': ['x'] },
    attention: { 'a#0': [mark('a')], 'b#1': [mark('b')], 'end#3': [mark('end')] },
    controlDeps: {},
    complete: true,
    ...overrides,
  };
}
function plainGraph(): CauseGraph {
  return {
    parents: () => ({ edges: [], complete: true }),
    children: () => ({ edges: [], complete: true }),
    attention: () => [mark('selected')],
    gaps: () => [],
  };
}
function storedEntries(scope: RecordScope, closed = true): unknown[] {
  return [
    { kind: 'opened', address: scope.address, at: 0, initialState: {} },
    ...scope.commitLog.map((bundle) => ({ kind: 'commit', address: scope.address, at: 1, bundle })),
    ...(closed
      ? [{ kind: 'closed', address: scope.address, at: 2, outcome: 'ok', commits: scope.commitLog.length }]
      : []),
  ];
}
async function settled(work: () => unknown): Promise<unknown> {
  try {
    return { status: 'fulfilled', value: await work() };
  } catch (error) {
    const caught = error as { name?: unknown; message?: unknown; code?: unknown };
    return {
      status: 'rejected',
      name: caught.name,
      message: caught.message,
      ...(caught.code === undefined ? {} : { code: caught.code }),
    };
  }
}
/** The probe owns its process/worker clock; simulated elapsed time makes timeout output deterministic. */
async function monotonic<T>(work: (elapse: (milliseconds: number) => void) => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(performance, 'now');
  let elapsed = 0;
  Object.defineProperty(performance, 'now', { configurable: true, value: () => elapsed });
  try {
    return await work((milliseconds) => {
      elapsed += milliseconds;
    });
  } finally {
    if (descriptor) Object.defineProperty(performance, 'now', descriptor);
    else Reflect.deleteProperty(performance, 'now');
  }
}

export async function capturePublicBehavior(api: CauseAPI): Promise<readonly PublicCase[]> {
  const cases: PublicCase[] = [];
  const add = (name: string, value: unknown) => {
    cases.push({ name, json: JSON.stringify(value) });
  };
  const memory = (overrides: Partial<RecordScope> = {}, options?: RecordGraphOptions) =>
    api.createRecordGraph([baseScope(overrides)], options);
  const node = (graph: ReturnType<typeof memory>, stage: string, index: number, key?: string) =>
    graph.nodeId(address, {
      runtimeStageId: `${stage}#${index}`,
      commitIdx: index,
      ...(key === undefined ? {} : { key }),
    });

  {
    const graph = memory();
    const x = node(graph, 'split', 2, 'x'),
      y = node(graph, 'split', 2, 'y'),
      end = node(graph, 'end', 3, 'z');
    add('record/per-write-separated-identities', {
      x,
      y,
      xParents: await graph.parents(x, context()),
      yParents: await graph.parents(y, context()),
      aChildren: await graph.children(node(graph, 'a', 0, 'a'), context()),
    });
    add('record/per-write-explain', await api.explain(graph, end));
    add(
      'record/per-write-attention-discovery',
      await api.attentionList(graph, { nodeIds: await graph.openScope(address, context()) }),
    );
    add('record/step-conservative', await api.explain(graph, node(graph, 'split', 2)));
  }
  {
    const graph = memory({
      commitLog: [
        commit('seed', 0, { value: [] }),
        commit('decide', 1, {}),
        commit('reader', 2, {}),
        commit('sink', 3, {}),
      ],
      reads: { 'seed#0': [], 'decide#1': ['value'], 'reader#2': ['value'], 'sink#3': [] },
      attention: { 'seed#0': [mark('seed')], 'decide#1': [mark('decision')] },
      controlDeps: { 'reader#2': { deciderId: 'decide#1' }, 'sink#3': { deciderId: 'reader#2' } },
    });
    const seed = node(graph, 'seed', 0, 'value'),
      children = await graph.children(seed, context());
    const reader = children.edges.find((edge) => edge.nodeId.includes('reader'))!.nodeId;
    add('record/readonly-data-and-control', {
      children,
      parents: await graph.parents(reader, context()),
      childrenOfRead: await graph.children(reader, context()),
      explanation: await api.explain(graph, reader),
    });
  }
  {
    const graph = memory({
      commitLog: [
        commit('seed', 0, { a: [] }),
        commit('first', 1, { x: ['a'] }),
        commit('rewrite', 2, { a: [] }),
        commit('later', 3, { y: ['a'] }),
      ],
      reads: { 'seed#0': [], 'first#1': ['a'], 'rewrite#2': [], 'later#3': ['a'] },
      attention: {},
    });
    add('record/historical-value-impact', {
      first: await graph.children(node(graph, 'seed', 0, 'a'), context()),
      replacement: await graph.children(node(graph, 'rewrite', 2, 'a'), context()),
      explainFirst: await api.explain(graph, node(graph, 'seed', 0, 'a')),
    });
  }
  for (const [name, overrides, options] of [
    ['missing-capture', { reads: undefined, attention: undefined, controlDeps: undefined }, undefined],
    ['unfinished', { complete: false }, undefined],
    [
      'untracked',
      { commitLog: [{ ...commit('a', 0, { a: [] }), untrackedSources: ['args' as const] }], reads: { 'a#0': [] } },
      undefined,
    ],
    [
      'redacted',
      { commitLog: [{ ...commit('a', 0, { a: [] }), redactedPaths: ['a'] }], reads: { 'a#0': [] } },
      undefined,
    ],
    ['preparation-limit', {}, { maxCommits: 2 }],
    ['adjacency-limit', {}, { maxEdges: 1 }],
  ] as const) {
    const graph = memory(overrides, options);
    const id = node(graph, 'a', 0, 'a');
    add(`record/${name}`, {
      parents: await graph.parents(id, context()),
      children: await graph.children(id, context()),
      gaps: await graph.gaps(id, context()),
      explanation: await api.explain(graph, id),
    });
  }
  {
    let reads = 0;
    const payload = Object.defineProperty({}, 'a', {
      enumerable: true,
      get() {
        reads++;
        throw new Error(PRIVATE_SENTINEL);
      },
    });
    const graph = memory({ commitLog: [{ ...commit('a', 0, { a: [] }), overwrite: payload }] });
    add('record/payload-getter', { gaps: await graph.gaps(node(graph, 'a', 0, 'a'), context()), getterReads: reads });
    const trap = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('fixture-descriptor-trap');
        },
      },
    );
    const trapped = memory({ commitLog: [trap] });
    add('record/descriptor-trap', await trapped.gaps(node(trapped, 'a', 0, 'a'), context()));
  }
  {
    const scope = baseScope();
    const graph = api.createRecordGraph([scope]);
    const id = node(graph, 'split', 2, 'x');
    const adjacency = await graph.parents(id, context());
    const explanation = await api.explain(graph, id);
    add('record-and-facade/freeze-shapes', {
      adjacency: Object.isFrozen(adjacency),
      edges: Object.isFrozen(adjacency.edges),
      firstEdge: Object.isFrozen(adjacency.edges[0]),
      inputScope: Object.isFrozen(scope),
      inputLog: Object.isFrozen(scope.commitLog),
      result: Object.isFrozen(explanation),
      path: Object.isFrozen(explanation.path),
      impact: Object.isFrozen(explanation.impact),
      impactNodes: Object.isFrozen(explanation.impact.nodes),
      attention: Object.isFrozen(explanation.attention),
    });
    const before = JSON.stringify(adjacency);
    (scope.commitLog[2] as CommitBundle).trace[0].readKeys!.push('b');
    add('record/input-mutation-after-preparation', {
      before,
      after: JSON.stringify(await graph.parents(id, context())),
    });
  }
  {
    const child = { logRunId: 'fixture-run', drillPath: ['mount#4'] };
    const scope = baseScope({ address: child }),
      loads: unknown[] = [];
    const graph = api.createStoredRecordGraph({
      loadLog(requested) {
        loads.push(requested);
        return {
          entries: storedEntries(scope),
          reads: scope.reads,
          attention: scope.attention,
          controlDeps: scope.controlDeps,
        };
      },
    });
    const id = graph.nodeId(child, { runtimeStageId: 'end#3', commitIdx: 3, key: 'z' });
    const beforeLoads = loads.length;
    add('storage/lazy-one-scope', {
      beforeLoads,
      parents: await graph.parents(id, context()),
      gaps: await graph.gaps(id, context()),
      explanation: await api.explain(graph, id),
      loads,
    });
  }
  for (const mode of ['unfinished', 'hole', 'unavailable', 'foreign-scope'] as const) {
    const scope = baseScope();
    let entries = storedEntries(scope, mode !== 'unfinished');
    if (mode === 'hole') entries = entries.filter((entry, index) => index !== 2);
    if (mode === 'foreign-scope')
      entries = storedEntries(baseScope({ address: { logRunId: 'foreign', drillPath: [] } }));
    const graph = api.createStoredRecordGraph({
      loadLog() {
        if (mode === 'unavailable') throw new Error(PRIVATE_SENTINEL);
        return { entries, reads: scope.reads, attention: scope.attention, controlDeps: scope.controlDeps };
      },
    });
    const id = node(graph, 'end', 3, 'z');
    add(`storage/${mode}`, {
      gaps: await graph.gaps(id, context()),
      open: await settled(() => graph.openScope(address, context())),
    });
  }
  {
    const graph = plainGraph();
    let getterReads = 0;
    const payload = Object.defineProperty({ complete: true }, 'edges', {
      get() {
        getterReads++;
        throw new Error(PRIVATE_SENTINEL);
      },
    });
    graph.parents = () => payload as ReturnType<CauseGraph['parents']>;
    add('graph/adjacency-getter', { result: await api.explain(graph, 'selected'), getterReads });
    const options = new Proxy(
      {},
      {
        getOwnPropertyDescriptor(_target, key) {
          if (key === 'rankRoots') throw new Error('fixture-descriptor-trap');
          return undefined;
        },
      },
    );
    add('graph/descriptor-trap', await settled(() => api.explain(plainGraph(), 'selected', options)));
  }
  {
    const long = 'n'.repeat(2048);
    add('admission/graph-id-2048', await api.explain(plainGraph(), long));
    add('admission/graph-id-2049', await settled(() => api.explain(plainGraph(), long + 'n')));
    for (const count of [1022, 1023]) {
      const stage = 'r'.repeat(count),
        graph = memory({ commitLog: [commit(stage, 0, { value: [] })], reads: {}, attention: {}, controlDeps: {} });
      const id = graph.nodeId(address, { runtimeStageId: stage + '#0', commitIdx: 0, key: 'value' });
      add(`admission/record-runtime-id-${count + 2}`, { id, gaps: await graph.gaps(id, context()) });
    }
    const path = 'parent' + String.fromCharCode(31) + 'child';
    const graph = memory({ commitLog: [commit('seed', 0, { [path]: [] })], reads: { 'seed#0': [] }, attention: {} });
    add('admission/record-path-separator', await graph.gaps(node(graph, 'seed', 0, path), context()));
    add('admission/graph-id-separator', await settled(() => api.explain(plainGraph(), path)));
  }
  {
    const graph = plainGraph();
    graph.attention = () => Array.from({ length: 33 }, () => mark('proof'));
    add('admission/graph-list-overflow', await api.explain(graph, 'selected'));
    graph.attention = () => [mark('selected')];
    graph.parents = () => ({
      complete: true,
      edges: ['one', 'two'].map((nodeId) => ({ nodeId, kind: 'data', attribution: 'per-write', evidence: ['proof'] })),
    });
    add('admission/graph-edge-overflow', await api.explain(graph, 'selected', { maxEdges: 1 }));
    const record = memory({
      commitLog: [
        commit('seed', 0, Object.fromEntries(Array.from({ length: 129 }, (_, index) => ['key' + index, []]))),
      ],
      reads: {},
      attention: {},
    });
    add('admission/record-list-overflow', await record.gaps(node(record, 'seed', 0, 'key0'), context()));
  }
  {
    const graph = plainGraph();
    add('ranking/foreign-root', await api.explain(graph, 'selected', { rankRoots: () => ['foreign'] }));
    add('ranking/missing-score', await api.explain(graph, 'selected', { rankRoots: api.largestDrop(new Map()) }));
    graph.children = (id) => ({
      complete: true,
      edges:
        id === 'selected'
          ? ['one', 'two'].map((nodeId) => ({
              nodeId,
              kind: 'data' as const,
              attribution: 'per-write' as const,
              evidence: ['proof'],
            }))
          : [],
    });
    add(
      'ranking/impact-permutation',
      await api.explain(graph, 'selected', { rankImpact: (nodes) => [...nodes].reverse() }),
    );
    add('ranking/impact-duplicate', await api.explain(graph, 'selected', { rankImpact: () => ['one', 'one'] }));
    add(
      'graph/attention-list-limit',
      await api.attentionList(graph, { nodeIds: ['selected', 'one', 'two'], maxNodes: 2 }),
    );
    add('graph/depth-limit', await api.explain(graph, 'selected', { maxDepth: 0 }));
  }
  {
    const controller = new AbortController();
    controller.abort(new Error(PRIVATE_SENTINEL));
    add('cancellation/before-dispatch', await api.explain(plainGraph(), 'selected', { signal: controller.signal }));
    const during = new AbortController(),
      graph = plainGraph();
    graph.parents = () => {
      during.abort(new Error(PRIVATE_SENTINEL));
      return new Promise(() => {});
    };
    add('cancellation/during-dispatch', await api.explain(graph, 'selected', { signal: during.signal }));
  }
  await monotonic(async (elapse) => {
    const graph = plainGraph();
    graph.parents = () => {
      elapse(2000);
      return { edges: [], complete: true };
    };
    add('timeout/synchronous-port', await api.explain(graph, 'selected'));
  });
  await monotonic(async (elapse) => {
    const scope = baseScope();
    const graph = api.createStoredRecordGraph({
      loadLog() {
        elapse(2000);
        return {
          entries: storedEntries(scope),
          reads: scope.reads,
          attention: scope.attention,
          controlDeps: scope.controlDeps,
        };
      },
    });
    add('timeout/stored-load', await settled(() => graph.openScope(address, context())));
  });
  return cases;
}
