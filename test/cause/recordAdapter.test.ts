import { explain } from '../../src/lib/cause/explain.js';
import { describe, expect, it, vi } from 'vitest';
import { createRecordGraph } from '../../src/lib/cause/recordAdapter.js';
import { createStoredRecordGraph } from '../../src/lib/cause/storedRecordAdapter.js';
import type { CommitBundle } from '../../src/lib/memory/types.js';
const address = { logRunId: 'run', drillPath: [] };
const ctx = () => ({ signal: new AbortController().signal });
function commit(id: string, idx: number, writes: Record<string, string[] | undefined>): CommitBundle {
  return {
    idx,
    stage: id,
    stageId: id,
    runtimeStageId: id + '#' + idx,
    trace: Object.entries(writes).map(([path, readKeys]) => ({
      path,
      verb: 'set' as const,
      ...(readKeys === undefined ? {} : { readKeys }),
    })),
    redactedPaths: [],
    overwrite: Object.fromEntries(Object.keys(writes).map((k) => [k, idx])),
    updates: {},
  };
}
const log = [
  commit('a', 0, { a: [] }),
  commit('b', 1, { b: [] }),
  commit('split', 2, { x: ['a'], y: ['a', 'b'] }),
  commit('end', 3, { z: ['x'] }),
];
const reads = { 'a#0': [], 'b#1': [], 'split#2': ['a', 'b'], 'end#3': ['x'] };
function graph(overrides: Record<string, unknown> = {}) {
  return createRecordGraph([
    { address, commitLog: log, reads, attention: {}, controlDeps: {}, complete: true, ...overrides },
  ]);
}
function id(g: ReturnType<typeof graph>, stage: string, idx: number, key?: string) {
  return g.nodeId(address, { runtimeStageId: stage + '#' + idx, commitIdx: idx, key });
}
function storedEntries(a = address, closed = true) {
  return [
    { kind: 'opened', address: a, at: 0, initialState: {} },
    ...log.map((bundle) => ({ kind: 'commit', address: a, at: 0, bundle })),
    ...(closed ? [{ kind: 'closed', address: a, at: 0, outcome: 'ok', commits: log.length }] : []),
  ];
}
describe('cause record adapter', () => {
  it('keeps per-write contexts separate and expands only immediate dependencies', async () => {
    const g = graph();
    const x = id(g, 'split', 2, 'x'),
      y = id(g, 'split', 2, 'y');
    expect(x).not.toBe(y);
    expect((await g.parents(x, ctx())).edges.map((e) => e.nodeId)).toEqual([id(g, 'a', 0, 'a')]);
    expect((await g.parents(y, ctx())).edges.map((e) => e.nodeId)).toEqual([id(g, 'a', 0, 'a'), id(g, 'b', 1, 'b')]);
    expect((await g.parents(id(g, 'end', 3, 'z'), ctx())).edges.map((e) => e.nodeId)).toEqual([x]);
    expect(await g.gaps(x, ctx())).toEqual([]);
  });
  it('bounds forward impact at the requested historical write, not the latest overwrite', async () => {
    const local = [
      commit('seed', 0, { a: [] }),
      commit('first', 1, { x: ['a'] }),
      commit('rewrite', 2, { a: [] }),
      commit('later', 3, { y: ['a'] }),
    ];
    const g = graph({ commitLog: local, reads: { 'seed#0': [], 'first#1': ['a'], 'rewrite#2': [], 'later#3': ['a'] } });
    expect((await g.children(id(g, 'seed', 0, 'a'), ctx())).edges.map((e) => e.nodeId)).toEqual([
      id(g, 'first', 1, 'x'),
    ]);
  });
  it('honestly flags missing control, reads, provenance, closure inputs and unfinished records', async () => {
    const g = graph({
      controlDeps: undefined,
      reads: undefined,
      complete: false,
      commitLog: [{ ...commit('raw', 0, { x: undefined }), untrackedSources: ['args'] }],
    });
    const gaps = await g.gaps(id(g, 'raw', 0, 'x'), ctx());
    expect(gaps.map((g) => g.code)).toEqual(
      expect.arrayContaining(['not-collected', 'conservative', 'untracked-input']),
    );
    const exact = graph({ reads: undefined });
    expect(await exact.gaps(id(exact, 'a', 0, 'a'), ctx())).toEqual([]);
  });
  it('includes recorded control edges without inventing containment causation', async () => {
    const g = graph({ controlDeps: { 'end#3': { deciderId: 'b#1' } } });
    const edges = (await g.parents(id(g, 'end', 3, 'z'), ctx())).edges;
    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: id(g, 'b', 1), kind: 'control', attribution: 'recorded-control' }),
      ]),
    );
    const other = { logRunId: 'run', drillPath: ['mount#4'] };
    const scoped = createRecordGraph([
      { address, commitLog: log, reads, attention: {}, controlDeps: {}, complete: true },
      { address: other, commitLog: [commit('inner', 5, { k: [] })], attention: {}, controlDeps: {}, complete: true },
    ]);
    const inner = scoped.nodeId(other, { runtimeStageId: 'inner#5', commitIdx: 0, key: 'k' });
    expect((await scoped.parents(inner, ctx())).edges).toEqual([]);
    expect(await scoped.openScope(other, ctx())).toHaveLength(1);
  });
  it('never invokes stored accessors or emits payloads/errors/attention text', async () => {
    const get = vi.fn(() => {
      throw new Error('SECRET');
    });
    const bad = Object.defineProperty({}, 'x', { get, enumerable: true });
    const g = graph({ commitLog: [{ ...commit('bad', 0, { x: [] }), overwrite: bad }] });
    const gaps = await g.gaps(id(g, 'bad', 0, 'x'), ctx());
    expect(gaps.map((x) => x.code)).toContain('invalid-data');
    expect(get).not.toHaveBeenCalled();
    expect(JSON.stringify(gaps)).not.toContain('SECRET');
    const marks = graph({ attention: { 'end#3': [{ kind: 'error', reason: 'SECRET', evidence: ['proof'] }] } });
    expect(await marks.attention(id(marks, 'end', 3, 'z'), ctx())).toEqual([]);
    expect(JSON.stringify(await marks.gaps(id(marks, 'end', 3, 'z'), ctx()))).not.toContain('SECRET');
  });
  it('refuses oversized preparation and invalid node identities with fixed gaps', async () => {
    const g = createRecordGraph([{ address, commitLog: log, reads, attention: {}, controlDeps: {}, complete: true }], {
      maxCommits: 2,
    });
    expect((await g.gaps(id(g, 'end', 3, 'z'), ctx())).map((g) => g.code)).toContain('node-limit');
    expect((await g.gaps('SECRET malformed', ctx())).map((g) => g.code)).toEqual(['invalid-data']);
  });
});
describe('cause stored adapter', () => {
  it('loads exactly the requested mounted scope lazily and validates its stored close', async () => {
    const child = { logRunId: 'run', drillPath: ['mount#7'] };
    const loadLog = vi.fn(async (a: typeof address) => ({
      entries: storedEntries(a),
      reads,
      attention: {},
      controlDeps: {},
    }));
    const g = createStoredRecordGraph({ loadLog });
    expect(loadLog).not.toHaveBeenCalled();
    const node = g.nodeId(child, { runtimeStageId: 'end#3', commitIdx: 3, key: 'z' });
    await g.parents(node, ctx());
    await g.parents(node, ctx());
    expect(loadLog).toHaveBeenCalledTimes(1);
    expect(loadLog.mock.calls[0][0]).toEqual(child);
    expect(await g.gaps(node, ctx())).toEqual([]);
    const unfinished = createStoredRecordGraph({
      loadLog: async () => ({ entries: storedEntries(address, false), reads, attention: {}, controlDeps: {} }),
    });
    expect(
      (
        await unfinished.gaps(unfinished.nodeId(address, { runtimeStageId: 'end#3', commitIdx: 3, key: 'z' }), ctx())
      ).map((g) => g.code),
    ).toContain('not-collected');
  });
  it('bounds direct openScope waits and forwards cancellation without leaking loader failures', async () => {
    let seen: AbortSignal | undefined;
    const g = createStoredRecordGraph(
      {
        loadLog: (_a, c) => {
          seen = c.signal;
          return new Promise(() => {});
        },
      },
      { loadTimeoutMs: 5 },
    );
    await expect(g.openScope(address, ctx())).rejects.toMatchObject({ code: 'timeout' });
    expect(seen?.aborted).toBe(true);
    const n = g.nodeId(address, { runtimeStageId: 'end#3', commitIdx: 3, key: 'z' });
    expect((await g.gaps(n, ctx())).map((g) => g.code)).toContain('timeout');
    const failed = createStoredRecordGraph({
      loadLog: async () => {
        throw new Error('SECRET');
      },
    });
    const f = failed.nodeId(address, { runtimeStageId: 'end#3', commitIdx: 3, key: 'z' });
    expect(await failed.gaps(f, ctx())).toEqual([{ code: 'unavailable', evidence: [] }]);
    expect(JSON.stringify(await failed.gaps(f, ctx()))).not.toContain('SECRET');
  });
  it('rejects a loader returning another scope and cancels an externally aborted load', async () => {
    const other = { logRunId: 'other', drillPath: [] };
    const g = createStoredRecordGraph({
      loadLog: async () => ({ entries: storedEntries(other), reads, attention: {}, controlDeps: {} }),
    });
    const n = g.nodeId(address, { runtimeStageId: 'end#3', commitIdx: 3, key: 'z' });
    expect((await g.gaps(n, ctx())).map((g) => g.code)).toContain('invalid-data');
    const abort = new AbortController();
    const cancellable = createStoredRecordGraph({
      loadLog: (_a, c) => new Promise((resolve) => c.signal.addEventListener('abort', () => resolve({ entries: [] }))),
    });
    const work = cancellable.openScope(address, { signal: abort.signal });
    abort.abort();
    await expect(work).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('record adapter boundary regressions', () => {
  it('does not assimilate then accessors on synchronous host payloads', async () => {
    const get = vi.fn(() => {
      throw new Error('SECRET');
    });
    const payload = { entries: storedEntries(), reads, attention: {}, controlDeps: {} };
    Object.defineProperty(payload, 'then', { get });
    const g = createStoredRecordGraph({ loadLog: () => payload });
    const n = g.nodeId(address, { runtimeStageId: 'end#3', commitIdx: 3, key: 'z' });
    expect((await g.parents(n, ctx())).edges).toHaveLength(1);
    expect(get).not.toHaveBeenCalled();
  });
  it('does not create control impact from an unrelated written value in a decider', async () => {
    const g = graph({ controlDeps: { 'end#3': { deciderId: 'split#2' } } });
    expect((await g.children(id(g, 'split', 2, 'x'), ctx())).edges.every((e) => e.kind === 'data')).toBe(true);
  });
  it('preserves key-qualified diamond contexts on separate dependency branches', async () => {
    const local = [
      ...log.slice(0, 3),
      commit('left', 3, { p: ['x'] }),
      commit('right', 4, { q: ['y'] }),
      commit('join', 5, { z: ['p', 'q'] }),
    ];
    const g = graph({ commitLog: local, reads: { ...reads, 'left#3': ['x'], 'right#4': ['y'], 'join#5': ['p', 'q'] } });
    const both = (await g.parents(id(g, 'join', 5, 'z'), ctx())).edges;
    expect(both).toHaveLength(2);
    const left = (await g.parents(both[0].nodeId, ctx())).edges[0].nodeId;
    const right = (await g.parents(both[1].nodeId, ctx())).edges[0].nodeId;
    expect(left).not.toBe(right);
    expect((await g.parents(left, ctx())).edges.map((e) => e.nodeId)).not.toContain(id(g, 'b', 1, 'b'));
    expect((await g.parents(right, ctx())).edges.map((e) => e.nodeId)).toContain(id(g, 'b', 1, 'b'));
  });
  it('never invokes accessor entries in array fields', async () => {
    const get = vi.fn(() => {
      throw new Error('SECRET');
    });
    const trace: unknown[] = [];
    Object.defineProperty(trace, '0', { get, enumerable: true, configurable: true });
    const g = graph({ commitLog: [{ ...commit('bad', 0, { x: [] }), trace }] });
    expect((await g.gaps(id(g, 'bad', 0, 'x'), ctx())).map((g) => g.code)).toContain('invalid-data');
    expect(get).not.toHaveBeenCalled();
  });
});

describe('direct discovery and configuration boundaries', () => {
  it('rejects direct discovery with a fixed visible gap instead of an empty-looking success', async () => {
    const g = createStoredRecordGraph({
      loadLog: async () => {
        throw new Error('SECRET');
      },
    });
    await expect(g.openScope(address, ctx())).rejects.toMatchObject({
      code: 'unavailable',
      message: 'cause: record unavailable',
    });
  });
  it('never invokes option accessors and refuses them with fixed configuration text', () => {
    const get = vi.fn(() => {
      throw new Error('SECRET');
    });
    const options = Object.defineProperty({}, 'maxCommits', { get, enumerable: true });
    expect(() => createRecordGraph([], options)).toThrow('cause: invalid record configuration');
    expect(get).not.toHaveBeenCalled();
  });
  it('spends one preparation budget on metadata as well as state payloads', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => ['unused#' + i, Array.from({ length: 10 }, (_, k) => 'key' + k)]),
    );
    const g = createRecordGraph(
      [
        {
          address,
          commitLog: [commit('a', 0, { a: [] })],
          reads: many,
          attention: {},
          controlDeps: {},
          complete: true,
        },
      ],
      { maxCommits: 16, maxFields: 40 },
    );
    expect((await g.gaps(id(g, 'a', 0, 'a'), ctx())).map((g) => g.code)).toContain('node-limit');
  });
});

describe('bounded concurrent storage and impact coverage', () => {
  it('caps unresolved loads even when callers time out', async () => {
    const loadLog = vi.fn(() => new Promise<never>(() => {}));
    const g = createStoredRecordGraph({ loadLog }, { maxScopes: 1, loadTimeoutMs: 5 });
    await expect(g.openScope(address, ctx())).rejects.toMatchObject({ code: 'timeout' });
    await expect(g.openScope(address, ctx())).rejects.toMatchObject({ code: 'node-limit' });
    expect(loadLog).toHaveBeenCalledTimes(1);
  });
  it('does not claim complete impact when downstream read capture is missing', async () => {
    const g = graph({
      reads: undefined,
      commitLog: [commit('seed', 0, { a: [] }), commit('blind', 1, { b: undefined })],
    });
    expect((await g.children(id(g, 'seed', 0, 'a'), ctx())).complete).toBe(false);
  });
  it('does not follow a fabricated future control parent', async () => {
    const g = graph({ controlDeps: { 'a#0': { deciderId: 'end#3' } } });
    const n = id(g, 'a', 0, 'a');
    expect((await g.parents(n, ctx())).edges).toEqual([]);
    expect((await g.gaps(n, ctx())).map((g) => g.code)).toContain('invalid-data');
  });
  it('bounds sparse payload arrays by their length before replay work', async () => {
    const huge: unknown[] = [];
    huge.length = 1000000000;
    const g = graph({ commitLog: [{ ...commit('a', 0, { a: [] }), overwrite: { a: huge } }] });
    expect((await g.gaps(id(g, 'a', 0, 'a'), ctx())).map((g) => g.code)).toContain('node-limit');
  });
});

describe('adapter review regressions', () => {
  it('reports canonical immediate-child truncation in direct and full impact queries', async () => {
    const local = [commit('seed', 0, { x: [] }), commit('left', 1, { a: ['x'] }), commit('right', 2, { b: ['x'] })];
    const g = createRecordGraph(
      [
        {
          address,
          commitLog: local,
          reads: { 'seed#0': [], 'left#1': ['x'], 'right#2': ['x'] },
          attention: {},
          controlDeps: {},
          complete: true,
        },
      ],
      { maxEdges: 1 },
    );
    const n = id(g, 'seed', 0, 'x');
    expect((await g.children(n, ctx())).complete).toBe(false);
    expect((await g.gaps(n, ctx())).map((g) => g.code)).toContain('edge-limit');
    const result = await explain(g, n);
    expect(result.impact.confidence).toBe('incomplete');
    expect(result.impact.gaps.map((g) => g.code)).toContain('edge-limit');
  });
  it('refuses an actual stored commit hole as not-collected rather than malformed data', async () => {
    const entries = [
      { kind: 'opened', address, at: 0, initialState: {} },
      { kind: 'commit', address, at: 1, bundle: commit('a', 0, { a: [] }) },
      { kind: 'commit', address, at: 2, bundle: commit('b', 2, { b: [] }) },
      { kind: 'closed', address, at: 3, outcome: 'ok', commits: 3 },
    ];
    const g = createStoredRecordGraph({ loadLog: () => ({ entries, reads: {}, attention: {}, controlDeps: {} }) });
    const n = g.nodeId(address, { runtimeStageId: 'a#0', commitIdx: 0, key: 'a' });
    expect(await g.gaps(n, ctx())).toEqual([{ code: 'not-collected', evidence: [] }]);
  });
});

describe('remaining untrusted-host review cases', () => {
  it('charges redaction metadata against the shared preparation budget', async () => {
    const g = graph({
      commitLog: [{ ...commit('a', 0, { a: [] }), redactedPaths: Array.from({ length: 100 }, (_, i) => 'hidden' + i) }],
    });
    const bounded = createRecordGraph(
      [
        {
          address,
          commitLog: [
            { ...commit('a', 0, { a: [] }), redactedPaths: Array.from({ length: 100 }, (_, i) => 'hidden' + i) },
          ],
          attention: {},
          controlDeps: {},
          complete: true,
        },
      ],
      { maxFields: 8 },
    );
    expect((await bounded.gaps(id(g, 'a', 0, 'a'), ctx())).map((g) => g.code)).toContain('node-limit');
  });
  it('does not invoke a constructor accessor on a host promise', async () => {
    const get = vi.fn(() => {
      throw new Error('SECRET');
    });
    const promise = Promise.resolve({ entries: storedEntries(), reads, attention: {}, controlDeps: {} });
    Object.defineProperty(promise, 'constructor', { get });
    const g = createStoredRecordGraph({ loadLog: () => promise });
    const n = g.nodeId(address, { runtimeStageId: 'end#3', commitIdx: 3, key: 'z' });
    expect((await g.gaps(n, ctx())).map((g) => g.code)).toContain('invalid-data');
    expect(get).not.toHaveBeenCalled();
  });
  it('refuses a synchronous loader result that arrived past its monotonic timeout', async () => {
    const g = createStoredRecordGraph(
      {
        loadLog: () => {
          const end = performance.now() + 8;
          while (performance.now() < end) {
            /* simulate a blocked host */
          }
          return { entries: storedEntries(), reads, attention: {}, controlDeps: {} };
        },
      },
      { loadTimeoutMs: 1 },
    );
    await expect(g.openScope(address, ctx())).rejects.toMatchObject({ code: 'timeout' });
  });
  it('does not confuse intentional one-hop depth with lost immediate children', async () => {
    const local = [commit('seed', 0, { x: [] }), commit('mid', 1, { a: ['x'] }), commit('end', 2, { b: ['a'] })];
    const g = createRecordGraph([{ address, commitLog: local, attention: {}, controlDeps: {}, complete: true }], {
      maxEdges: 1,
    });
    const n = id(g, 'seed', 0, 'x');
    expect((await g.children(n, ctx())).complete).toBe(true);
    expect(await g.gaps(n, ctx())).toEqual([]);
  });
});

describe('coverage and metadata admission review regressions', () => {
  it('distinguishes missing attention capture from an explicit empty map in memory and storage', async () => {
    const missing = graph({ attention: undefined }),
      empty = graph({ attention: {} });
    expect((await missing.gaps(id(missing, 'a', 0, 'a'), ctx())).map((g) => g.code)).toContain('not-collected');
    expect(await empty.gaps(id(empty, 'a', 0, 'a'), ctx())).toEqual([]);
    const stored = createStoredRecordGraph({ loadLog: () => ({ entries: storedEntries(), reads, controlDeps: {} }) });
    expect(
      (await stored.gaps(stored.nodeId(address, { runtimeStageId: 'a#0', commitIdx: 0, key: 'a' }), ctx())).map(
        (g) => g.code,
      ),
    ).toContain('not-collected');
  });
  it('uses captured per-write reads even when the supplied read map omits them', async () => {
    const local = [commit('seed', 0, { a: [] }), commit('child', 1, { b: ['a'] })];
    const g = createRecordGraph([
      {
        address,
        commitLog: local,
        attention: {},
        controlDeps: {},
        reads: { 'seed#0': [], 'child#1': [] },
        complete: true,
      },
    ]);
    const seed = id(g, 'seed', 0, 'a'),
      child = id(g, 'child', 1, 'b');
    expect((await g.parents(child, ctx())).edges.map((e) => e.nodeId)).toContain(seed);
    expect((await g.children(seed, ctx())).edges.map((e) => e.nodeId)).toContain(child);
  });
  it('bounds payload property names before retaining ordinary and array properties', async () => {
    for (const a of [false, true]) {
      const data = a ? [] : {};
      Object.defineProperty(data, 'k'.repeat(65537), { value: 1, enumerable: true });
      const g = graph({ commitLog: [{ ...commit('a', 0, { a: [] }), overwrite: { a: data } }] });
      expect((await g.gaps(id(g, 'a', 0, 'a'), ctx())).map((g) => g.code)).toContain('node-limit');
    }
  });
  it('refuses control characters in diagnostic identities while preserving canonical nested paths', async () => {
    const bad = graph({ commitLog: [commit('bad\u0001', 0, { a: [] })] });
    expect(
      (await bad.gaps(bad.nodeId(address, { runtimeStageId: 'bad\u0001#0', commitIdx: 0, key: 'a' }), ctx())).map(
        (g) => g.code,
      ),
    ).toContain('invalid-data');
    const key = ['cfg', 'x'].join(String.fromCharCode(31));
    const nested = graph({ commitLog: [commit('a', 0, { [key]: [] })] });
    expect(await nested.gaps(nested.nodeId(address, { runtimeStageId: 'a#0', commitIdx: 0, key }), ctx())).toEqual([]);
  });
});

describe('empty record discovery coverage', () => {
  it('rejects unfinished empty scopes and accepts an explicitly complete empty log', async () => {
    const context = ctx();
    const memory = createRecordGraph([{ address, commitLog: [], attention: {}, controlDeps: {}, complete: false }]);
    await expect(memory.openScope(address, context)).rejects.toMatchObject({ code: 'not-collected' });
    const entries = [{ kind: 'opened', address, at: 0, initialState: {} }];
    const unfinished = createStoredRecordGraph({ loadLog: () => ({ entries, attention: {}, controlDeps: {} }) });
    await expect(unfinished.openScope(address, ctx())).rejects.toMatchObject({ code: 'not-collected' });
    const closed = createStoredRecordGraph({
      loadLog: () => ({
        entries: [...entries, { kind: 'closed', address, at: 1, outcome: 'ok', commits: 0 }],
        attention: {},
        controlDeps: {},
      }),
    });
    expect(await closed.openScope(address, ctx())).toEqual([]);
  });
});

describe('readonly consumer control dependencies', () => {
  function readonlyGraph(
    controlDeps: Record<string, { deciderId: string }> | undefined = { 'reader#2': { deciderId: 'decide#1' } },
    maxEdges?: number,
  ) {
    return createRecordGraph(
      [
        {
          address,
          commitLog: [commit('seed', 0, { a: [] }), commit('decide', 1, {}), commit('reader', 2, {})],
          reads: { 'seed#0': [], 'decide#1': [], 'reader#2': ['a'] },
          attention: {
            'seed#0': [{ kind: 'error', reason: 'ERROR_RECORDED', evidence: ['proof:seed'] }],
            'decide#1': [{ kind: 'timeout', reason: 'TIMEOUT_RECORDED', evidence: ['proof:decision'] }],
          },
          controlDeps,
          complete: true,
        },
      ],
      { ...(maxEdges === undefined ? {} : { maxEdges }) },
    );
  }
  it('preserves BOTH the qualified value writer and the governing decision', async () => {
    const g = readonlyGraph(),
      seed = id(g, 'seed', 0, 'a'),
      decide = id(g, 'decide', 1);
    const reader = (await g.children(seed, ctx())).edges[0].nodeId;
    const parents = await g.parents(reader, ctx());
    expect(parents.complete).toBe(true);
    expect(parents.edges).toEqual([
      expect.objectContaining({ nodeId: seed, kind: 'data' }),
      expect.objectContaining({ nodeId: decide, kind: 'control', attribution: 'recorded-control' }),
    ]);
    const result = await explain(g, reader);
    expect(result.confidence).toBe('complete');
    expect(result.rootCause).toBeUndefined();
    expect(result.alternatives).toEqual(expect.arrayContaining([seed, decide]));
    expect(result.alternatives).toHaveLength(2);
  });
  it('keeps readonly control omission, invalid ordering and adjacency cuts explicit', async () => {
    for (const [control, expected] of [
      [undefined, 'not-collected'],
      [{ 'reader#2': { deciderId: 'reader#2' } }, 'invalid-data'],
      [{ 'reader#2': { deciderId: 'outside#9' } }, 'scope-boundary'],
    ] as const) {
      const g = readonlyGraph(control as Record<string, { deciderId: string }> | undefined);
      // An explicit override is needed because a default parameter treats undefined as the normal fixture.
      const fixture =
        control === undefined
          ? createRecordGraph([
              {
                address,
                commitLog: [commit('seed', 0, { a: [] }), commit('reader', 1, {})],
                reads: { 'seed#0': [], 'reader#1': ['a'] },
                attention: {},
                complete: true,
              },
            ])
          : g;
      const seed = id(fixture, 'seed', 0, 'a'),
        reader = (await fixture.children(seed, ctx())).edges[0].nodeId;
      expect((await fixture.gaps(reader, ctx())).map((gap) => gap.code)).toContain(expected);
      expect((await fixture.parents(reader, ctx())).complete).toBe(false);
    }
    const capped = readonlyGraph({ 'reader#2': { deciderId: 'decide#1' } }, 1);
    const reader = (await capped.children(id(capped, 'seed', 0, 'a'), ctx())).edges[0].nodeId;
    expect((await capped.parents(reader, ctx())).complete).toBe(false);
    expect((await capped.gaps(reader, ctx())).map((gap) => gap.code)).toContain('edge-limit');
  });
  it('follows recorded control impact THROUGH a readonly decider without widening written-key contexts', async () => {
    const g = createRecordGraph([
      {
        address,
        commitLog: [commit('seed', 0, { a: [] }), commit('decide', 1, {}), commit('sink', 2, {})],
        reads: { 'seed#0': [], 'decide#1': ['a'], 'sink#2': [] },
        attention: {},
        controlDeps: { 'sink#2': { deciderId: 'decide#1' } },
        complete: true,
      },
    ]);
    const seed = id(g, 'seed', 0, 'a'),
      sink = id(g, 'sink', 2);
    const decider = (await g.children(seed, ctx())).edges[0].nodeId;
    expect((await g.children(decider, ctx())).edges).toEqual([
      expect.objectContaining({ nodeId: sink, kind: 'control', attribution: 'recorded-control' }),
    ]);
    const result = await explain(g, seed);
    expect(result.impact.confidence).toBe('complete');
    expect(result.impact.nodes).toContain(sink);
  });
});

describe('forged readonly identities', () => {
  function fixture() {
    return createRecordGraph([
      {
        address,
        commitLog: [commit('seed', 0, { secretKey: [] }), commit('reader', 1, {}), commit('sink', 2, {})],
        reads: { 'seed#0': [], 'reader#1': [], 'sink#2': [] },
        attention: {},
        controlDeps: { 'sink#2': { deciderId: 'reader#1' } },
        complete: true,
      },
    ]);
  }
  it('refuses a named read that captured evidence proves never happened, including control fanout', async () => {
    const g = fixture();
    const forged =
      'record:' + JSON.stringify({ address, runtimeStageId: 'reader#1', commitIdx: 1, key: 'secretKey', read: true });
    expect(await g.parents(forged, ctx())).toEqual({ edges: [], complete: false });
    expect(await g.children(forged, ctx())).toEqual({ edges: [], complete: false });
    expect(await g.gaps(forged, ctx())).toEqual([{ code: 'invalid-data', evidence: [] }]);
  });
  it('refuses a read identity with no qualified key before loading its scope', async () => {
    const loadLog = vi.fn(() => ({ entries: [], attention: {}, controlDeps: {} }));
    const g = createStoredRecordGraph({ loadLog });
    const forged = 'record:' + JSON.stringify({ address, runtimeStageId: 'reader#1', commitIdx: 1, read: true });
    expect(await g.parents(forged, ctx())).toEqual({ edges: [], complete: false });
    expect(await g.children(forged, ctx())).toEqual({ edges: [], complete: false });
    expect(await g.gaps(forged, ctx())).toEqual([{ code: 'invalid-data', evidence: [] }]);
    expect(loadLog).not.toHaveBeenCalled();
  });
});
